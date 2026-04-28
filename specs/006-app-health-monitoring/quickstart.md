# Quickstart: Application Health Monitoring & Post-Deploy Verification

**Date**: 2026-04-28

Operator-facing tutorial. Five scenarios — each shows the UI affordance, the API call (for direct integration), and the resulting DB state. Written for someone who just upgraded the dashboard and wants to verify the feature works end-to-end.

---

## Scenario 1 — Add a Health Check URL to an existing app, watch the dot turn green

You have an app `ai-digital-twins` deployed on `srv-prod-01`. It has a docker-compose healthcheck defined. You want a green dot in the Apps list and a tooltip showing the last probe time.

### UI

1. Navigate to the **Server** page → **Apps** tab.
2. Click the row for `ai-digital-twins` → **Edit**.
3. New section **Health Monitoring**:
   - **Health Check URL** (optional): `https://ai-twins.example.com/health`
   - **Monitoring Enabled**: ON (default for new apps + after migration)
   - **Probe Interval (seconds)**: 60 (default)
   - **Debounce Count**: 2 (default)
   - **Alerts Muted**: OFF (default)
4. Click **Save**.

### API equivalent

```bash
curl -X PATCH https://dashboard.example.com/api/apps/app-123 \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"healthUrl":"https://ai-twins.example.com/health"}'
```

### What happens

- Server-side: `applications.health_url` UPDATE; `appHealthPoller.reloadApp("app-123")` fires.
- Within 60s the first probe cycle runs — container probe (via `docker inspect` over SSH) + HTTP probe (Node `fetch` of the configured URL).
- First probe with `outcome: healthy` writes a row to `app_health_probes` and updates `applications.health_checked_at`. `health_status` stays `unknown` until the debounce-2 condition is met (2 consecutive healthy probes).
- After tick #2 (~120s after Save): `health_status = 'healthy'`, `health_last_change_at` set. WS event `health-changed` published on `app-health:app-123`. UI dot turns green.

### DB state

```sql
-- Right after Save:
SELECT health_url, health_status, health_checked_at FROM applications WHERE id = 'app-123';
-- ('https://ai-twins.example.com/health', 'unknown', null)

-- After 1 probe cycle (~60s later):
SELECT health_url, health_status, health_checked_at FROM applications WHERE id = 'app-123';
-- ('https://ai-twins.example.com/health', 'unknown', '2026-04-28T12:35:00Z')

-- After 2 consecutive healthy probes (~120s later):
SELECT health_url, health_status, health_checked_at, health_last_change_at FROM applications WHERE id = 'app-123';
-- ('https://ai-twins.example.com/health', 'healthy', '2026-04-28T12:36:00Z', '2026-04-28T12:36:00Z')

-- The probe history:
SELECT probed_at, probe_type, outcome FROM app_health_probes
  WHERE app_id = 'app-123' ORDER BY probed_at DESC LIMIT 4;
-- ('2026-04-28T12:36:00Z', 'http', 'healthy')
-- ('2026-04-28T12:36:00Z', 'container', 'healthy')
-- ('2026-04-28T12:35:00Z', 'http', 'healthy')
-- ('2026-04-28T12:35:00Z', 'container', 'healthy')
```

The `unknown → healthy` transition is silent (FR-008) — no Telegram fires. This is intentional: at rollout, every app is `unknown` and converges to `healthy`; you do not want N Telegrams at once.

---

## Scenario 2 — Receive a Telegram alert when the app goes unhealthy

The app from Scenario 1 is healthy and stable. Someone pushes a broken commit to `main`. The container restarts and the healthcheck fails.

### Timeline

- `t=0` — broken commit deployed via the dashboard. Deploy completes (no `waitForHealthy: true` on the manifest entry yet — see Scenario 3 to add it).
- `t=10s` — container's own healthcheck (`docker compose` healthcheck stanza) starts failing. `docker inspect ... .State.Health.Status` returns `"unhealthy"`.
- `t=60s` — first probe cycle after the deploy lock released. Container probe records `outcome: unhealthy`. `consecutive.unhealthy = 1`. Below debounce threshold of 2 — no transition yet. `applications.health_status` stays `healthy`.
- `t=120s` — second probe cycle. Container probe records `outcome: unhealthy` again. `consecutive.unhealthy = 2`. Debounce satisfied. Transition committed: `health_status = 'unhealthy'`, `health_last_change_at = now`. Telegram fires.

