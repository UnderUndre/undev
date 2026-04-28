# Feature Specification: Application Health Monitoring & Post-Deploy Verification

**Version**: 1.0 | **Status**: Draft | **Date**: 2026-04-22

## Clarifications

### Session 2026-04-22 (initial)

- Q: Should the dashboard itself be monitored by the same mechanism it uses to monitor other apps? → A: No. The dashboard is explicitly out of scope for its own internal monitoring — the tier-2 external probe (SaaS / independent host) is the only honest way to detect a dead dashboard, and is handled operationally outside this spec. Feature 006 monitors the *apps* the dashboard manages.
- Q: Does the HTTP probe talk to the target via SSH tunnel or via the target's public URL directly? → A: Public URL by default. The dashboard's HTTP probe hits the same URL a real user would. Container-level health (via SSH `docker inspect`) runs in parallel and answers the different question "is the container itself reporting healthy".
- Q: Is this feature blocking deploy completion? → A: Optional per-manifest-entry. Deploy scripts can opt into `waitForHealthy: true` in their manifest entry; the runner then blocks exit until the app container reports `healthy` OR the wait-timeout expires (default 180s). Without the flag, deploys complete on `docker compose up -d` return as today.
- Q: Does "state change" mean every transition, or only healthy↔unhealthy? → A: Only cross-boundary transitions fire alerts. `unknown → healthy` on first successful probe is silent. `healthy → unhealthy` and `unhealthy → healthy` (recovery) fire Telegram. Flapping is debounced by requiring 2 consecutive probes in the new state before transition is considered committed.

### Session 2026-04-28 (cert_expiry extension)

