# Implementation Plan: Application Health Monitoring & Post-Deploy Verification

**Branch**: `main` (spec-on-main convention per features 005/007) | **Date**: 2026-04-28 | **Spec**: [spec.md](spec.md)

## Summary

Add a per-application health probe loop that runs alongside the existing per-server `health-poller.ts`. A new service `app-health-poller.ts` schedules four probe types — `container` (SSH `docker inspect`, every 60s), `http` (Node `fetch` against the app's public health URL, every 60s when `healthUrl` is set), `caddy_admin` (HTTP via SSH-tunnelled local port 2019, every 60s per server, FR-006b), and `cert_expiry` (TLS handshake, once per day per app with a non-NULL domain, FR-006a). Each probe persists to a new `app_health_probes` table and may flip a state machine (`unknown → healthy → unhealthy`) gated by a configurable debounce (default 2 consecutive same-state probes, FR-007). Transitions through the `healthy ↔ unhealthy` boundary (NEVER through `unknown`) fire a Telegram alert via the existing `notifier`; cert windows ≤14d/≤7d/≤3d/≤1d fire once per cert lifecycle (FR-015a).

The deploy runner (feature 005's `scripts-runner.ts`) gains a manifest extension: any compose-backed entry MAY declare `waitForHealthy: true` and `healthyTimeoutMs` (default 180000ms). When set, the runner appends a target-side bash poll loop to the transported script; the loop calls `docker inspect --format '{{.State.Health.Status}}' <container>` every 5s until `healthy` (exit 0), `unhealthy` (exit 1), or timeout (exit 124). FR-026..FR-028 specify the exit-code-to-`script_runs.status` mapping. Containers without a defined healthcheck skip the wait silently (FR-028) — cannot wait for what does not exist.

Probe-during-deploy interlock uses feature 004's `deploy_locks` table: when a row exists for `(server_id, app_id)`, the per-app probe scheduler skips that app's tick (FR-011). The `caddy_admin` probe is per-server, not per-app, and ignores per-app deploy locks. UI surfaces the state via a coloured dot per app row + tooltip + 24h sparkline + Check Now button (FR-019..FR-023). Live updates use the existing WebSocket channel pattern (`channelManager.broadcast`) — see R-006 for why polling was rejected.

## Technical Context

**Existing stack** (inherited from 001–008):

- Express 5 + React 19 / Vite 8 / Tailwind 4, drizzle-orm + `postgres` (porsager) 3.4.x
- `sshPool` (`ssh2` 1.17) with `exec`, `execStream`, and `executeWithStdin` (feature 005)
- `jobManager` for in-memory job lifecycle + WS event fan-out
- `channelManager` for WS subscriptions (used today by `health-poller.ts` for `health:<serverId>` channel)
- Pino logger with redact config; existing `notifier` (Telegram) with `defaultToken`/`defaultChatId` from env
- Feature 004 `deployLock` service (Postgres advisory lock + `deploy_locks` table for the row that records `(serverId, appId, acquiredAt)`)
- Feature 005 `scripts-runner.ts` + `scripts-manifest.ts` (the deploy-runner this feature extends)
- Feature 005 `script_runs` table (status field already supports `pending|running|success|failed|cancelled|timeout`)
- Feature 007 `applications.scriptPath` (irrelevant to 006 directly, but informs migration sequence — next slot is 0007)
- Feature 008 (in-flight) owns `app_certs` and `app_cert_events` tables; this feature WRITES `app_certs.expires_at` and `app_certs.last_renew_at`, READS `app_cert_events` for windowed-once-per-lifecycle dedupe (FR-015a)

**New for this feature**:

- New service — `app-health-poller.ts` (scheduler, debounce, state-machine commit, alert dispatch)
- New module — `probes/` directory with one runner per probe type (`container.ts`, `http.ts`, `cert-expiry.ts`, `caddy-admin.ts`)
- New table — `app_health_probes` + 8 new columns on `applications`
- New migration — `0007_app_health_monitoring.sql` (next available slot — 0006 is feature 007's `script_path`)
- New routes — `GET /api/applications/:id/health`, `POST /api/applications/:id/health/check-now`, `PATCH /api/applications/:id/health/config`, `GET /api/applications/:id/health/history`
- New WS events — `app.health-changed`, `app.cert-expiring`, `server.caddy-unreachable`
- Manifest extension — two new optional fields (`waitForHealthy`, `healthyTimeoutMs`) on existing deploy entries, plus a `buildHealthCheckTail(params)` helper used by the runner
- Notifier extension — new `notify('app-health-change'|'cert-expiring'|'caddy-unreachable', ...)` event types reusing the same Telegram bot/chat
- UI — per-app status dot + tooltip in apps list (`AppsTab.tsx`), 24h sparkline + Check Now button on app detail (`ApplicationDetail.tsx`), Health Check URL field on add/edit form

**No new npm dependencies.** Node ≥ 20 has `fetch`, `AbortController`, and `tls` natively. TLS expiry parsing uses `tls.connect` + `peerCertificate.valid_to` — no `openssl` shellout despite the spec's example syntax (see R-004).

**Unknowns resolved in research.md**:

- R-001: Probe scheduler design (per-app `setTimeout` chain — same shape as existing `health-poller.ts`).
- R-002: Container health probe transport (reused `sshPool.exec` per probe; no separate pool).
- R-003: HTTP probe transport (Node `fetch` + `AbortController` 10s timeout, `redirect: "manual"`).
- R-004: TLS expiry probe transport (`tls.connect` native, NOT `openssl s_client`).
- R-005: Caddy admin SSH-tunnel reuse strategy (one short-lived forward per probe; coordinated with feature 008's reconciler tunnel).
- R-006: Live UI updates — WS subscription wins over polling (FR-020).
- R-007: Per-cert window deduplication via `app_cert_events` rows.
- R-008: Sparkline rendering via raw probes (24h × 60s = 1440 rows max — cheap, no aggregation).
- R-009: Wait-for-healthy bash tail injection (heredoc append to existing transported script).
- R-010: Probe-during-deploy lock acquisition order (read `deploy_locks` before each probe — no lock taken).
- R-011: `health_status` denormalisation freshness — write on EVERY probe (`health_checked_at`) but mutate `health_status` ONLY on transition commit (FR-013).

## Project Structure

```
undev/
├── scripts/                                  # [unchanged]
└── devops-app/
    ├── server/
    │   ├── db/
    │   │   ├── schema.ts                     # [MODIFIED — 8 cols on applications + new appHealthProbes table]
    │   │   └── migrations/
    │   │       └── 0007_app_health_monitoring.sql  # [NEW — ALTER applications + CREATE app_health_probes]
    │   ├── services/
    │   │   ├── health-poller.ts              # [unchanged — per-server CPU/mem/disk poller]
    │   │   ├── app-health-poller.ts          # [NEW — per-app probe scheduler + state machine]
    │   │   ├── probes/                       # [NEW dir]
    │   │   │   ├── container.ts              # [NEW — SSH docker inspect runner]
    │   │   │   ├── http.ts                   # [NEW — Node fetch runner with AbortController]
    │   │   │   ├── cert-expiry.ts            # [NEW — tls.connect handshake → notAfter]
    │   │   │   └── caddy-admin.ts            # [NEW — SSH-tunnelled GET localhost:2019/config/]
    │   │   ├── notifier.ts                   # [MODIFIED — add 3 event-type formatters; switch to logger.warn]
    │   │   └── scripts-runner.ts             # [MODIFIED — buildHealthCheckTail() helper invoked when entry.waitForHealthy]
    │   ├── scripts-manifest.ts               # [MODIFIED — add optional waitForHealthy/healthyTimeoutMs fields on deploy entries]
    │   ├── routes/
    │   │   ├── apps.ts                       # [MODIFIED — accept healthUrl/monitoringEnabled/alertsMuted/etc on POST/PATCH]
    │   │   └── health.ts                     # [MODIFIED — add app-scoped routes alongside existing server-scoped]
    │   └── lib/
    │       └── public-suffix.ts              # [unchanged — reused from feature 008 if applicable; else inlined effective-domain helper]
    ├── client/
    │   ├── components/
    │   │   ├── apps/
    │   │   │   ├── AddAppForm.tsx            # [MODIFIED — add Health Check URL field]
    │   │   │   ├── EditAppForm.tsx           # [MODIFIED — add Health Check URL + monitoringEnabled checkbox + alertsMuted]
    │   │   │   └── ApplicationDetail.tsx     # [MODIFIED — render HealthDot + 24h sparkline + Check Now button]
    │   │   └── health/
    │   │       ├── HealthPanel.tsx           # [unchanged — server-scoped panel]
    │   │       ├── AppHealthDot.tsx          # [NEW — coloured dot + tooltip; reused in Apps list and detail]
    │   │       ├── AppHealthSparkline.tsx    # [NEW — 24h up/down timeline, raw probes]
    │   │       └── CheckNowButton.tsx        # [NEW — POST /api/applications/:id/health/check-now]
    │   ├── hooks/
    │   │   └── useAppHealth.ts               # [NEW — WS subscription + react-query for current state + history]
    │   └── pages/
    │       └── ServerPage.tsx                # [MODIFIED — Apps tab renders HealthDot per row]
    └── tests/
        ├── unit/
        │   ├── app-health-state-machine.test.ts        # [NEW — debounce, transitions, recovery downtime calc]
        │   ├── probes-container.test.ts                # [NEW — docker inspect parser + container-name derivation]
        │   ├── probes-http.test.ts                     # [NEW — 2xx/3xx/4xx/5xx/timeout/redirect classification]
        │   ├── probes-cert-expiry.test.ts              # [NEW — tls.connect mock + window classification]
        │   ├── probes-caddy-admin.test.ts              # [NEW — SSH-tunnel HTTP 200/non-200 outcome]
        │   ├── build-health-check-tail.test.ts         # [NEW — bash tail generator + heredoc safety]
        │   └── cert-window-dedup.test.ts               # [NEW — windowed-once-per-lifecycle logic via app_cert_events]
        └── integration/
            ├── app-health-poller.test.ts               # [NEW — full cycle: schedule → probe → transition → notify]
            ├── deploy-wait-for-healthy.test.ts         # [NEW — manifest entry with waitForHealthy → bash tail emitted]
            ├── probe-pause-during-deploy.test.ts       # [NEW — FR-011 deploy_locks interlock]
            ├── health-routes.test.ts                   # [NEW — GET/POST/PATCH endpoints]
            └── migration-0007-verification.test.ts     # [NEW — 8 cols on applications + app_health_probes shape]
```

## Probe loop architecture

Pseudo-code for the scheduler in `app-health-poller.ts`:

```ts
class AppHealthPoller {
  private appPolls = new Map<string, AppPollState>();   // appId → state
  private serverCaddyPolls = new Map<string, CaddyPollState>(); // serverId → state
  private dailyCertTimer: NodeJS.Timeout | null = null;

  async start(): Promise<void> {
    const apps = await db.select().from(applications).where(eq(applications.monitoringEnabled, true));
    for (const app of apps) this.scheduleAppCycle(app);
    const serversWithDomains = await this.serversWithManagedDomains();
    for (const sid of serversWithDomains) this.scheduleCaddyCycle(sid);
    this.scheduleDailyCertSweep();
  }

  private scheduleAppCycle(app: AppRow): void {
    const intervalMs = Math.max(10_000, app.healthProbeIntervalSec * 1000); // FR-002 lower bound 10s
    const state: AppPollState = { appId: app.id, intervalMs, isPolling: false, timer: null,
                                  consecutive: { healthy: 0, unhealthy: 0 } };
    this.appPolls.set(app.id, state);
    this.tickApp(state);
  }

  private tickApp(state: AppPollState): void {
    state.timer = setTimeout(async () => {
      if (!this.appPolls.has(state.appId)) return;
      if (state.isPolling) { this.tickApp(state); return; }    // skip if previous still in flight

      // FR-011: pause during deploy. Read lock row, do NOT acquire.
      const locked = await db.select().from(deployLocks)
        .where(and(eq(deployLocks.appId, state.appId)));
      if (locked.length > 0) {
        logger.debug({ ctx: "app-health", appId: state.appId }, "Probe paused — deploy in progress");
        this.tickApp(state);
        return;
      }

      state.isPolling = true;
      try {
        const app = await this.loadAppFresh(state.appId);     // re-read each cycle to pick up config changes
        if (!app || !app.monitoringEnabled) { this.appPolls.delete(state.appId); return; }
        const containerOutcome = await runContainerProbe(app);
        const httpOutcome = app.healthUrl ? await runHttpProbe(app) : null;
        const effective = computeEffectiveOutcome(containerOutcome, httpOutcome);   // FR-006
        await persistProbes(app.id, [containerOutcome, httpOutcome].filter(Boolean));
        await this.commitState(app, effective, containerOutcome, httpOutcome);
      } catch (err) {
        logger.warn({ ctx: "app-health", appId: state.appId, err }, "Probe cycle failed");
      } finally {
        state.isPolling = false;
      }
      this.tickApp(state);
    }, state.intervalMs);
  }

  private scheduleCaddyCycle(serverId: string): void { /* same shape, 60s, runs caddy-admin probe */ }

  private scheduleDailyCertSweep(): void {
    // One timer for ALL apps; iterates apps with non-null domain, runs cert_expiry probe per app.
    this.dailyCertTimer = setInterval(async () => {
      const apps = await db.select().from(applications)
        .where(and(eq(applications.monitoringEnabled, true), isNotNull(applications.domain)));
      for (const app of apps) await runCertExpiryProbe(app);   // sequential — daily, not latency-critical
    }, 24 * 3600 * 1000).unref();
  }
}
```

The recursive `setTimeout` shape mirrors `health-poller.ts:149` exactly — same overlap guard, same `polls.has()` cancellation gate, same try/catch swallowing semantics.

## Key Implementation Notes

### `app-health-poller.ts` — scheduler + state machine

Public surface:

```ts
class AppHealthPoller {
  start(): Promise<void>;
  stop(): void;
  reloadApp(appId: string): Promise<void>;       // called from PATCH /api/applications/:id/health/config
  runOutOfCycleProbe(appId: string): Promise<{ probedAt: string; effective: HealthOutcome }>;  // FR-023 Check Now
}
export const appHealthPoller = new AppHealthPoller();
```

The state machine commits transitions via `commitState(app, newOutcome, containerOutcome, httpOutcome)`:

```ts
async commitState(app: AppRow, newOutcome: "healthy"|"unhealthy"|"unknown",
                  c: ProbeOutcome|null, h: ProbeOutcome|null) {
  const prev = app.healthStatus;                          // 'healthy'|'unhealthy'|'unknown'
  const counter = state.consecutive[newOutcome] = (state.consecutive[newOutcome] ?? 0) + 1;
  // reset opposite counter
  if (newOutcome === "healthy") state.consecutive.unhealthy = 0;
  if (newOutcome === "unhealthy") state.consecutive.healthy = 0;

  // Always update freshness columns (FR-013 / R-011)
  await db.update(applications).set({
    healthCheckedAt: new Date().toISOString(),
    healthMessage: messageFromOutcomes(c, h),
  }).where(eq(applications.id, app.id));

  // Transition only when debounce satisfied
  const debounceN = app.healthDebounceCount ?? 2;
  if (counter < debounceN) return;
  if (newOutcome === prev) return;                        // no transition

  // Commit transition: write health_status + health_last_change_at
  await db.update(applications).set({
    healthStatus: newOutcome,
    healthLastChangeAt: new Date().toISOString(),
  }).where(eq(applications.id, app.id));

  // FR-008: unknown → healthy is silent. FR-009/FR-010: healthy↔unhealthy fires.
  const cross = (prev === "healthy" && newOutcome === "unhealthy") ||
                (prev === "unhealthy" && newOutcome === "healthy");
  if (cross && !app.alertsMuted) await this.fireAlert(app, prev, newOutcome);

  // Broadcast WS event regardless of mute (UI still updates on muted apps)
  channelManager.broadcast(`app-health:${app.id}`, {
    type: "health-changed", status: newOutcome, at: new Date().toISOString(),
  });
}
```

**Worked example** (FR-007 debounce, default 2):

| Tick | Probe outcome | counter.unhealthy | counter.healthy | committed status | alert |
|------|---------------|-------------------|-----------------|------------------|-------|
| 1    | healthy       | 0                 | 1               | unknown→healthy (silent per FR-008) | no |
| 2    | healthy       | 0                 | 2               | healthy (no change) | no |
| 3    | unhealthy     | 1                 | 0               | healthy (counter < 2) | no |
| 4    | healthy       | 0                 | 1               | healthy (counter reset) | no |
| 5    | unhealthy     | 1                 | 0               | healthy (still < 2) | no |
| 6    | unhealthy     | 2                 | 0               | unhealthy (commit, FR-009) | YES |
| 7    | healthy       | 0                 | 1               | unhealthy (< 2) | no |
| 8    | healthy       | 0                 | 2               | healthy (commit, FR-010) | YES + downtime |

Downtime in the recovery message is `now - app.healthLastChangeAt` snapshotted before the update.

### Probe runners — `probes/*.ts`

Each runner has the same signature:

```ts
type ProbeOutcome = {
  outcome: "healthy" | "unhealthy" | "error";
  latencyMs: number | null;
  statusCode?: number | null;
  containerStatus?: string | null;
  errorMessage?: string | null;
  probeType: "container" | "http" | "cert_expiry" | "caddy_admin";
};

export async function runContainerProbe(app: AppRow): Promise<ProbeOutcome>;
export async function runHttpProbe(app: AppRow): Promise<ProbeOutcome>;
export async function runCertExpiryProbe(app: AppRow): Promise<ProbeOutcome>;
export async function runCaddyAdminProbe(server: ServerRow): Promise<ProbeOutcome>;
```

**Container** (`probes/container.ts`):

```ts
const containerName = deriveContainerName(app);   // <project>-<service>-1 OR <project>-<service>
const cmd = `docker inspect --format '{{.State.Health.Status}}' ${shQuote(containerName)} 2>/dev/null || echo no-container`;
const t0 = Date.now();
const { stdout, stderr, code } = await sshPool.exec(app.serverId, cmd);
const status = stdout.trim();
if (status === "healthy") return ok("healthy", { containerStatus: status, latencyMs: Date.now() - t0 });
if (status === "unhealthy") return ok("unhealthy", { containerStatus: status });
if (status === "starting") return ok("unhealthy", { containerStatus: status });   // starting = not yet up
if (status === "no-container") return err("Container not found", { containerStatus: null });
return ok("unhealthy", { containerStatus: status, errorMessage: `unknown status: ${status}` });
```

`deriveContainerName` documented per FR-003: defaults to `<compose-project>-<service>-1`; falls back to `<compose-project>-<service>` for one-off (no replica) services. Configurable in v2 via per-app override.

**HTTP** (`probes/http.ts`):

```ts
const ctrl = new AbortController();
const timeoutMs = 10_000;
const t = setTimeout(() => ctrl.abort(), timeoutMs);
const t0 = Date.now();
try {
  const resp = await fetch(app.healthUrl!, {
    method: "GET",
    redirect: "manual",                                       // FR-029 — no cross-host redirect
    headers: { "User-Agent": "devops-dashboard-probe/1.0" },  // FR-030
    signal: ctrl.signal,
  });
  const latencyMs = Date.now() - t0;
  // FR-005: 2xx/3xx healthy, 4xx/5xx unhealthy
  const code = resp.status;
  if (code >= 200 && code < 400) return ok("healthy", { statusCode: code, latencyMs });
  return ok("unhealthy", { statusCode: code, latencyMs, errorMessage: `HTTP ${code}` });
} catch (err) {
  if ((err as Error).name === "AbortError") return err("timeout after 10s");
  return err((err as Error).message);                         // DNS / ECONNREFUSED / TLS error
} finally {
  clearTimeout(t);
}
```

Redirect policy is `manual` so a 3xx is recorded as a redirect-with-status, NOT followed — prevents probe loops and SSRF (FR-029). The 3xx classification as healthy is the spec's intent (the app responded with a redirect — that's a working app, just one that bounces).

**TLS expiry** (`probes/cert-expiry.ts`):

```ts
import { connect } from "node:tls";

function readCert(host: string): Promise<Date | null> {
  return new Promise((resolve, reject) => {
    const s = connect({ host, port: 443, servername: host, rejectUnauthorized: false });
    s.once("secureConnect", () => {
      const cert = s.getPeerCertificate(false);
      s.end();
      if (!cert?.valid_to) return resolve(null);
      resolve(new Date(cert.valid_to));
    });
    s.once("error", reject);
    s.setTimeout(15_000, () => { s.destroy(new Error("tls timeout")); });
  });
}

export async function runCertExpiryProbe(app: AppRow): Promise<ProbeOutcome> {
  if (!app.domain) return err("no domain");
  try {
    const expiresAt = await readCert(app.domain);
    if (!expiresAt) return err("cert had no notAfter");
    const daysLeft = (expiresAt.getTime() - Date.now()) / 86_400_000;
    // FR-006a thresholds (note: probe outcome does NOT influence app overall HEALTHY/UNHEALTHY)
    const outcome: ProbeOutcome["outcome"] =
      daysLeft > 14 ? "healthy" : daysLeft < 7 ? "unhealthy" : ("warning" as const);
    // Persist to feature 008's app_certs table — bidirectional contract
    await db.update(appCerts).set({
      expiresAt: expiresAt.toISOString(),
      lastRenewAt: new Date().toISOString(),  // FR-022 — probe is source of truth post-issuance
      lastRenewOutcome: "success",
    }).where(and(eq(appCerts.appId, app.id), eq(appCerts.domain, app.domain)));
    // Window-once-per-lifecycle alerting handled in commitCertState — see below
    return { outcome, probeType: "cert_expiry", latencyMs: null,
             errorMessage: null, statusCode: null, containerStatus: null };
  } catch (e) {
    // FR-006a Edge Case — failed handshake records error; does NOT update expires_at; does NOT alert
    return err((e as Error).message);
  }
}
```

`rejectUnauthorized: false` — we want to read the cert even if it's expired or chain-broken. The cert data itself is what's interesting, not the trust verdict.

**Caddy admin** (`probes/caddy-admin.ts`):

```ts
export async function runCaddyAdminProbe(server: ServerRow): Promise<ProbeOutcome> {
  // FR-006b: SSH-tunnel a local port to remote 127.0.0.1:2019, GET /config/, expect 200.
  // R-005: short-lived tunnel per probe; reusing feature 008's reconciler tunnel
  // requires complex coordination and the probe is cheap (60s cadence, one HTTP roundtrip).
  const tunnel = await sshPool.openTunnel(server.id, { remoteHost: "127.0.0.1", remotePort: 2019 });
  const t0 = Date.now();
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5_000);
    const resp = await fetch(`http://127.0.0.1:${tunnel.localPort}/config/`, { signal: ctrl.signal });
    clearTimeout(timer);
    const latencyMs = Date.now() - t0;
    if (resp.status === 200) return { outcome: "healthy", probeType: "caddy_admin", latencyMs,
                                       statusCode: 200, errorMessage: null, containerStatus: null };
    return { outcome: "unhealthy", probeType: "caddy_admin", latencyMs,
             statusCode: resp.status, errorMessage: `HTTP ${resp.status}`, containerStatus: null };
  } catch (e) {
    return err((e as Error).message);
  } finally {
    tunnel.close();
  }
}
```

`sshPool.openTunnel` is added as a thin wrapper over ssh2's `forwardOut`. Same auth as `sshPool.exec` — no new credentials, no extra config.

### Notifier integration — new event types

Notifier currently uses `console.log`/`console.error` (`notifier.ts:23,44,52`) — this feature flips that to `logger.info`/`logger.error` per CLAUDE.md AI-Generated Code Guardrails (`console.log()` → `logger.info({ ctx }, 'msg')`). Then add three formatters:

```ts
// notifier.ts additions
async notifyAppHealthChange(app: AppRow, server: ServerRow, transition: "to-unhealthy" | "to-healthy",
                            details: { reason?: string; downtimeMs?: number }): Promise<boolean> {
  const evt = transition === "to-unhealthy" ? "❌ App unhealthy" : "✅ App healthy again";
  const body = transition === "to-unhealthy"
    ? `*${app.name}*\nServer: ${server.label}\nReason: ${details.reason ?? "unknown"}\n[Open](${this.deepLink(app.id)})`
    : `*${app.name}*\nDowntime: ${formatDuration(details.downtimeMs ?? 0)}\nServer: ${server.label}`;
  return this.send(`*${evt}*`, body);
}

async notifyCertExpiring(app, cert, daysLeft): Promise<boolean> { /* FR-015a payload */ }
async notifyCaddyUnreachable(server, lastSuccessAgo): Promise<boolean> { /* FR-015b payload */ }
```

Failures swallowed and logged at `warn` level per FR-017. The `notify()` return-bool is preserved for callers that want to chain.

### Wait-for-healthy gate in deploy runner

The runner extension lives in `scripts-runner.ts`. Pseudo-diff:

```ts
// scripts-runner.ts — when dispatching a manifest entry with waitForHealthy: true
const tail = entry.waitForHealthy
  ? buildHealthCheckTail({ container: deriveContainerName(app), timeoutMs: entry.healthyTimeoutMs ?? 180_000 })
  : "";
const transportedScript = [commonShAndOverrides, targetScript, tail].join("\n");
// ... existing executeWithStdin path ...
```

`buildHealthCheckTail` (new helper):

```ts
export function buildHealthCheckTail(p: { container: string; timeoutMs: number }): string {
  const tSec = Math.ceil(p.timeoutMs / 1000);
  return `
# Feature 006 wait-for-healthy gate
__WFH_CONTAINER=${shQuote(p.container)}
__WFH_DEADLINE=$(( $(date +%s) + ${tSec} ))

# FR-028 — silently skip when no healthcheck defined
__WFH_HAS_HC=$(docker inspect --format '{{if .State.Health}}1{{else}}0{{end}}' "$__WFH_CONTAINER" 2>/dev/null || echo 0)
if [ "$__WFH_HAS_HC" != "1" ]; then
  echo "[wait-for-healthy] container has no healthcheck; skipping"
  exit 0
fi

while true; do
  __WFH_STATUS=$(docker inspect --format '{{.State.Health.Status}}' "$__WFH_CONTAINER" 2>/dev/null || echo missing)
  case "$__WFH_STATUS" in
    healthy)   echo "[wait-for-healthy] container healthy"; exit 0 ;;
    unhealthy) echo "[wait-for-healthy] healthcheck failed"; exit 1 ;;
    starting)  ;; # keep polling
    *)         echo "[wait-for-healthy] unexpected status: $__WFH_STATUS"; exit 1 ;;
  esac
  if [ "$(date +%s)" -ge "$__WFH_DEADLINE" ]; then
    echo "[wait-for-healthy] timeout waiting for healthy"
    exit 124
  fi
  sleep 5
done
`;
}
```

Exit-code mapping per FR-026..FR-028 is implemented in the runner's terminal-status handler:

```ts
// scripts-runner.ts terminal-status callback addition
if (exitCode === 124) {
  await db.update(scriptRuns).set({ status: "timeout",
    errorMessage: `healthcheck did not turn healthy within ${timeoutMs}ms` }).where(/*...*/);
  if (deploymentId) await db.update(deployments).set({ status: "failed",
    errorMessage: "healthcheck did not turn healthy" }).where(/*...*/);
} else if (exitCode === 1 && /healthcheck failed/.test(lastLogLine)) {
  await db.update(scriptRuns).set({ status: "failed",
    errorMessage: "healthcheck reported unhealthy during startup" }).where(/*...*/);
  // ... etc
}
```

Telegram for `waitForHealthy: true` failures fires through the existing `notifier.notify({ event: "Deploy Failed!" })` path with `details` extended to include the healthcheck reason — no new event type needed for this (vs. the ongoing-health-state-change events which DO need new types).

### Probe pause coordination via `deploy_locks`

FR-011 requires the per-app probe cycle to skip while a deploy is active. The interlock is read-only — the probe loop never acquires the lock, just reads its row:

```ts
const locked = await db.select().from(deployLocks).where(eq(deployLocks.appId, app.id));
if (locked.length > 0) return; // skip this tick
```

Reading the row is safe to do alongside the deploy holding the advisory lock — Postgres advisory locks don't gate row reads. R-010 covers the reverse direction (deploy never blocks on probes; probes never block on deploys).

The `caddy_admin` probe is per-server and ignores the per-app lock — Caddy reachability is independent of which app is deploying.

### UI: per-app status dot + tooltip + sparkline + Check Now

`AppHealthDot.tsx` is the reusable indicator. It reads from `useAppHealth(appId)` which combines:

1. `react-query` initial fetch from `GET /api/applications/:id/health` (current state + last 50 probes).
2. WebSocket subscription to `app-health:<appId>` channel — every state change pushed via `channelManager.broadcast` invalidates the react-query cache.

```tsx
const COLORS = { healthy: "bg-green-500", unhealthy: "bg-red-500",
                 unknown: "bg-gray-500", checking: "bg-yellow-500" };
function AppHealthDot({ appId }: { appId: string }) {
  const { data } = useAppHealth(appId);
  const cls = COLORS[data?.status ?? "unknown"];
  return (
    <Tooltip content={<HealthTooltip data={data} />}>
      <span className={`inline-block w-2.5 h-2.5 rounded-full ${cls}`} />
    </Tooltip>
  );
}
```

`AppHealthSparkline.tsx` renders the last 24h of probe rows as up/down ticks. Raw probes — no aggregation needed (1440 probe rows max per app per 24h, see R-008). SVG-only, no chart library.

`CheckNowButton.tsx` posts to `/api/applications/:id/health/check-now` and waits for the WS event — UI re-renders within the 15s budget (FR-023).

### Apps list re-poll OR WS subscription — pick one

Per FR-020 the choice is implementation discretion. We pick **WebSocket subscription** (R-006). The existing `channelManager` already serves `health:<serverId>` to `HealthPanel.tsx`; adding `app-health:<appId>` is two lines. Polling every 30s on the apps list would re-trigger N round-trips per server every 30s with N=apps-on-server, scaling O(servers × apps) with no real-time benefit. WS subscription is O(1) push per state change.

The Apps tab subscribes once to `server-apps-health:<serverId>` — a server-fan-out channel that `app-health-poller.ts` ALSO publishes to whenever any app on that server transitions. Single subscribe per Apps tab, no per-app subscriptions in the list view. The detail view subscribes to `app-health:<appId>` for finer-grained events (sparkline updates, probe-by-probe).

## Migration plan

`devops-app/server/db/migrations/0007_app_health_monitoring.sql`. Single file. Atomic. No backfill of `health_status` — existing apps default to `unknown` and converge on first probe (FR-008 says `unknown → healthy` is silent, so no alert spam at rollout).

```sql
-- Feature 006: per-app health monitoring + cert/Caddy probes.
-- ADDITIVE migration: 8 new columns on applications + new app_health_probes table.
-- No backfill — health_status defaults to 'unknown', converges on first probe cycle.

ALTER TABLE "applications"
  ADD COLUMN "health_url"                  TEXT,
  ADD COLUMN "health_status"               TEXT NOT NULL DEFAULT 'unknown',
  ADD COLUMN "health_checked_at"           TEXT,
  ADD COLUMN "health_last_change_at"       TEXT,
  ADD COLUMN "health_message"              TEXT,
  ADD COLUMN "health_probe_interval_sec"   INTEGER NOT NULL DEFAULT 60,
  ADD COLUMN "health_debounce_count"       INTEGER NOT NULL DEFAULT 2,
  ADD COLUMN "monitoring_enabled"          BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN "alerts_muted"                BOOLEAN NOT NULL DEFAULT FALSE;

-- Lower-bound guard for FR-002 (10s minimum). DB-level guard is cheap.
ALTER TABLE "applications" ADD CONSTRAINT "applications_health_probe_interval_min"
  CHECK ("health_probe_interval_sec" >= 10);
ALTER TABLE "applications" ADD CONSTRAINT "applications_health_debounce_min"
  CHECK ("health_debounce_count" >= 1);

CREATE TABLE "app_health_probes" (
  "id"                TEXT PRIMARY KEY,
  "app_id"            TEXT NOT NULL REFERENCES "applications"("id") ON DELETE CASCADE,
  "probed_at"         TEXT NOT NULL,
  "probe_type"        TEXT NOT NULL,                  -- container | http | cert_expiry | caddy_admin
  "outcome"           TEXT NOT NULL,                  -- healthy | unhealthy | error | warning
  "latency_ms"        INTEGER,
  "status_code"       INTEGER,
  "error_message"     TEXT,
  "container_status"  TEXT
);

CREATE INDEX "idx_app_health_probes_app_probed"
  ON "app_health_probes" ("app_id", "probed_at" DESC);
CREATE INDEX "idx_app_health_probes_type_outcome"
  ON "app_health_probes" ("app_id", "probe_type", "outcome");
CREATE INDEX "idx_app_health_probes_probed"
  ON "app_health_probes" ("probed_at" DESC);
```

Retention prune mirrors feature 005's pattern: `appHealthPoller.pruneOldProbes()` runs at startup AND on a 24h `setInterval(...).unref()` timer. Default retention `HEALTH_PROBE_RETENTION_DAYS=30`. Prune SQL:

```sql
DELETE FROM app_health_probes WHERE probed_at::timestamptz < NOW() - INTERVAL '30 days';
```

The `caddy_admin` probe is per-server but persisted into the same `app_health_probes` table with `app_id` = a sentinel server-scoped row OR — preferable — a `NULL` app_id with a separate `server_id` column. Decision: per-spec FR-006b reads "per server (not per app)", so we add a NULLABLE `server_id` column AND make `app_id` NULLABLE. Constraint: exactly one of `app_id`/`server_id` non-null. Updating the migration:

```sql
-- Inside CREATE TABLE app_health_probes, replace the app_id NOT NULL with:
"app_id"            TEXT REFERENCES "applications"("id") ON DELETE CASCADE,
"server_id"         TEXT REFERENCES "servers"("id")      ON DELETE CASCADE,
-- And add:
CONSTRAINT "app_health_probes_subject_xor"
  CHECK ((app_id IS NOT NULL AND server_id IS NULL) OR
         (app_id IS NULL AND server_id IS NOT NULL))
```

Indices update accordingly (one for `(server_id, probed_at desc)`).

## Constitution / guardrails check

No `.specify/memory/constitution.md`. Applying CLAUDE.md AI-Generated Code Guardrails:

| Anti-Pattern | This Feature's Stance |
|---|---|
| `process.env.X \|\| "fallback"` | NEVER. `HEALTH_PROBE_RETENTION_DAYS` read via existing `env.ts` helper that throws on missing-with-no-default; default `30` is the documented baseline, not a silent fallback. |
| `as any` | NEVER. New types: `ProbeOutcome`, `AppPollState`, `HealthOutcome`, `WaitForHealthyManifestExtension`. |
| `throw new Error()` | Use `AppError.badRequest()` / typed error classes (`HealthProbeError`, `CertExpiryError`). |
| `console.log()` | NEVER. Existing `notifier.ts` uses `console.log` (`notifier.ts:23,44,52`); this feature flips them to `logger.info`/`logger.warn` as part of the notifier extension. |
| `catch (e) { }` | NEVER. All catches log via `logger.warn({ ctx, err })` and re-throw OR explicitly swallow with a comment. |
| `dangerouslySetInnerHTML` | NEVER. Tooltip content is plain text + spans. |
| `req.body.field` without Zod | NEVER. All four new routes use `z.object({...}).parse(req.body)`. |
| Unconditional bypass | N/A. |

Standing Orders:

| Principle | Status | Note |
|---|---|---|
| No commits/pushes without request | OK — plan only |
| No new packages without approval | OK — zero new deps; uses Node native `tls`, `fetch`, `AbortController` |
| No `--force` / bypass flags | OK — N/A |
| No secrets in code/logs | OK — no secrets in this feature; alerts go via existing notifier (TELEGRAM_BOT_TOKEN already redacted in pino config) |
| No direct DB migrations | OK — `0007_app_health_monitoring.sql` shipped for review |
| No destructive ops without consent | OK — ADD COLUMN + CREATE TABLE additive only; no DROP, no UPDATE |
| Plan-first if >3 files changed | OK — 25+ files listed |
| Check context7 before unfamiliar API | Node `tls.connect`, `fetch+AbortController`, ssh2 `forwardOut` are all well-documented in existing codebase usage; no context7 round-trip needed |

**Stop conditions** (CLAUDE.md): change touches >3 files (plan presented), ≥2 valid approaches for live UI updates (R-006 documents trade-off), no public API rename. Proceed.

## Complexity Tracking

| Addition | Why Needed | Simpler Alternative Rejected |
|---|---|---|
| Separate `app-health-poller.ts` (vs. extending `health-poller.ts`) | Per-server CPU/mem polling and per-app probe scheduling have different cadence and different keying — one keys by serverId, the other by appId. Single class would multiplex two state machines and complicate `stopPolling(serverId)` semantics. | Extending `health-poller.ts` — bloats one class to 500+ lines, conflates server/app concerns. |
| 4 separate probe runners in `probes/` directory | Each transport is genuinely different (SSH exec, Node fetch, Node tls, SSH-tunnel + fetch). One file per is ~50 lines; one mega-runner with switch is harder to test and to extend with a 5th probe in v2. | One `runProbe(type, app)` switch — fails the single-responsibility test; mocking per-type in tests becomes awkward. |
| Sparkline reads raw probes (no aggregation table) | 1440 rows max per app per 24h × 8 byte-int per row ≈ trivial. Aggregation is premature optimisation until SC-004's 3% CPU is exceeded. | Hourly summary table — extra writes, extra prune logic, no observable benefit at v1 scale (10–50 apps). |
| WS subscription for live UI (FR-020 implementation choice) | Push-based scales O(1) per change, polling scales O(servers × apps × 30s tick). Existing `channelManager` already sustains `health:<serverId>` channels. | 30s polling — wastes round-trips, breaks the "instant" UX target of SC-001. |
| `app_health_probes` with XOR(app_id, server_id) | `caddy_admin` probes are per-server, not per-app; a single table with discriminating columns avoids a second `server_health_probes` table that would duplicate the index pattern. | Two tables — DRY violation, two prune jobs, two retention envs. |
| Probe-cycle reads `deploy_locks` row (vs. acquires advisory lock) | Reading is non-blocking, doesn't contend with the deploy itself; FR-011 only requires the probe to KNOW about the deploy, not coordinate. | Probe acquires advisory lock — would gate deploys behind probe cycles, defeating the point. |
| `tls.connect` (vs. `openssl s_client` shellout per spec example) | Native, no shell escape concerns, no fork overhead per probe, structured peerCertificate object. The spec wrote `openssl` as a syntactic example — Node native is the implementation that matches "MUST … TLS handshake … parses notAfter" (FR-006a). | `child_process.exec("openssl s_client ...")` — slow, fragile parsing of multi-line output, no structured error surface. |
| `health_status` written ONLY on commit (vs. on every probe) | Mirrors the spec's wording: "current effective health state MUST be denormalised onto the applications row" + "MUST NOT transition out of HEALTHY without 2 consecutive". `health_checked_at` updates every probe (freshness), `health_status` only on commit (correctness). | Write `health_status` on every probe — UI flickers between healthy/unhealthy on transient blips; `health_last_change_at` becomes meaningless. |

## Out of Plan

Mirrors spec § Out of Scope:

- Monitoring the dashboard itself (uptime-kuma external).
- Email / PagerDuty / Slack — only Telegram via existing notifier.
- Removing unhealthy apps from a load balancer (no routing in this dashboard).
- Synthetic user flows / multi-step probes.
- Per-probe retry policies beyond debounce.
- Prometheus/OTel metrics export.
- Replacing uptime-kuma on target hosts.
- Multi-app-per-container (one container = many app rows) — A-002.
- Aggregate hourly probe summary (R-008 — v2 if A-005 storage projection is exceeded).
- Configurable Caddy admin port (always `127.0.0.1:2019` per feature 008 FR-028).

## Post-design Constitution Re-check

| Principle | Re-check | Note |
|---|---|---|
| No commits/pushes without request | OK | Plan only |
| No new packages | OK | Native Node only |
| No secrets in code/logs | OK | Existing redact paths cover token-bearing flows |
| Plan-first >3 files | OK | 25+ files |
| No destructive ops without consent | OK | Additive migration |
| No raw SQL string interpolation | OK | All queries via Drizzle or `postgres` tagged templates |
| No `any`, no `console.log` | OK | Plan calls out the `notifier.ts` console.log → logger flip |
| Probe loop crash-safety | OK | All catches swallow + log + reschedule next tick (mirrors `health-poller.ts` pattern) |

Proceed to `/speckit.tasks`.