### Telegram message

```
❌ App unhealthy
Server: srv-prod-01
ai-digital-twins
Reason: container reports unhealthy
[Open](https://dashboard.example.com/apps/app-123)
```

### Recovery flow

- `t=180s` — operator pushes a fix. New deploy. Probe pause (FR-011) for the duration of the deploy.
- `t=240s` — deploy completes. Container healthcheck transitions to `healthy`.
- `t=300s` — first probe after deploy. `consecutive.healthy = 1`. Below debounce — no transition.
- `t=360s` — second probe. `consecutive.healthy = 2`. Transition committed: `health_status = 'healthy'`. Recovery alert fires.

### Recovery Telegram

```
✅ App healthy again
Server: srv-prod-01
ai-digital-twins
Downtime: 4m 0s
```

`Downtime` is the diff between `health_last_change_at` (snapshotted just before the recovery write) and `now`.

### Mute during planned maintenance

If you know a deploy will cause unhealthy probes, set `alertsMuted: true` first:

```bash
curl -X PATCH https://dashboard.example.com/api/applications/app-123/health/config \
  -d '{"alertsMuted":true}'
```

Probes still run, state still updates, WS still fires — only Telegram is skipped. Unmute after the planned work; the next genuine transition fires alerts again.

---

## Scenario 3 — Add `waitForHealthy: true` to a manifest entry, watch the deploy block until healthy

You don't want to discover broken deploys 60s after the dashboard says "Deployed!". Opt the deploy entry into the wait gate.

### Manifest change

Edit `devops-app/server/scripts-manifest.ts`:

```ts
{
  id: "deploy/server-deploy",
  category: "deploy",
  description: "Deploy an application",
  locus: "target",
  requiresLock: true,
  timeout: 1_800_000,
  waitForHealthy: true,                          // ← NEW
  healthyTimeoutMs: 180_000,                     // ← NEW (default — written for clarity)
  params: z.object({ /* ... unchanged ... */ }),
}
```

Commit the change, redeploy the dashboard. Manifest validation runs at startup and confirms the new fields.

### Trigger a deploy

UI: navigate to the app, click **Deploy**, pick branch, click **Deploy now**.

API:

```bash
curl -X POST https://dashboard.example.com/api/apps/app-123/deploy -d '{"branch":"main"}'
```

### What happens server-side