- Q: Should certificate expiry monitoring live in this feature or in feature 008? → A: **Probe lives here, lifecycle lives in 008.** Feature 008 owns the cert state machine (`app_certs` table, issuance, renewal, revoke). Feature 006 owns the periodic observation that **detects** drift between cert reality and `app_certs.expires_at` — the same way it detects health drift via container/HTTP probes. Adding a third probe type (`cert_expiry`) reuses the existing probe scheduler, alert pipeline, and notifier integration; duplicating that machinery in 008 would be a parallel-universe of the same code.
- Q: How often does the cert_expiry probe run? → A: **Once per day per app**, NOT on the same 60s cycle as container/HTTP probes. Cert expiry is a slow-moving signal (90-day Let's Encrypt lifecycle); minute-by-minute polling burns SSH/network for no signal. Daily fixed window — implementation: same scheduler, different `intervalSec` default (86400) for `probe_type = 'cert_expiry'`.
- Q: How are Caddy admin API failures surfaced — same probe? → A: **Separate probe type `caddy_admin`, runs at the standard 60s cadence.** Caddy admin API unreachable means feature 008's reconciler cannot apply desired-state changes — that's an operational issue worth knowing within minutes, not days. Probe target: `GET http://localhost:2019/config/` over SSH tunnel; outcome `healthy` if 200 OK, `unhealthy` otherwise.

## Problem Statement

Deploys to target servers can "succeed" from the dashboard's perspective while the actual application is broken. This is not theoretical — it happened on 2026-04-22 for ai-digital-twins:

- Dashboard invoked `scripts/deploy/server-deploy.sh --app-dir <path> --branch main`.
- `docker compose up -d` returned exit code 0.
- Runner marked `deployments.status = success`, `script_runs.status = success`.
- UI displayed the green "Deployment completed successfully" banner.
- Telegram sent "Deployed!".
- **But the app container crashed within a second of startup** — `ERR_MODULE_NOT_FOUND: @langfuse/tracing`. The container stayed in "Up" state (process restart loop via compose), and its own healthcheck transitioned to `unhealthy` — but nothing in the dashboard surfaced that fact.
- The nginx in front of the app inherited the problem — its healthcheck fails because the upstream is down — but again, the dashboard's Apps list just shows the app's name with no status indicator.
- Meanwhile, a separate incident on the same day: an unrelated `docker compose up -d --remove-orphans` invocation wiped Caddy, uptime-kuma, and two other stacks off the same docker host. The dashboard had no way to tell the operator which side-effects had occurred because it tracks only the single stack it deployed.

The three compounding gaps:

1. **No health feedback loop.** The dashboard has a `HealthPanel` for servers (CPU/mem/disk), but no per-application health. Operators discover broken apps by clicking through in a browser, by running `docker ps` over SSH, or by customer complaint.
2. **No post-deploy verification.** `docker compose up -d` is a fire-and-forget command. It says "container started" — not "container works". The dashboard's `deployments.status = success` does not mean the app is accepting requests.
3. **No alerts for passive degradation.** Even if an app enters an unhealthy state hours after a deploy (OOM, DB down, upstream API rate-limited), the dashboard is silent. There's no Telegram / webhook / on-UI indicator.

This feature adds the missing feedback loop: periodic health probes per application, an in-UI indicator, Telegram alerts on state-change, and an opt-in post-deploy wait-for-healthy gate for deploy scripts.

## User Scenarios & Testing

### User Story 1 — See which apps are unhealthy at a glance (Priority: P1)

As a dashboard admin looking at the Apps tab of a server, I want every application to show a coloured indicator (healthy / unhealthy / unknown / checking) so I can tell which apps need attention without clicking through, SSHing in, or visiting the app's public URL.

**Acceptance**:

- The Apps list shows a dot icon before each app name, coloured: green (healthy), red (unhealthy), yellow (checking / transition debounce), grey (unknown / probe never succeeded / probe disabled).
- Hovering the dot shows: last probe time, last probe duration, HTTP status code (if HTTP probe), container health status (if container probe), error message (if unhealthy).
- The dashboard homepage (Servers list) aggregates per-server: shows `N/M apps healthy` and turns the server row amber if at least one app is unhealthy.
- Opening an app detail view shows the last 50 probe results as a sparkline (up/down timeline over the last 24h).

### User Story 2 — Get Telegram alert when an app goes down (Priority: P1)

As a dashboard admin who is not watching the UI, I want a Telegram message when any monitored app transitions from healthy to unhealthy (or the reverse, for recovery) so I can react without constantly refreshing the dashboard.

**Acceptance**:

- First time an app reports unhealthy after a streak of healthy, Telegram receives: "❌ *{app.name} is unhealthy*\nServer: {server.label}\nLast probe: {time}\nReason: {message}".
- First time an app reports healthy after a streak of unhealthy, Telegram receives: "✅ *{app.name} is healthy again*\nDowntime: {duration}\nServer: {server.label}".
- Transitions from `unknown` (app just added / probe just enabled) do NOT fire. Only healthy↔unhealthy crossings fire.
- Flapping (≤1 probe cycle in a different state, then back) does NOT fire. Requires 2 consecutive probes in the new state to commit the transition.
- Telegram silent mode is inherited from the existing `notifier` service configuration — no new env vars.

### User Story 3 — Ensure a deploy is actually working before marking it success (Priority: P1)

As an admin triggering a deploy, I want the dashboard to wait until the app's container reports `healthy` before declaring deploy success, so I don't get false-positive "deployed!" messages followed by a broken site.

**Acceptance**:

- A manifest entry CAN declare `waitForHealthy: true` (default false for backward compat).
- When set, after `docker compose up -d` the target script polls `docker inspect --format '{{.State.Health.Status}}' <container>` every 5s until either: status = `healthy` (→ exit 0), OR status = `unhealthy` (→ exit 1 with clear message "healthcheck failed"), OR 180s elapsed (→ exit 1 with "timeout waiting for healthy").
- For containers WITHOUT a defined healthcheck in compose, the wait gate is skipped silently (logged, not failed) — there's nothing to poll.
- The wait-timeout is overridable per manifest entry (`healthyTimeoutMs: number`).
- If `waitForHealthy` succeeds, the dashboard marks `deployments.status = success` and Telegram "Deployed!" fires. If it fails, `deployments.status = failed`, Telegram "Deploy Failed!" fires with the health-failure reason.

### User Story 4 — Configure probe targets per application (Priority: P2)

As an admin adding or editing an application, I want to specify an optional public URL for HTTP probe and (implicitly) get container-health monitoring by service name, so each app gets monitored without manually wiring infrastructure.

**Acceptance**:

- Add Application form has an optional "Health Check URL" input (placeholder: `https://app.example.com/health`). Empty = no HTTP probe; container-level health still runs.
- The probe fires on schedule whether the URL is set or not (container health always, HTTP only when configured).
- Editing an app lets the admin change the URL, disable probing entirely (via a checkbox), or force-refresh the probe now.

### User Story 5 — Independent external health of the dashboard itself (Priority: P3, out-of-tooling)

As the operator of the dashboard, I need to know when the dashboard itself is down. This is NOT solved by feature 006 (since an observer cannot observe its own death).

**Resolution**: documented in operational runbook — set up an external uptime monitor (UptimeRobot free tier or similar) pointing at the dashboard's public URL. One monitor, zero infra. No dashboard code involved.

## Edge Cases

- **Probe target unreachable from dashboard container**: when the dashboard runs inside its own Docker network and the app's public URL is routable externally, the probe uses the public URL as-is. No DNS games inside the container; if `curl https://app.example.com/health` fails from the dashboard pod, that's a real network failure and should surface as unhealthy. If the dashboard is isolated from egress, the HTTP probe is disabled automatically and only container-level health is shown.
- **SSH connection drop mid-probe**: the probe cycle for container-level health uses the existing `ssh-pool` with keepalive. A single probe failure due to transient SSH issue does NOT transition the app to unhealthy — needs 2 consecutive failures (same debounce as healthy↔unhealthy).
- **App has no docker-compose healthcheck defined**: probe skips container check, relies on HTTP probe if configured. If neither is configured, app permanently shows grey "unknown" (not red). Operator can still fix by adding a healthcheck to the compose file.
- **Probe loop contention with deploy**: during a deploy of app X, the probe cycle for X is paused (a lock acquired by the deploy signals the probe to skip). Prevents false-unhealthy during the build-restart window.
- **Clock skew on target**: probe records dashboard-side timestamps, never trusts target. Last-healthy-at is dashboard wall clock.
- **Database storage growth**: `health_snapshots` (or new `app_health_probes`) table grows unbounded; retention must match the existing `healthSnapshots` + `script_runs` prune pattern.
- **Telegram rate-limit / outage**: alerts are fire-and-forget through the existing `notifier` — failures logged but do NOT block the probe loop.
- **Multiple apps pointing at the same container**: unsupported in v1. Each app row in the `applications` table is assumed 1:1 with its service name on the target.
- **`cert_expiry` probe vs Caddy auto-renewal racing**: Caddy auto-renews ~30 days before expiry. The probe MAY observe the cert mid-renewal (old cert returned by TLS handshake, new cert about to be installed) — a one-day blip in `expires_at`. Acceptable; next probe sees the renewed cert. No special handling.
- **`cert_expiry` probe on a domain with no cert yet** (issuance pending or failed): TLS handshake fails (connection refused / timeout / hostname mismatch). Outcome recorded as `error` with the failure reason; does NOT fire an `unhealthy` alert (issuance failure has its own alert pipeline in feature 008). `app_certs.expires_at` is NOT updated by failed handshakes.
- **`caddy_admin` probe failure on a server with no managed apps**: probe still runs (Caddy is per-server, not per-app), but `unhealthy` is not actionable until the operator adds an app with a domain. Alert fires regardless — it's a real infrastructure problem worth surfacing.

## Functional Requirements

### Health probing

- **FR-001**: The dashboard MUST run a periodic health probe for every application with `monitoringEnabled = true` (default true for new apps, true for existing after migration).
- **FR-002**: The probe cycle MUST run every 60 seconds by default; interval MUST be overridable per-app via an `healthProbeIntervalSec` field; interval MUST have a lower bound of 10s (guard against self-DoS).
- **FR-003**: The probe MUST execute container-level health via SSH + `docker inspect --format '{{.State.Health.Status}}' <container-name>` for EVERY enabled app. Container name derivation MUST be documented (default: `<compose-project>-<service>-<replica>` = `ai-twins-app-1` or `ai-twins-app`).
- **FR-004**: The probe MUST execute HTTP health via `GET <app.healthUrl>` with a 10-second timeout for apps that have a non-empty `healthUrl` field.
- **FR-005**: HTTP probe MUST consider 2xx and 3xx as healthy; 4xx and 5xx as unhealthy; timeout / DNS error / connection refused as unhealthy with distinct failure reason in the result.
- **FR-006**: The effective app health state MUST be computed as: `HEALTHY` iff all configured probes (container + optional HTTP) are healthy; `UNHEALTHY` iff any configured probe is unhealthy; `UNKNOWN` iff no configured probe has succeeded yet.
- **FR-006a**: A new probe type `cert_expiry` MUST run once per day per app with a non-NULL `applications.domain`. The probe performs a TLS handshake (illustratively: `openssl s_client -connect <domain>:443 -servername <domain> < /dev/null 2>/dev/null | openssl x509 -noout -enddate`; preferred implementation is Node's native `tls.connect` + `getPeerCertificate().valid_to` — no shellout, no openssl dependency). The parsed `notAfter` MUST be written to `app_certs.expires_at` (table owned by feature 008). If the newly-parsed `notAfter` is **strictly later** than the previously-stored `expires_at`, the probe MUST also update `app_certs.last_renew_at` to the current probe timestamp — a forward-moving expiry is the only reliable signal that Caddy auto-renewal succeeded since the last observation. If `notAfter` is unchanged or earlier (rare; could indicate cert was reverted to an older one), `last_renew_at` MUST NOT be touched. The probe outcome is `healthy` if `expires_at > now() + 14 days`, `unhealthy` if `expires_at < now() + 7 days`, otherwise `warning`. The cert_expiry probe MUST NOT influence the app's overall HEALTHY/UNHEALTHY state — it produces its own alert track (FR-015a) and its own UI surface.
- **FR-006b**: A new probe type `caddy_admin` MUST run on the standard 60s cadence per server (not per app — one Caddy per target). Probe target: `GET http://127.0.0.1:2019/config/` over SSH tunnel. Outcome `healthy` on HTTP 200, `unhealthy` otherwise. State transitions fire alerts per the standard debounce (FR-007). When `caddy_admin` is unhealthy, feature 008's reconciler MUST mark affected `app_certs` rows `pending_reconcile` (per spec 008 FR-009).

### State machine & debouncing

- **FR-007**: A single probe failure MUST NOT transition the app out of `HEALTHY` to `UNHEALTHY`. Transition requires 2 consecutive probes in the new state (configurable via `healthDebounceCount`, default 2, minimum 1).
- **FR-008**: `UNKNOWN → HEALTHY` MUST NOT fire an alert.
- **FR-009**: `HEALTHY → UNHEALTHY` MUST fire an alert (only after debounce commits).
- **FR-010**: `UNHEALTHY → HEALTHY` MUST fire a recovery alert including the total downtime in the message.
- **FR-011**: During an active deploy of an app (`deploy_locks.app_id = <this-app>`), the probe cycle for that app MUST be paused. The probe resumes after the lock is released.

### Persistence

- **FR-012**: Every probe result (regardless of outcome) MUST be persisted to a `app_health_probes` table: `id, app_id, probed_at, probe_type (container | http), outcome (healthy | unhealthy | error), latency_ms, status_code (HTTP only), error_message, container_status (container only)`.
- **FR-013**: The current effective health state MUST be denormalised onto the `applications` row: `health_status (healthy | unhealthy | unknown)`, `health_checked_at (timestamp)`, `health_last_change_at (timestamp)`, `health_message`.
- **FR-014**: A retention prune MUST delete `app_health_probes` rows older than `HEALTH_PROBE_RETENTION_DAYS` (default 30). Implementation follows the pattern from feature 005's `script_runs` prune.

### Alerts

- **FR-015**: State-transition alerts MUST go through the existing `notifier` service. Telegram payload shape defined in User Story 2.
- **FR-016**: Alerts MUST include the `app.id` in a link field (Telegram markup) that deep-links to the app's detail view in the dashboard.
- **FR-017**: Notifier failures MUST NOT crash the probe loop. Errors logged at warn level.
- **FR-018**: A "muted" flag MUST exist on the app row (`alertsMuted: boolean`) to let the operator silence notifications for a known-in-maintenance app. Health state continues to be tracked; **only Telegram is skipped when muted**. UI surfaces (status dot, tooltip, sparkline, WebSocket events `app.health-changed`) continue to update normally — muting is a notification-channel filter, not a data-suppression toggle.
- **FR-015a**: Cert-expiry alerts MUST fire on a windowed schedule, NOT on every probe. Windows: ≤14 days, ≤7 days, ≤3 days, ≤1 day. Each window fires Telegram **once per cert lifecycle** (tracked via `app_cert_events` from feature 008). On successful renewal that pushes `expires_at` past a window, the window unlocks for the next cycle. Recovery (cert renewed) is silent — no positive-acknowledgement message; the original alert was sufficient signal. Alert payload: `"🔒 *Cert expiring*\nApp: {app.name}\nDomain: {domain}\nExpires: {expires_at} ({days_left} days)\nLast renew: {last_renew_at}\nStatus: {cert.status}"`.
- **FR-015b**: `caddy_admin` probe transitioning to `unhealthy` MUST fire Telegram: `"🟠 *Caddy unreachable*\nServer: {server.label}\nLast successful: {ago}\nReverse-proxy reconciliation paused — cert renewals and domain changes will be queued."`. Recovery (`unhealthy → healthy`) fires the standard recovery message.

### UI

- **FR-019**: The Apps list on the Server Page MUST show a coloured dot per app (green/red/yellow/grey) with a tooltip on hover showing health detail.
- **FR-020**: The Apps list MUST re-poll the `GET /api/servers/:id/apps` endpoint every 30 seconds OR subscribe to a WS channel for live health updates (implementation choice, behaviour MUST be equivalent).
- **FR-021**: The app detail view MUST display a 24h health-status timeline sparkline.
- **FR-022**: The Add Application form MUST have an optional "Health Check URL" input.
- **FR-023**: An app's detail view MUST have a "Check Now" button that triggers an out-of-cycle probe and re-renders the status within 15 seconds.

### Post-deploy health gate

- **FR-024**: The manifest entry type MUST support an optional `waitForHealthy: boolean` (default false) and `healthyTimeoutMs: number` (default 180000).
- **FR-025**: When `waitForHealthy: true`, the deploy-runner MUST append a bash tail to the transported script buffer that polls `docker inspect --format '{{.State.Health.Status}}' <container>` every 5 seconds until the status is `healthy`, `unhealthy`, or `timeout`.
- **FR-026**: If the post-deploy wait times out, the deploy's `script_runs.status = 'timeout'` and `deployments.status = 'failed'` with `error_message = 'healthcheck did not turn healthy within Xms'`.
- **FR-027**: If the post-deploy wait reports `unhealthy`, the deploy's `script_runs.status = 'failed'` with `error_message = 'healthcheck reported unhealthy during startup'`.
- **FR-028**: If the target container has no docker-compose healthcheck defined, the wait gate MUST skip silently (log warn, proceed to success). No failure — cannot wait for a healthcheck that doesn't exist.

### Safety

- **FR-029**: HTTP probes MUST NEVER follow redirects to a different host (prevents probe-loops and SSRF).
- **FR-030**: HTTP probes MUST send a `User-Agent: devops-dashboard-probe/1.0` header so app ops can filter probe traffic out of analytics.
- **FR-031**: Container-health probes MUST NOT require root on the target (use the same SSH user as deploys).

## Success Criteria

- **SC-001**: After feature ships, at least one app on each production server has a visible health status (green/red/yellow/grey) in the UI within 10 minutes of probing being enabled.
- **SC-002**: Time from app-breaks to admin-notified (Telegram) is < 3 minutes (2 consecutive probe cycles at 60s each + 1 minute notifier latency).
- **SC-003**: Zero false-positive deploy success notifications for apps using `waitForHealthy: true` — validated by deliberately pushing a known-broken container and observing the deploy is marked failed.
- **SC-004**: Health monitoring adds ≤ 3% CPU overhead to the dashboard container at steady state (10 apps × 60s interval = 10 probes/min).
- **SC-005**: The dashboard's own deploy time does NOT increase by more than 5s on average due to the feature (excluding user-opted `waitForHealthy` delays, which are willingly trading time for correctness).
- **SC-006**: The 2026-04-22 incident class ("deploy success, app broken, operator notified by customer") is zero-occurrence in the 30 days following feature rollout.

## Key Entities

### `app_health_probes` (new table)

One row per probe execution. Retention pruned by `HEALTH_PROBE_RETENTION_DAYS` (default 30).

```ts
{
  id: string;                              // uuid
  appId: string;                           // FK → applications(id) on delete cascade
  probedAt: string;                        // ISO
  probeType: 'container' | 'http';
  outcome: 'healthy' | 'unhealthy' | 'error';
  latencyMs: number | null;
  statusCode: number | null;               // HTTP only
  errorMessage: string | null;
  containerStatus: string | null;          // docker inspect health.status verbatim, container only
}
```

### `applications` (modified — new columns)

- `healthUrl TEXT NULL` — optional public URL for HTTP probe.
- `healthStatus TEXT NOT NULL DEFAULT 'unknown'` — one of `healthy | unhealthy | unknown`.
- `healthCheckedAt TEXT NULL` — ISO timestamp of last probe (any kind).
- `healthLastChangeAt TEXT NULL` — ISO timestamp of last state transition.
- `healthMessage TEXT NULL` — human-readable last failure reason.
- `healthProbeIntervalSec INTEGER NOT NULL DEFAULT 60` — per-app override of probe cadence.
- `healthDebounceCount INTEGER NOT NULL DEFAULT 2` — per-app override of transition debounce.
- `monitoringEnabled BOOLEAN NOT NULL DEFAULT TRUE` — master switch.
- `alertsMuted BOOLEAN NOT NULL DEFAULT FALSE` — skip Telegram but keep tracking state.

### Manifest entry (modified — new optional fields)

- `waitForHealthy?: boolean` (default false)
- `healthyTimeoutMs?: number` (default 180_000)

Applied to `deploy/server-deploy` and `deploy/deploy-docker` entries that correspond to compose-backed apps.

## Assumptions

- A-001: The dashboard has network egress to the target's public URL. If it doesn't (air-gapped / split-horizon DNS), HTTP probing is silently disabled for that app (container-level probes still work via SSH).
- A-002: One app row = one container group (one docker compose service OR one docker-compose project). Multi-service apps share a single health state — if any service is unhealthy the whole app is unhealthy.
- A-003: The existing `notifier` service is sufficient for state-change alerts. No new alerting channels (email, PagerDuty, Slack) in v1.
- A-004: Probe loop runs inside the dashboard Node.js process. If the dashboard container restarts, probe state is re-loaded from `applications.health_*` columns (continues) + `app_health_probes` (history). A probe-in-flight at shutdown is lost; next cycle picks up.
- A-005: Storage growth — 10 apps × 2 probe types × 1 per minute = 28,800 rows/day. At 30-day retention ≈ 864K rows. With 100+ apps this becomes 8.6M rows — we'll need to revisit retention or aggregate into hourly summaries (v2).
- A-006: The `notifier` service currently fires Telegram for deploys only. We extend it with a new `notify('app-health-change', ...)` event. Same bot token, same chat id.

## Dependencies

- **Feature 001** (deploy history): `deployments` table and `jobManager` → needed to link post-deploy wait gate into the existing deploy flow.
- **Feature 004** (db deploy lock): `deploy_locks` table → needed to pause probe during active deploy (FR-011).
- **Feature 005** (script runner): manifest + scripts-runner → `waitForHealthy` integrates at the target-script level.
- **Feature 003** (scan-import): scan flow sets `monitoringEnabled = true` for new apps with a repo URL; docker-only apps get `monitoringEnabled = false` by default since they rarely have healthchecks.
- **Feature 008** (application-domain-and-tls): owns `app_certs` table; this feature's `cert_expiry` probe writes `expires_at` and `app_certs.last_renew_at` updates. Bidirectional contract: 008 owns issuance/lifecycle, 006 owns periodic observation.

## Out of Scope

- Monitoring the dashboard itself (use external SaaS — documented in runbook, not this feature).
- Email / PagerDuty / Slack / webhook alerts beyond existing Telegram notifier.
- Load-balancer-style removing an unhealthy app from a pool (no routing in this dashboard).
- Synthetic user flows / smoke-tests beyond single URL probe.
- Scheduled probes ≠ on-demand "Check Now" (the latter is a small feature in UI, former is the engine).
- Per-probe retry policies beyond the debounce described — complex backoff is v2.
- Observability metrics export (Prometheus / OTel) — may come later as feature 008.
- Replacing uptime-kuma or standalone probing infrastructure on the target hosts.

## Related

- Incident 2026-04-22-ai-twins-broken-deploy: the triggering scenario for this spec.
- Feature 005 `/specs/005-universal-script-runner/spec.md`: the manifest that this feature extends.
- Feature 008 `/specs/008-application-domain-and-tls/spec.md`: defines `app_certs.expires_at` written by the `cert_expiry` probe (FR-006a) and the `pending_reconcile` state set on `caddy_admin` failure (FR-006b).
- CLAUDE.md rule 5 (no direct migrations): the schema changes below must ship as reviewable SQL.