- Runner builds the transported script: `[common.sh-overrides, common.sh, server-deploy.sh, wait-for-healthy-tail]` joined with newlines.
- `wait-for-healthy-tail` is the bash loop generated by `buildHealthCheckTail({ container: "ai-digital-twins-app-1", timeoutMs: 180000 })`.
- The runner pipes this buffer to `bash -s` over SSH (feature 005's transport, unchanged).
- Target script runs `docker compose up -d` — exits 0.
- Tail runs:
  - First checks `docker inspect --format '{{if .State.Health}}1{{else}}0{{end}}'`. If `0` (no healthcheck defined), prints `[wait-for-healthy] container has no healthcheck; skipping` and exits 0. Deploy succeeds.
  - If `1`, polls `docker inspect --format '{{.State.Health.Status}}'` every 5s.
  - On `healthy`: prints `[wait-for-healthy] container healthy`, exits 0. Deploy succeeds.
  - On `unhealthy`: prints `[wait-for-healthy] healthcheck failed`, exits 1. Deploy fails — `script_runs.status = 'failed'`, `deployments.status = 'failed'`, Telegram "Deploy Failed!" with the reason.
  - On 180s elapsed: prints `[wait-for-healthy] timeout waiting for healthy`, exits 124. Deploy fails — `script_runs.status = 'timeout'`, `deployments.status = 'failed'`, Telegram with the timeout reason.

### Verifying the gate

```bash
# Check the run record
curl https://dashboard.example.com/api/runs/<run-id>
```

```jsonc
{
  "id": "run-789",
  "scriptId": "deploy/server-deploy",
  "status": "failed",                                         // or "timeout" on timeout
  "errorMessage": "healthcheck reported unhealthy during startup",
  "exitCode": 1,                                              // or 124 on timeout
  "logFilePath": "/app/data/logs/job-789.log"
  // ... other feature 005 fields ...
}
```

The log file's last lines show the bash tail's output — `[wait-for-healthy] healthcheck failed` is the smoking gun.

---

## Scenario 4 — Cert-expiry alert flow

The app from Scenario 1 has a domain `app.example.com` configured (per feature 008). Caddy auto-issued a cert ~80 days ago; renewal is stuck for some reason.

### Daily probe

`appHealthPoller` runs the daily cert sweep at `setInterval(86400000)`. For each app with non-NULL `domain`, it opens a TLS connection to `<domain>:443`, parses `peerCertificate.valid_to`, and computes `daysLeft`.

### Window crossings

| daysLeft | Probe outcome | Action |
|----------|---------------|--------|
| 30       | `healthy`     | UPDATE `app_certs.expires_at`. No alert (window 14d not yet crossed). |
| 14       | `warning`     | First time the ≤14d window is crossed for this cert lifecycle. INSERT `app_cert_events (event_type='expiry_alert', event_data={window_days: 14, days_left: 14})`. Telegram fires. |
| 13       | `warning`     | Lookup `app_cert_events` — row already exists for `(cert_id, window_days=14)` since `lifecycle_start`. NO alert. |
| 7        | `unhealthy`   | First time ≤7d window crossed. INSERT new row. Telegram fires. |
| 6        | `unhealthy`   | Already alerted for window 7. NO alert. |
| 3        | `unhealthy`   | First time ≤3d window crossed. INSERT new row. Telegram fires. |
| 1        | `unhealthy`   | First time ≤1d window crossed. INSERT new row. Telegram fires. |
| 0 (renewed) | `healthy` (jumps to 89 daysLeft) | UPDATE `expires_at`. INSERT `app_cert_events (event_type='renewed', occurred_at=now)`. Lifecycle resets. NO recovery alert (silent per FR-015a). |
| Next cycle 14d | `warning` | New `lifecycle_start` (the renewal). No row for `(cert_id, 14)` since renewal — alert fires. |

### Telegram messages

Window 14d:
```
🔒 Cert expiring
App: ai-digital-twins
Domain: app.example.com
Expires: 2026-05-12T00:00:00Z (14 days)
Last renew: 2026-02-12T00:00:00Z
Status: active
```

Other windows: same shape, different `days_left`.

### Caddy auto-renewal happy path

If Caddy auto-renews ~30d before expiry (the default), `expires_at` jumps from ~30 days to ~90 days. The probe sees the new value next day. No window was crossed during the renewal — no alert fires. `app_cert_events` records the `renewed` event for the dedupe lifecycle reset.

If Caddy is unreachable during renewal (Caddy admin probe is firing the `caddy-unreachable` alert separately), see Scenario 5.

---

## Scenario 5 — Caddy unreachable scenario

Caddy admin API on `127.0.0.1:2019` becomes unreachable on `srv-prod-01`. Maybe the Caddy container crashed, maybe the SSH tunnel is broken, maybe somebody firewalled port 2019.

### Probe detection

The `caddy_admin` probe runs every 60s per server with at least one app having a non-NULL `domain`. Probe transport: open SSH tunnel to remote `127.0.0.1:2019`, fetch `http://localhost:<localPort>/config/`.

| Tick | Outcome | Counter | Status committed |
|------|---------|---------|------------------|
| 1    | unhealthy (ECONNREFUSED) | unhealthy=1 | healthy (below debounce) |
| 2    | unhealthy | unhealthy=2 | unhealthy (commit, FR-007) |

Transition commit fires:

- WS event `server.caddy-unreachable` published.
- Telegram (FR-015b):

```
🟠 Caddy unreachable
Server: srv-prod-01
Last successful: 2m ago
Reverse-proxy reconciliation paused — cert renewals and domain changes will be queued.
```

### Reconciliation pause (cross-feature with 008)

When `caddy_admin` is `unhealthy`, feature 008's reconciler must mark affected `app_certs` rows `pending_reconcile` (per spec 008 FR-009 — bidirectional contract). The dashboard's UI surfaces a banner on each app with a domain on this server: "Reconciliation paused — Caddy unreachable".

### Recovery

When Caddy comes back:

| Tick | Outcome | Counter | Status committed |
|------|---------|---------|------------------|
| N+1  | healthy | healthy=1 | unhealthy (below debounce) |
| N+2  | healthy | healthy=2 | healthy (commit) |

Recovery message:

```
✅ Caddy reachable again
Server: srv-prod-01
Downtime: 12m
Reconciliation will resume on next cycle.
```

### Verifying

```bash
# Caddy probe history
curl https://dashboard.example.com/api/applications/<any-app-on-server>/health/history?probeType=caddy_admin
# OR query directly:
psql -c "SELECT probed_at, outcome, latency_ms, status_code, error_message
         FROM app_health_probes
         WHERE server_id = 'srv-prod-01' AND probe_type = 'caddy_admin'
         ORDER BY probed_at DESC LIMIT 10;"
```

The history shows the streak of `unhealthy` rows during the outage and the recovery rows after.

---

## Operator cheatsheet

| Action | UI path | API call |
|--------|---------|----------|
| Add Health Check URL | App → Edit → Health Monitoring → save | `PATCH /api/apps/:id` with `healthUrl` |
| Toggle monitoring off (planned downtime) | App detail → Health → Monitoring switch | `PATCH /api/applications/:id/health/config` `{"monitoringEnabled": false}` |
| Mute alerts but keep tracking | App detail → Health → Mute alerts | `PATCH /api/applications/:id/health/config` `{"alertsMuted": true}` |
| Force a probe right now | App detail → Health → "Check Now" button | `POST /api/applications/:id/health/check-now` |
| View 24h sparkline | App detail → Health section | `GET /api/applications/:id/health/history` |
| Add wait-for-healthy gate to a deploy | Edit `scripts-manifest.ts`, set `waitForHealthy: true` | manifest-author concern, no runtime API |

## Retention & ops

- Probe rows are pruned at startup AND every 24h (`HEALTH_PROBE_RETENTION_DAYS`, default 30).
- The probe loop survives dashboard restarts — state resumes from `applications.health_status` (committed state) + `app_health_probes` (history).
- A probe-in-flight at shutdown is lost; next cycle picks up.
- Probe-during-deploy is silent — FR-011 interlock skips the tick. You will see a gap in the sparkline during deploys; that's expected.
- The dashboard's own health is NOT monitored by this feature — set up an external uptime monitor (UptimeRobot, BetterStack) pointing at the dashboard's public URL. One observer cannot observe its own death.

## Troubleshooting

**Dot stays grey after Save** — wait 2 probe cycles (default 120s). If still grey, check:

1. `monitoringEnabled` is true on the app row (`SELECT monitoring_enabled FROM applications WHERE id = '...'`).
2. The container exists and the derived name matches (default `<project>-<service>-1`). Check via SSH: `docker ps -a --filter "name=<expected-name>"`.
3. The container has a healthcheck defined (`docker inspect ... | jq .Config.Healthcheck`). If null, no probe can succeed — define a healthcheck in compose OR set a `healthUrl` to bypass container probing.

**Telegram silent on transition** — check:

1. `alertsMuted` is false.
2. `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` env vars set on the dashboard process.
3. Logs at `warn` level for `notifier` errors — Telegram API rate-limit or down.

**`waitForHealthy` deploy stuck for 3 minutes then times out** — the bash tail polls every 5s with a 180s budget = 36 polls. If the container takes longer than 180s to be healthy on the FIRST start, raise the timeout:

```ts
{ id: "deploy/server-deploy", waitForHealthy: true, healthyTimeoutMs: 600_000 }   // 10 minutes
```

**`caddy_admin` probes always fail** — check the SSH tunnel works manually:

```bash
ssh -L 2019:127.0.0.1:2019 deploy@srv-prod-01
# In another terminal:
curl http://localhost:2019/config/
```

If curl returns 200, the tunnel works — investigate the dashboard's probe code path (logs at debug level for `app-health` ctx). If curl fails, Caddy is genuinely down on the target.
