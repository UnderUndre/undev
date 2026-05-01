# Tasks: Application Health Monitoring & Post-Deploy Verification

**Input**: Design documents from `/specs/006-app-health-monitoring/`
**Prerequisites**: spec.md (v1.0 + Session 2026-04-22 + Session 2026-04-28 cert_expiry/caddy_admin extension), plan.md, research.md (R-001..R-013), data-model.md, contracts/api.md, quickstart.md
**Coding standards**: `.github/instructions/coding/copilot-instructions.md` — Zod validation at every route boundary, structured error handling (`AppError.*` / typed error classes), typed I/O (no `as any`), parameterized queries via Drizzle / `postgres` tagged-templates, no `console.log` (use `logger.{info|warn|error}({ ctx }, msg)`), no `dangerouslySetInnerHTML`.

**Tests**: Yes — unit per probe runner + state-machine + bash-tail builder + cert window dedup; integration per user story. TDD-Lite: tests land alongside implementation.

**Organization**: 4 user stories with implementation phases (US1..US4). US5 (external uptime monitor for the dashboard itself) is doc-only and lives in Phase 7 Polish per spec § "out-of-tooling".

## Format: `[ID] [AGENT] [Story?] Description`

## Agent Tags

| Tag | Agent | Domain |
|-----|-------|--------|
| `[SETUP]` | — (orchestrator) | Shared schema / manifest / prune-job hook edits |
| `[DB]` | database-architect | Drizzle schema + migration `0007_app_health_monitoring.sql` |
| `[BE]` | backend-specialist | Probe scheduler, runners, notifier, routes, scripts-runner extension |
| `[FE]` | frontend-specialist | React components (HealthDot, sparkline, Check Now, form fields), hooks |
| `[OPS]` | devops-engineer | Bash tail injected by `scripts/deploy/server-deploy.sh` runner extension |
| `[E2E]` | test-engineer | Cross-domain integration tests (poller × deploy interlock × routes × WS) |
| `[SEC]` | security-auditor | FR-029/030/031 audit + cert/Caddy attack-surface review |

## Task Statuses

| Status | Meaning |
|--------|---------|
| `- [ ]` | Pending |
| `- [→]` | In progress |
| `- [X]` | Completed |
| `- [!]` | Failed |
| `- [~]` | Blocked |

## Path Conventions

All paths relative to repo root (`undev/`). Server code under `devops-app/server/`, client under `devops-app/client/`, tests under `devops-app/tests/`. Bash injection emitted by `scripts-runner.ts` lives in `devops-app/server/services/build-health-check-tail.ts` (not a separate shell file — heredoc-built and concatenated to the transported script per R-009).

---

## Phase 1: Setup

**Purpose**: Land migration `0007_app_health_monitoring.sql` (8 columns on `applications` + `app_health_probes` table with XOR(app_id, server_id) constraint), extend the manifest entry type for `waitForHealthy` / `healthyTimeoutMs`, and register the retention prune hook so probes can persist with a documented eviction policy. Sync barrier — every later phase depends on this.

- [X] T001 [DB] [SETUP] Extend `devops-app/server/db/schema.ts` `applications` table with the 8 health columns per data-model.md (`healthUrl: text`, `healthStatus: text notNull default('unknown')`, `healthCheckedAt: text`, `healthLastChangeAt: text`, `healthMessage: text`, `healthProbeIntervalSec: integer notNull default(60)`, `healthDebounceCount: integer notNull default(2)`, `monitoringEnabled: boolean notNull default(true)`, `alertsMuted: boolean notNull default(false)`). Drizzle typed columns only, no `as any`. Add `appHealthProbes` table fragment with nullable `appId` / `serverId` FKs (`onDelete: 'cascade'`) and four named indexes per data-model.md §Drizzle schema fragment.
- [X] T002 [DB] [SETUP] Create migration `devops-app/server/db/migrations/0007_app_health_monitoring.sql` per data-model.md §DDL — atomic ALTER TABLE applications + CREATE TABLE app_health_probes + 4 indexes + XOR CHECK constraint `app_health_probes_subject_xor` + lower-bound CHECKs `applications_health_probe_interval_min` (≥10) and `applications_health_debounce_min` (≥1) per FR-002 / FR-007. Include header comment with DOWN migration commented out (destructive — operator-gated). Append journal entry `{ idx: 7, tag: "0007_app_health_monitoring", when: <epoch-ms>, breakpoints: true }` to `devops-app/server/db/migrations/meta/_journal.json`. Admin applies manually on release per CLAUDE.md rule 5.
- [X] T003 [BE] [SETUP] Extend `devops-app/server/scripts-manifest.ts` `ScriptManifestEntry<TParams>` type with two optional entry-level fields per contracts/api.md §Manifest extension contract: `waitForHealthy?: boolean` (default false at runtime), `healthyTimeoutMs?: number` (default 180_000 at runtime). Apply `waitForHealthy: true, healthyTimeoutMs: 180_000` to the existing `deploy/server-deploy` entry per quickstart Scenario 3. Update the `getManifestDescriptor()` shape (and its Zod descriptor) to surface both fields when present — feature 005 RunDialog reads them. No `as any`, structured types only.
- [X] T004 [BE] [SETUP] Extend `devops-app/tests/unit/scripts-manifest.test.ts` with assertions: (a) `validateManifestLenient()` passes with the new fields on `deploy/server-deploy`; (b) `getManifestDescriptor()` includes `waitForHealthy` and `healthyTimeoutMs` for that entry; (c) entries WITHOUT the fields validate unchanged (backward-compat). TDD-Lite: lands with T003.
- [X] T005 [BE] [SETUP] Register the retention prune hook in `devops-app/server/services/app-health-poller.ts` startup path: read `HEALTH_PROBE_RETENTION_DAYS` env (no `||` fallback per CLAUDE.md guardrails — invalid value warns and skips, default `30` applied via parsed-int when env absent), prune at startup before HTTP listen, then schedule `setInterval(24 * 3600 * 1000).unref()`. Mirrors feature 005 `script_runs` prune pattern. Parameterized DELETE via Drizzle `sql` template — no raw SQL string interpolation. Structured logger `{ ctx: "app-health-prune" }`.

**Checkpoint**: Schema field exists in Drizzle; migration file reviewable; manifest type extended; retention hook scaffolded. Foundational lane can fork.

---

## Phase 2: Foundational (Probe Scheduler + Runners + State Machine + Notifier Events)

**Purpose**: Build the probe scheduler skeleton, four probe runners (container, http, cert_expiry, caddy_admin), the state-machine + debounce commit logic, and the three new notifier event types. Every user-story phase blocks on this phase completing. Sync barrier.

### Probe scheduler skeleton

- [X] T006 [BE] Create `devops-app/server/services/app-health-poller.ts` with the `AppHealthPoller` class skeleton per plan.md §Probe loop architecture: `start()`, `stop()`, `reloadApp(appId)`, `runOutOfCycleProbe(appId)`, `pruneOldProbes()`. Three internal Maps: `appPolls: Map<string, AppPollState>` (app cycle), `serverCaddyPolls: Map<string, CaddyPollState>` (per-server Caddy cycle), `dailyCertTimer: NodeJS.Timeout | null` (single daily sweep). Recursive `setTimeout` chain mirrors `health-poller.ts:149` (R-001). Overlap guard via `state.isPolling`. Cancellation via `appPolls.delete(appId) + clearTimeout`. Typed I/O — no `as any`. Wire single `appHealthPoller` singleton export.
- [X] T007 [BE] Implement FR-011 deploy-lock interlock in `app-health-poller.ts` per plan.md + R-010: at the start of every per-app tick, `SELECT app_id FROM deploy_locks WHERE app_id = $1` via Drizzle parameterized — if a row exists, log at debug `{ ctx: "app-health", appId }` and reschedule the tick. Probe NEVER acquires the lock. Caddy probe (per-server) ignores per-app locks. Unit test `devops-app/tests/unit/app-health-poller-deploy-lock.test.ts` mocks the deploy_locks query with row present / absent and asserts the runner functions are not called when locked.

### Probe runners — `probes/*.ts`

- [X] T008 [BE] Create `devops-app/server/services/probes/container.ts` per plan.md §Probe runners — Container. Exports `runContainerProbe(app: AppRow): Promise<ProbeOutcome>`. Uses existing `sshPool.exec(serverId, cmd)` with `docker inspect --format '{{.State.Health.Status}}' <name> 2>/dev/null || echo no-container`. Parses verbatim status into `containerStatus`. FR-031 — no root required. `deriveContainerName(app)` helper documents `<project>-<service>-1` default with `-1` fallback (FR-003). Typed `ProbeOutcome` shape (no `as any`); uses `shQuote` from `lib/sh-quote.ts`. Unit test `devops-app/tests/unit/probes-container.test.ts` covers: healthy / unhealthy / starting / no-container / unknown-status branches + `deriveContainerName` defaults + override + path-with-dashes regression.
- [X] T009 [BE] Create `devops-app/server/services/probes/http.ts` per plan.md §Probe runners — HTTP. Exports `runHttpProbe(app: AppRow): Promise<ProbeOutcome>`. Native `fetch` + `AbortController` 10s timeout (FR-004), `redirect: "manual"` (FR-029 — no cross-host), header `User-Agent: devops-dashboard-probe/1.0` (FR-030). FR-005 classification: 2xx/3xx → healthy, 4xx/5xx → unhealthy, AbortError → `error` with `"timeout after 10s"`, other → `error` with the system error message. No retries (debounce IS the retry policy). Typed I/O. Unit test `devops-app/tests/unit/probes-http.test.ts` covers ≥ 12 cases: 200 / 204 / 301 (manual — recorded as healthy) / 302 / 400 / 404 / 500 / 503 / timeout / DNS error / TCP refused / TLS error.
- [X] T010 [BE] Create `devops-app/server/services/probes/cert-expiry.ts` per plan.md §Probe runners — TLS expiry. Exports `runCertExpiryProbe(app: AppRow): Promise<ProbeOutcome>`. Uses Node native `tls.connect` (R-004 — NOT `openssl s_client` shellout). `rejectUnauthorized: false` to read expired/self-signed certs. Reads `getPeerCertificate(false).valid_to`, parses to `Date`. FR-006a thresholds: `>14d → healthy`, `<7d → unhealthy`, otherwise `warning`. **Cross-spec write to feature-008-owned `app_certs` table** (acknowledged write boundary — table schema owned by 008): UPDATE `expires_at = parsedNotAfter` always on success, UPDATE `last_renew_at = now()` **ONLY when `parsedNotAfter` is strictly later than the previously-stored `expires_at`** (FR-006a — forward-moving expiry is the only reliable signal that Caddy auto-renewal succeeded; otherwise `last_renew_at` MUST NOT be touched). All writes via Drizzle parameterized — no raw SQL. Failed handshake records `outcome: error` with the failure reason; does NOT update `expires_at`; does NOT alert (per FR-006a edge case). Outcome MUST NOT influence the app's overall HEALTHY/UNHEALTHY state — separate alert track. Unit test `devops-app/tests/unit/probes-cert-expiry.test.ts` covers ≥ 10 cases: window classification (30/14/13/7/3/1 daysLeft), forward-moving notAfter triggers `last_renew_at` update, identical/earlier notAfter does NOT touch `last_renew_at` (FR-006a strict-later guard), handshake error path skips writes, missing `valid_to`, expired-cert handshake-still-succeeds.
- [X] T011 [BE] Create `devops-app/server/services/probes/caddy-admin.ts` per plan.md §Probe runners — Caddy admin. Exports `runCaddyAdminProbe(server: ServerRow): Promise<ProbeOutcome>`. Per FR-006b + R-005: opens short-lived SSH tunnel to remote `127.0.0.1:2019` via new `sshPool.openTunnel(serverId, { remoteHost, remotePort })` wrapper over `ssh2` `forwardOut`. GET `http://127.0.0.1:<localPort>/config/` with 5s `AbortController`. HTTP 200 → healthy, otherwise unhealthy with `statusCode`. Tunnel always closed in `finally`. Per-server (R-013), NOT per-app. Persists into `app_health_probes` with `server_id` non-null and `app_id` NULL (XOR constraint). Unit test `devops-app/tests/unit/probes-caddy-admin.test.ts` covers: 200 → healthy, 401/500 → unhealthy with statusCode, ECONNREFUSED → error, tunnel-open failure → error, tunnel always closed even on fetch throw.
- [X] T012 [BE] Add `openTunnel(serverId, { remoteHost, remotePort })` method to `devops-app/server/services/ssh-pool.ts`. Thin wrapper over `ssh2` `Client.forwardOut`. Returns `{ localPort: number; close(): void }`. Reuses existing pool connection — same auth, no new credentials. ~20 lines per R-005. Unit test asserts pool reuse + close cleans up the local server. No `as any`.

### State machine + debounce + persistence

- [X] T013 [BE] Implement `commitState(app, newOutcome, c, h)` and `persistProbes(appId, outcomes)` in `app-health-poller.ts` per plan.md §state machine. FR-007 debounce — 2 consecutive same-state probes (configurable via `app.healthDebounceCount`, min 1). FR-008: `unknown → healthy` silent. FR-009 / FR-010: `healthy ↔ unhealthy` fires alerts. FR-013 + R-011: `health_checked_at` and `health_message` UPDATE on every probe (freshness); `health_status` and `health_last_change_at` UPDATE ONLY on transition commit (correctness). Compute downtime as `now - health_last_change_at` snapshotted before the commit write. Insert each `ProbeOutcome` into `app_health_probes` with appropriate `app_id` / `server_id` per XOR constraint. All writes via Drizzle parameterized.
- [~] T014 [BE] Write unit test `devops-app/tests/unit/app-health-state-machine.test.ts` covering ≥ 14 cases per plan.md §Worked example: (a) initial `unknown → healthy` is silent (FR-008); (b) flap `healthy → unhealthy → healthy` below debounce does NOT commit; (c) 2 consecutive unhealthy commits + fires alert; (d) recovery: 2 consecutive healthy after unhealthy commits + fires recovery alert with correct downtime calc; (e) `alertsMuted: true` skips Telegram but commits state and broadcasts WS (FR-018); (f) `monitoringEnabled` flipped to false mid-cycle exits the loop on next tick; (g) custom `healthDebounceCount: 1` commits on single probe; (h) FR-006 effective-outcome computation across container + http (any unhealthy → unhealthy; all healthy → healthy; no probe yet → unknown); (i) cert_expiry probe outcome does NOT influence overall state per FR-006a.

### Notifier event types

- [X] T015 [BE] Extend `devops-app/server/services/notifier.ts` with three new event-type formatters per plan.md §Notifier integration: `notifyAppHealthChange(app, server, transition: "to-unhealthy"|"to-healthy", { reason?, downtimeMs? })`, `notifyCertExpiring(app, cert, daysLeft, windowDays)`, `notifyCaddyUnreachable(server, lastSuccessAgo)`, `notifyCaddyRecovered(server, downtimeMs)`. Payload shape per User Story 2 + FR-015a + FR-015b. Includes deep-link `[Open](<dashboard-url>/apps/<id>)` per FR-016. **Flip existing `console.log`/`console.error` calls (`notifier.ts:23,44,52`) to `logger.info`/`logger.warn`** per CLAUDE.md guardrails as part of this edit. Notifier failures swallowed at `warn` level per FR-017 — never crash the probe loop. Same Telegram bot/chat (no new env). Typed I/O.
- [X] T016 [BE] **FR-018 alert-pipeline contract**: in `commitState`, gate Telegram dispatch behind `if (!app.alertsMuted)` BUT ALWAYS execute `channelManager.broadcast` for WS events and ALWAYS write `health_status` + `health_last_change_at` on commit. Mute is a notification-channel filter — UI continues to update on muted apps (status dot, tooltip, sparkline, `app.health-changed` WS event) per FR-018 explicit clarification. Document this contract in a code comment referencing FR-018. Unit test in T014 case (e) asserts the asymmetry.

**Checkpoint**: Scheduler runs; four probe runners produce typed `ProbeOutcome`; state machine commits with debounce; FR-011 deploy-lock interlock honoured; notifier handles three new event types with logger flip; FR-018 mute-vs-track asymmetry verified. User-story lanes can fork.

---

## Phase 3: User Story 1 — Per-app health indicator at a glance (Priority: P1)

**Goal**: Operator sees coloured dot per app in Apps list, hover tooltip shows last probe detail, server row aggregates `N/M apps healthy`, app detail view shows last 50 probes as 24h sparkline (US1, FR-019..FR-021, FR-023, SC-001).

**Independent Test**: Seed two apps on one server — one healthy, one unhealthy. Apps list shows green + red dots. Server row shows amber tint + `1/2 healthy`. Open the unhealthy app's detail — sparkline renders 24h of probe ticks; tooltip on dot shows last probe time / latency / status code / error message.

### Backend — endpoints + WebSocket channels

- [X] T017 [BE] [US1] Create `devops-app/server/routes/health.ts` (or extend existing) with `GET /api/applications/:id/health` per contracts/api.md. Auth via `requireAuth` + audit middleware. Zod-validate `:id` (`z.string().uuid()`). Returns 200 with `{ appId, status, checkedAt, lastChangeAt, message, config: { healthUrl, intervalSec, debounceCount, monitoringEnabled, alertsMuted }, probes: [...up to 50 most recent ordered DESC] }` per Q2 of data-model.md. 404 `APP_NOT_FOUND` via `AppError.notFound()` when app missing. Drizzle parameterized queries. No `as any`, no `console.log`.
- [X] T018 [BE] [US1] Add `GET /api/applications/:id/health/history?since&until&limit&probeType` per contracts/api.md. Zod-validate query params: `since` / `until` ISO 8601 with defaults `now - 24h` / `now`, `limit` int 1..10000 default 1500, `probeType` enum `container | http | cert_expiry | caddy_admin` optional. Returns slim payload (omits `errorMessage` / `containerStatus` for sparkline-render speed) ordered ASC. Drizzle parameterized.
- [X] T019 [BE] [US1] Extend `GET /api/apps/:id` and `GET /api/apps` response shapes in `devops-app/server/routes/apps.ts` to include the 8 new health columns (always present, may be NULL) per contracts/api.md §Modified endpoints. Backward-compatible additive. Audit middleware unchanged — fields are non-secret.
- [X] T020 [BE] [US1] Wire WS broadcasts in `commitState` (T013) and per-tick probe completion: publish `app-health:<appId>` channel with `{ type: "probe-completed", data: {...} }` on every probe (sparkline live updates) and `{ type: "health-changed", data: { from, to, at, reason } }` on commits per contracts/api.md. Also fan-out `server-apps-health:<serverId>` on commits ONLY (apps-list update rate sane, R-006). Reuses existing `channelManager.broadcast(channel, payload)`. Integration test `devops-app/tests/integration/app-health-ws-events.test.ts` asserts both channels fire with expected payload shapes.
- [X] T021 [BE] [US1] Write integration test `devops-app/tests/integration/health-routes.test.ts` against mocked `postgres`: (a) GET /health returns current state + probes; (b) probes ordered DESC limit 50; (c) GET /history with default window returns 24h ASC; (d) GET /history with `probeType=cert_expiry` filter; (e) 404 on unknown id; (f) 401 without auth; (g) audit_entries captures GETs.

### Frontend — dot, tooltip, sparkline, hooks

- [X] T022 [FE] [US1] Create `devops-app/client/hooks/useAppHealth.ts` per plan.md §UI: combines `react-query` initial fetch from `GET /api/applications/:id/health` with WS subscription to `app-health:<appId>` (invalidates the query cache on each event). Typed return shape `{ status, checkedAt, lastChangeAt, message, probes }`. No `as any`.
- [X] T023 [FE] [US1] Create `devops-app/client/components/apps/HealthDot.tsx` per plan.md §UI. Reads `useAppHealth(appId)`. Tailwind class map: healthy → `bg-green-500`, unhealthy → `bg-red-500`, unknown → `bg-gray-500`, checking → `bg-yellow-500`. Wraps in existing Tooltip primitive showing `HealthTooltip` with last probe time, latency, status code (HTTP), container status, error message. `role='img'` + textual `aria-label` for screen readers. NO `dangerouslySetInnerHTML`.
- [X] T024 [FE] [US1] Create `devops-app/client/components/apps/HealthSparkline.tsx` per plan.md §UI + R-008. Reads `GET /api/applications/:id/health/history` (24h, ASC). Renders inline SVG — one tick per probe row, colour-coded by outcome. NO chart library, NO `dangerouslySetInnerHTML`. Accessible: `role='img'` + textual `aria-label` summarising "24h health timeline: N healthy, M unhealthy, K unknown". Handles empty state ("No probe history yet — check back in 60s") without crashing.
- [X] T025 [FE] [US1] Modify `devops-app/client/pages/ServerPage.tsx` Apps tab to render `<HealthDot appId={a.id} />` before each app name. Subscribe ONCE to `server-apps-health:<serverId>` channel per render (single subscribe, not per-app — R-006). Aggregate `N/M healthy` from the apps list and tint the server row amber when any app is unhealthy. Integration test `devops-app/tests/integration/apps-list-health-aggregate.test.ts` covers the aggregate text + amber tint conditions.
- [X] T026 [FE] [US1] Modify `devops-app/client/components/apps/ApplicationDetail.tsx` to render Health section: large `<HealthDot>` + last-checked timestamp + message + `<HealthSparkline>`. Resolves FR-021 24h timeline.

**Checkpoint**: US-1 independently testable. Operator sees coloured dot per app; hover shows detail; server row aggregates; detail view sparkline renders 24h history; WS pushes live updates without polling.

---

## Phase 4: User Story 2 — Telegram alert on state change (Priority: P1)

**Goal**: Telegram fires on `healthy → unhealthy` and `unhealthy → healthy` (with downtime), respects `alertsMuted` (UI continues, only Telegram skipped), debounce-committed transitions only (US2, FR-009, FR-010, FR-015, FR-018, SC-002).

**Independent Test**: Force a healthy app to fail container probe twice in succession — Telegram fires unhealthy alert with deep link. Force healthy again twice — recovery alert fires with correct downtime. Set `alertsMuted=true`, repeat — UI dot still flips colour, sparkline updates, but no Telegram is sent.

- [X] T027 [BE] [US2] Wire `notifier.notifyAppHealthChange` calls into `commitState` per plan.md state-machine pseudocode + FR-009/FR-010. `to-unhealthy` payload: `*${app.name}*\nServer: ${server.label}\nReason: ${details.reason}\n[Open](${deepLink})`. `to-healthy` payload includes `Downtime: ${formatDuration(downtimeMs)}`. Snapshot `health_last_change_at` BEFORE the commit UPDATE so downtime is correct. Per FR-018 contract from T016: gate ONLY the Telegram call behind `!app.alertsMuted`; UI broadcasts and DB writes proceed unconditionally.
- [X] T028 [BE] [US2] Integration test `devops-app/tests/integration/health-alert-pipeline.test.ts` against mocked notifier + `postgres`: (a) `healthy → unhealthy` after debounce fires `notifyAppHealthChange("to-unhealthy", ...)` exactly once; (b) `unhealthy → healthy` fires `notifyAppHealthChange("to-healthy", ...)` with `downtimeMs` matching `now - prevHealthLastChangeAt`; (c) `unknown → healthy` does NOT fire (FR-008); (d) flapping below debounce does NOT fire; (e) `alertsMuted=true` — notifier NOT called BUT WS broadcast called AND `health_status` UPDATE happened (FR-018 explicit asymmetry); (f) notifier throw caught at `warn` log — probe loop continues (FR-017).
- [X] T029 [BE] [US2] Wire `notifier.notifyCaddyUnreachable` and `notifyCaddyRecovered` into the per-server Caddy commit path per FR-015b. Recovery uses standard recovery wording. WS `server.caddy-unreachable` and `caddy-recovered` events fire on the per-server channel per contracts/api.md.
- [X] T030 [BE] [US2] Integration test `devops-app/tests/integration/caddy-alert-pipeline.test.ts`: (a) 2 consecutive `caddy_admin` unhealthy → commit + fire `notifyCaddyUnreachable`; (b) recovery 2 consecutive healthy → fire `notifyCaddyRecovered`; (c) cross-spec invariant — when `caddy_admin` commits unhealthy, an event/hook is exposed for feature 008's reconciler to mark `app_certs.status = 'pending_reconcile'` (test asserts the event surface; the actual marking is feature 008's responsibility). FR-015b cross-spec write boundary acknowledged.

- [X] T059 [BE] [US2] Add notifier coalescing to `devops-app/server/services/notifier.ts` for `app-health-change` events per FR-Edge "flapping rate-limit" (2026-04-28 Gemini review). Sliding 60s window keyed by `(app_id, state)`; identical payload within window collapses into one outgoing Telegram message with `+N occurrences` suffix appended to the body. Per-bot accounting (NOT per-app) to respect Telegram per-chat 1 msg/sec cap. Typed `Map<string, { firstAt: number; count: number; lastPayload: AppHealthChangePayload }>` with a `setInterval(...).unref()` cleanup sweep. Structured `logger.info({ ctx: "notifier-coalesce", appId, state, count }, "coalesced")` only — no `console.log`. No `as any`.
- [X] T060 [BE] [US2] Unit tests for notifier coalescing in `devops-app/tests/unit/notifier-coalesce.test.ts` (≥ 6 cases): (a) two identical events <60s apart → single Telegram send with `+1 occurrences` suffix; (b) events 61s apart → two distinct sends, suffix absent; (c) same `app_id` different `state` within window → two distinct sends; (d) `+N` suffix counts accurately for N=5 burst within window; (e) cleanup sweep evicts stale entries; (f) coalescing applies only to `app-health-change` — `cert-expiring` / `caddy-unreachable` payloads bypass the dedup map. Typed assertions, no `as any`.

**Checkpoint**: US-2 independently testable. Telegram fires on debounced transitions; mute filters Telegram only; recovery includes downtime; Caddy unreachable alerts the operator; FR-018 asymmetry verified end-to-end. Notifier coalesces flapping bursts so a misbehaving container can't DoS the bot channel.

---

## Phase 5: User Story 3 — Wait-for-healthy deploy gate (Priority: P1)

**Goal**: Manifest entry with `waitForHealthy: true` causes the deploy runner to append a target-side bash poll loop. Exit codes map to `script_runs.status` per FR-026..FR-028. Surfaced in deploy history (US3, FR-024..FR-028, SC-003, SC-005).

**Independent Test**: Mark `deploy/server-deploy` as `waitForHealthy: true`. Deploy a known-broken container — `script_runs.status = 'failed'`, `errorMessage = 'healthcheck reported unhealthy during startup'`, Telegram "Deploy Failed!" includes the reason. Deploy a known-healthy container — `status = 'success'` exactly as before. Deploy a container with no defined healthcheck — log line `[wait-for-healthy] container has no healthcheck; skipping`, `status = 'success'` (FR-028 silent skip).

- [X] T031 [BE] [US3] Create `devops-app/server/services/build-health-check-tail.ts` per plan.md §Wait-for-healthy gate + R-009. Pure function `buildHealthCheckTail({ container: string; timeoutMs: number }): string` returns the bash heredoc shown in plan.md — `__WFH_*` prefixed bash vars (no collisions), FR-028 silent-skip branch via `{{if .State.Health}}1{{else}}0{{end}}`, 5s `sleep` polling per FR-025, exit codes 0 / 1 / 124 (matches GNU `timeout` convention). Uses `shQuote` from `lib/sh-quote.ts` for the container name. No `as any`, no string-template SQL — pure bash text.
- [X] T032 [BE] [US3] Unit test `devops-app/tests/unit/build-health-check-tail.test.ts` (≥ 12 cases): (a) baseline `__WFH_DEADLINE` math correct for `timeoutMs=180000`; (b) container name with dashes single-quoted; (c) container name with single quote escaped via `shQuote`; (d) `__WFH_HAS_HC=0` branch produces silent-skip output and `exit 0` (FR-028); (e) status `healthy` branch → `exit 0`; (f) `unhealthy` → `exit 1`; (g) `starting` → keep polling; (h) timeout → `exit 124` with the 'timeout waiting for healthy' message; (i) FR-025 5s polling cadence; (j) zero `console.log` / `dangerouslySetInnerHTML` markers in output (sanity); (k) heredoc-safe quoting against `$` injection in container name; (l) regression: starts with the `# Feature 006 wait-for-healthy gate` comment header.
- [X] T033 [OPS] [US3] Extend `devops-app/server/services/scripts-runner.ts` `runScript` to: (a) read `entry.waitForHealthy` + `entry.healthyTimeoutMs` from the manifest entry; (b) when `waitForHealthy === true`, call `buildHealthCheckTail({ container: deriveContainerName(app), timeoutMs: entry.healthyTimeoutMs ?? 180_000 })` and concatenate to the transported script buffer per plan.md `[commonShPreamble, commonShBody, "", targetScript, "", tail].join("\n")`; (c) pipe the augmented buffer to `bash -s` over SSH via the existing `executeWithStdin` path (feature 005's transport — unchanged). The append targets `scripts/deploy/server-deploy.sh` runs and is opt-in per manifest entry. Structured logger `{ ctx: "scripts-runner-wait-for-healthy" }`, no `console.log`.
- [X] T034 [BE] [US3] Extend `scripts-runner.ts` terminal-status handler with FR-026..FR-028 mapping per plan.md: `exitCode === 124` → `script_runs.status = 'timeout'`, `errorMessage = 'healthcheck did not turn healthy within ${timeoutMs}ms'`, link `deployments.status = 'failed'`; `exitCode === 1` AND last log line matches `/healthcheck failed/` or `/healthcheck reported unhealthy/` → `status = 'failed'`, `errorMessage = 'healthcheck reported unhealthy during startup'`; FR-028 silent-skip log line is `exit 0` so it lands in the existing success path with no special handling. Drizzle parameterized UPDATEs.
- [X] T035 [E2E] [US3] Integration test `devops-app/tests/integration/deploy-wait-for-healthy.test.ts` against mocked `sshPool` + `postgres`: (a) `waitForHealthy: true` + container reports healthy → `success`, deploy notifier "Deployed!" fires; (b) container reports unhealthy → `status='failed'` with the FR-027 message, "Deploy Failed!" fires with the healthcheck reason in `details`; (c) container never goes healthy in 180s → `status='timeout'` (FR-026), errorMessage with the `${timeoutMs}` interpolation; (d) container has no healthcheck stanza → silent skip `exit 0`, `status='success'`, log line captured (FR-028); (e) `waitForHealthy: false` (omitted) → no tail appended (assert via spy on `buildHealthCheckTail` NOT called); (f) **regression** — feature 005's existing `deploy/server-deploy` test passes unchanged when `waitForHealthy` field is absent. SC-003 zero-false-positive guard.
- [X] T036 [E2E] [US3] Integration test `devops-app/tests/integration/probe-pause-during-deploy.test.ts` per FR-011 + R-010: (a) seed `deploy_locks` row for `appId=X` + `serverId=S`; (b) trigger `appHealthPoller.tickApp(stateForX)` → assert no probe runner functions called, tick reschedules; (c) caddy probe for the same server STILL runs (per-server, ignores per-app lock); (d) probes for OTHER apps on the same server still run (lock is per-app); (e) lock released → next tick proceeds normally; (f) sparkline shows the gap during the pause window.

- [X] T061 [OPS] [US3] Document the deadlock-avoidance contract inline in `scripts/deploy/server-deploy.sh` (and mirror in `devops-app/server/services/build-health-check-tail.ts` header) per 2026-04-28 Gemini edge case "waitForHealthy deploy gate must NOT depend on the dashboard's probe lock". Comment block verbatim: `# waitForHealthy is a target-side bash tail using raw 'docker inspect'. It MUST NOT call back to the dashboard's Node-side probe runner. See spec 006 Edge Case "waitForHealthy deploy gate must NOT depend on the dashboard's probe lock" for rationale — a future "consolidate probe code" refactor that routes this gate through the Node probe runner reintroduces the FR-011 vs FR-024 deadlock.` Pure documentation — no behaviour change, no `as any`, no test changes.

**Checkpoint**: US-3 independently testable. Manifest opt-in, target-side bash gate, exit-code mapping, deploy history surface; FR-011 interlock works in both directions. Deadlock-avoidance hazard preserved as inline doc for future refactors.

---

## Phase 6: User Story 4 — Configure probe targets per application (Priority: P2)

**Goal**: Add/Edit Application form has Health Check URL input + Monitoring Enabled toggle + Alerts Muted toggle; app detail view has "Check Now" button that triggers an out-of-cycle probe and re-renders within 15s (US4, FR-022, FR-023, plus PATCH config endpoint).

**Independent Test**: Open Edit form, set `healthUrl=https://x.example.com/health`, save — `applications.health_url` UPDATEd. Toggle `monitoringEnabled=false` — poller stops the per-app tick. Click "Check Now" — `runOutOfCycleProbe` fires, WS event arrives within 15s, dot/sparkline re-render. Operator typing `http://169.254.169.254/...` is rejected at form submit AND at probe time (FR-029a / FR-029b SSRF gate).

### SSRF guard — block list, probe-time, form-time, body cap

- [X] T052 [BE] [US4] Create `devops-app/server/lib/ssrf-guard.ts` per FR-029a (2026-04-28 Gemini review). Typed I/O — exports `isBlockedIp(ip: string): boolean` and `validateUrlForProbe(url: string): Promise<{ ok: true } | { ok: false, code: 'private_ip' | 'invalid_url' | 'nxdomain', resolvedIps: string[] }>`. Block list: RFC 1918 (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), RFC 3927 (`169.254.0.0/16` incl. `169.254.169.254` AWS/GCP IMDS), RFC 4193 (`fc00::/7`), RFC 6890 loopback (`127.0.0.0/8`, `::1`), RFC 4291 (`fe80::/10`), and `0.0.0.0/8`. Resolves via Node `dns.resolve4` + `dns.resolve6`. **Block list applies to ALL resolved IPs**, not just the first (FR-029a multi-A-record clause). No `as any`. Unit test `devops-app/tests/unit/ssrf-guard.test.ts` covers ≥ 12 cases (each block range + happy path + multi-A with one private + IPv6 link-local + NXDOMAIN + invalid URL parse).
- [X] T053 [BE] [US4] Wire `validateUrlForProbe` into `devops-app/server/services/probes/http.ts` immediately before `fetch(url, ...)` per FR-029a. On `{ ok: false }`, the probe outcome is `{ outcome: 'error', errorMessage: 'URL resolves to private/internal IP, blocked by SSRF policy' }`; the row is persisted to `app_health_probes` with this outcome but **alerts MUST NOT fire** (operator-config error, not a true state transition). Re-resolves on every probe (DNS-rebinding-resistant per FR-029a). Authoritative gate vs the form-time check (T054) which is UX. Update T009's unit test to add cases: blocked-on-private-IP, blocked-on-IMDS-address, blocked-on-IPv6-loopback.
- [X] T054 [BE] [US4] Extend the Add/Edit Application Zod schemas (`POST /api/apps`, `PATCH /api/apps/:id`, `PATCH /api/applications/:id/health/config`) with a `.refine()` on the `healthUrl` field per FR-029b that calls `validateUrlForProbe`. On `{ ok: false }`, reject with `400 INVALID_PARAMS` and `error_code = 'health_url_blocked'`. Documented as the SECOND layer of defence — T053's probe-time check is the authoritative gate. Update T037 / T038 task implementations to consume this. Drizzle parameterized writes only.
- [X] T055 [BE] [US4] Create `POST /api/applications/health-url/validate` endpoint at `devops-app/server/routes/health.ts`. Zod input `{ url: z.string() }`, output `{ ok: boolean; code?: 'private_ip' | 'invalid_url' | 'nxdomain'; resolvedIps?: string[] }`. Calls `validateUrlForProbe`. Rate-limited at 10 req/sec/user (reuse existing rate-limit middleware) to prevent enumeration of internal subnets via the validator. Auth via `requireAuth`. No `as any`, no `console.log`. Unit test asserts rate limiter trips at the 11th call within a second.
- [X] T056 [FE] [US4] Update `devops-app/client/components/apps/HealthCheckUrlInput.tsx` (created in T041) to add inline server-side validation hint per FR-029b UX layer. Debounced 500ms `POST /api/applications/health-url/validate` call from T055; on `{ ok: false }` show inline error text "This URL resolves to an internal IP — health probes cannot target internal infrastructure." NO `dangerouslySetInnerHTML` — render as plain text via React. Typed fetch wrapper, no `as any`. **Amends** T041 — see Cross-task amendments section.
- [X] T057 [BE] [US4] Body-size cap on HTTP probe per FR-032 in `devops-app/server/services/probes/http.ts`. Use `AbortController` + a manual reader on `response.body` that aborts the stream after 1 MB cumulative `Uint8Array` length. Body content discarded — only status code matters per FR-005. Defends against SSRF-amplification streaming attacks. Update T009's unit test to add ≥ 3 cases: response under 1 MB completes normally, response over 1 MB aborts and records `outcome: 'healthy'` if status was already 2xx (status was the only thing we needed), streaming target that never closes is bounded by the existing 10s timeout AND the 1 MB cap (whichever first).
- [X] T058 [SEC] Polish-phase audit pass — extend T045's audit scope to: (a) review SSRF block list against current AWS/GCP/Azure IMDS docs (Azure exposes IMDS at `169.254.169.254` same as AWS; GCP also at `169.254.169.254` with `Metadata-Flavor: Google`; verify no cloud has moved IMDS to a non-link-local IP); (b) verify the DNS-rebinding window between T054 form-validation and T053 probe-time is closed (re-resolve at probe time MUST be unconditional, no caching of `validateUrlForProbe` results); (c) verify the body-cap reader (T057) does not buffer 1 MB then write — it aborts at the first chunk crossing the threshold; (d) verify `POST /api/applications/health-url/validate` (T055) does not log resolved IPs at info level (info-level logs flow to operator audit; resolved-IP enumeration belongs at debug-only). Append findings to the security-audit doc gated by T045. **Amends** T045 — see Cross-task amendments section.



### Backend — config endpoint + Check Now

- [X] T037 [BE] [US4] Add `PATCH /api/applications/:id/health/config` per contracts/api.md. Zod schema validates `{ healthUrl: z.union([z.string().url(), z.null()]).optional(), monitoringEnabled: z.boolean().optional(), alertsMuted: z.boolean().optional(), healthProbeIntervalSec: z.number().int().min(10).optional(), healthDebounceCount: z.number().int().min(1).optional() }` per FR-002 / FR-007 lower bounds. PATCH semantics (omitted = untouched). On success, calls `appHealthPoller.reloadApp(appId)` so the running tick picks up the new cadence / mute state / monitoringEnabled flip. Drizzle parameterized. 400 `INVALID_PARAMS`, 404 `APP_NOT_FOUND`. No `as any`.
- [X] T038 [BE] [US4] Extend `POST /api/apps` and `PATCH /api/apps/:id` request schemas with the same 5 optional health fields per contracts/api.md §Modified endpoints. Reuse the same Zod fragment as T037. Audit middleware unchanged.
- [X] T039 [BE] [US4] Add `POST /api/applications/:id/health/check-now` per contracts/api.md. Zod-validate `:id` (`z.string().uuid()`). 202 Accepted with `{ appId, queuedAt, expectedWithinSec: 15 }`. Calls `appHealthPoller.runOutOfCycleProbe(appId)` fire-and-forget — implementation memoises in-flight promise per appId so concurrent calls return the same handle (idempotent per contracts/api.md §Failure modes). 409 `DEPLOY_IN_PROGRESS` when `deploy_locks.app_id = :id` exists. 409 `MONITORING_DISABLED` when `monitoringEnabled=false`. 404 `APP_NOT_FOUND`. WS `app-health:<appId>` event published when probe completes.
- [X] T040 [BE] [US4] Integration test `devops-app/tests/integration/health-config-and-check-now.test.ts`: (a) PATCH config with new `intervalSec=30` triggers `reloadApp` and the next tick uses 30s; (b) `monitoringEnabled=false` removes the per-app tick on next reload; (c) `alertsMuted` toggle round-trips; (d) PATCH `intervalSec=5` → 400 (FR-002 ≥10 lower bound); (e) Check Now returns 202 + WS event arrives within 15s budget; (f) Check Now during deploy → 409 `DEPLOY_IN_PROGRESS`; (g) Check Now on monitoringEnabled=false → 409 `MONITORING_DISABLED`; (h) two concurrent Check Now calls → idempotent (single probe execution).

### Frontend — form fields + Check Now button

- [X] T041 [FE] [US4] Create `devops-app/client/components/apps/HealthCheckUrlInput.tsx`. Props `value: string | null`, `onChange`, optional `label`, helper text `"Optional public URL for HTTP probe. Leave empty to use container health only. Probes use redirect: manual and a 10s timeout."`. Inline validation via `URL` constructor on blur. Typed, no `as any`.
- [X] T042 [FE] [US4] Modify `devops-app/client/components/apps/AddAppForm.tsx` and `EditAppForm.tsx` to mount `<HealthCheckUrlInput>` plus checkboxes for `monitoringEnabled` (default true) and `alertsMuted` (default false) plus number inputs for `healthProbeIntervalSec` (min=10) and `healthDebounceCount` (min=1). Submit through `PATCH /api/applications/:id/health/config` for granular updates from EditAppForm; AddAppForm sends the fields as part of the existing `POST /api/apps` body.
- [X] T043 [FE] [US4] Create `devops-app/client/components/apps/CheckNowButton.tsx`. Calls `POST /api/applications/:id/health/check-now`, shows pending spinner up to 15s, listens for `app-health:<appId>` WS event to clear pending state. Disabled when monitoring disabled (with tooltip "Re-enable monitoring to use Check Now"). No `dangerouslySetInnerHTML`.
- [~] T044 [FE] [US4] Modify `ApplicationDetail.tsx` to mount `<CheckNowButton>` in the Health section. Integration test `devops-app/tests/integration/check-now-button-flow.test.ts`: button → 202 → WS event → spinner clears → sparkline re-renders within 15s.

**Checkpoint**: US-4 independently testable. Operator can configure all probe knobs via UI; PATCH config triggers `reloadApp`; Check Now bypasses cadence with FR-011 interlock honoured; idempotent in-flight memoisation prevents probe stampede.

---

## Phase 7: Polish

**Purpose**: Security audit pass on probe attack surface, US5 documentation (external uptime monitor for the dashboard itself — per spec § "out-of-tooling"), windowed cert-expiry alert dedup wired through feature 008's `app_cert_events`, regression sweep on existing deploy paths, perf check against SC-004 / SC-005. Sync barrier.

- [X] T045 [SEC] Security audit per FR-029 / FR-030 / FR-031 + cert/Caddy attack surface. Validate: (a) HTTP probe truly does not follow cross-host redirects (intercepts 3xx Location header verifies same-host before treating as healthy if v2 ever changes the policy); (b) `User-Agent: devops-dashboard-probe/1.0` verbatim; (c) container probe SSH user is the deploy user, not root; (d) Caddy admin tunnel does NOT expose 2019 publicly (UFW assertion); (e) `tls.connect` `rejectUnauthorized: false` rationale documented in code comment (cert data needed regardless of trust); (f) no probe path logs the Telegram bot token (pino redact verified); (g) `app_health_probes` does not record request/response bodies — only outcome + statusCode + errorMessage. Document findings in `specs/006-app-health-monitoring/security-audit.md`. Do NOT pre-create that file unless the audit produces findings — empty audits are noise.
- [X] T046 [BE] Implement windowed cert-expiry alert dedup per FR-015a + R-007. Before firing `notifyCertExpiring(app, cert, daysLeft, windowDays)` for any of the windows `≤14d / ≤7d / ≤3d / ≤1d`, query `app_cert_events` (feature 008-owned table — **cross-spec READ + WRITE boundary acknowledged**) for `(cert_id, event_type='expiry_alert', event_data->>'window_days'=:window)` since `lifecycle_start = MAX(occurred_at) WHERE event_type IN ('issued','renewed')`. If a row exists, skip. Otherwise, INSERT an `expiry_alert` event row idempotent on `(cert_id, window_days)` per cert lifecycle, then fire Telegram + WS `app.cert-expiring`. Recovery (cert renewed) is silent per FR-015a — no positive-acknowledgement message. Drizzle parameterized via `postgres` tagged-template — no raw SQL. Unit test `devops-app/tests/unit/cert-window-dedup.test.ts` covers ≥ 8 cases per quickstart Scenario 4 timeline (30 → 14 fires; 13 silent; 7 fires; 6 silent; 3 fires; 1 fires; renewal resets lifecycle; new 14d after renewal fires again).
- [X] T047 [BE] Implement `caddy_admin` cross-spec hook: when caddy commits unhealthy (T029 path), expose an event/queue/method that feature 008's reconciler subscribes to in order to mark affected `app_certs.status = 'pending_reconcile'` per spec 008 FR-009. **Cross-spec write boundary** — feature 006 surfaces the signal; feature 008 owns the `app_certs.status` write. Document the contract in code comment + `data-model.md` already covers it. Integration test asserts the event/hook surface fires exactly once per commit.
- [X] T048 [BE] **US5 documentation** (out-of-tooling per spec § User Story 5): write operational runbook `devops-app/docs/runbooks/external-uptime-monitor.md` (or extend an existing ops doc — confirm via `glob` first; do not pre-create if `docs/operations.md` or similar exists) covering: (a) one-line rationale (an observer cannot observe its own death); (b) recommended free-tier providers (UptimeRobot, BetterStack, freshping); (c) probe configuration (HTTP GET on dashboard public URL, 1-minute cadence, 2-failure threshold, alert to ops Telegram via webhook); (d) what NOT to monitor (anything inside this dashboard's network — feature 006 covers it). NO new code, NO new tests — pure runbook. Per CLAUDE.md, do not create `*.md` files unless explicitly requested or part of the spec — US5 IS the spec's explicit ask.
- [X] T049 [E2E] Regression integration test `devops-app/tests/integration/health-monitoring-regression.test.ts`: (a) feature 005 deploy paths (server-deploy, project-local-deploy from feature 007) still pass when `waitForHealthy` is absent or false; (b) feature 004 deploy_locks lifecycle unchanged; (c) feature 003 scan-import sets `monitoringEnabled` per spec § Dependencies (true for repo-backed apps; false for docker-only); (d) feature 008 cert lifecycle hooks read/write `expires_at` and `last_renew_at` correctly under both feature ownership directions; (e) SC-005 — average dashboard deploy time does NOT increase by >5s when `waitForHealthy` is absent (assert via timing budget on the deploy-success path).
- [X] T050 [E2E] Perf check `devops-app/tests/integration/health-monitoring-perf.test.ts` per SC-004: simulate 10 apps × 60s cadence × 2 probe types over 5 minutes against mocked `sshPool` + `postgres`; assert mean dashboard CPU overhead ≤3% (using `process.cpuUsage()` snapshot deltas). Document the harness's assumptions and the exit criteria; mark the test `.skip` if CI sandbox CPU measurement is unstable, but include the harness for local repro.
- [X] T051 [E2E] Migration verification test `devops-app/tests/integration/migration-0007-verification.test.ts`: (a) all 8 columns present on `applications` with correct types/defaults/CHECK constraints; (b) `app_health_probes` table exists with 4 indexes + XOR CHECK constraint enforced (try inserting `app_id IS NULL AND server_id IS NULL` → expect constraint violation); (c) FK CASCADE on `applications` and `servers`; (d) no data loss on existing apps post-migration (`health_status='unknown'`); (e) journal entry recorded.

**Checkpoint**: All FRs covered, security audit clean, regression suite green, US5 documented externally.

---

## Dependency Graph

```
T001 → T002
T001 + T002 → T003
T003 → T004
T002 → T005
T002 + T005 → T006
T006 → T007
T006 → T008
T006 → T009
T006 → T010
T006 → T011
T011 → T012
T006 + T008 + T009 + T010 + T011 → T013
T013 → T014
T013 → T015
T015 → T016
T013 + T016 → T017
T013 + T016 → T018
T002 → T019
T013 + T020 → T020
T016 + T020 → T021
T017 → T022
T022 → T023
T018 + T022 → T024
T023 → T025
T023 + T024 → T026
T015 + T016 → T027
T027 → T028
T015 + T011 → T029
T029 → T030
T031 → T032
T003 + T031 → T033
T033 → T034
T033 + T034 → T035
T007 → T036
T037 → T038
T037 → T039
T037 + T038 + T039 → T040
T041 → T042
T039 → T043
T043 + T026 → T044
T009 + T010 + T011 → T045
T015 + T010 → T046
T029 → T047
T026 → T048
T035 + T036 + T040 + T044 → T049
T013 → T050
T002 → T051
```

(Fan-in uses `+`, fan-out uses `,`. No chained arrows.)

**Update 2026-04-28 (review-pass tasks)**

```
T009 → T052
T052 → T053
T037 + T038 + T052 → T054
T052 → T055
T055 + T041 → T056
T009 → T057
T045 → T058
T015 → T059
T059 → T060
T031 → T061
```

---

## Parallel Lanes

| Lane | Agent | Task IDs |
|------|-------|----------|
| Schema & migration | [DB] | T001, T002 |
| Manifest + retention scaffolding | [SETUP]/[BE] | T003, T004, T005 |
| Probe scheduler + interlock | [BE] | T006, T007 |
| Container/HTTP probe runners | [BE] | T008, T009 |
| Cert/Caddy probe runners | [BE] | T010, T011, T012 |
| State machine + notifier | [BE] | T013, T014, T015, T016 |
| US1 backend (routes + WS) | [BE] | T017, T018, T019, T020, T021 |
| US1 frontend (dot, sparkline, hooks) | [FE] | T022, T023, T024, T025, T026 |
| US2 alert pipelines | [BE] | T027, T028, T029, T030 |
| US3 wait-for-healthy | [BE]/[OPS] | T031, T032, T033, T034 |
| US3 deploy interlock E2E | [E2E] | T035, T036 |
| US4 config + Check Now backend | [BE] | T037, T038, T039, T040 |
| US4 form fields + button | [FE] | T041, T042, T043, T044 |
| Security audit | [SEC] | T045 |
| Cert dedup + cross-spec hooks | [BE] | T046, T047 |
| US5 doc + regression + perf + migration verify | [E2E] | T048, T049, T050, T051 |
| SSRF guard (block list, probe-time, form-time, validate endpoint, body cap) | [BE] | T052, T053, T054, T055, T057 |
| SSRF inline form hint | [FE] | T056 |
| SSRF audit extension | [SEC] | T058 |
| Notifier coalescing | [BE] | T059, T060 |
| waitForHealthy deadlock-avoidance doc | [OPS] | T061 |

---

## Agent Summary

| Agent | Task Count |
|-------|-----------|
| [DB] | 2 (T001, T002) |
| [SETUP] | 0 (tasks tagged `[SETUP]` are owned by `[DB]`/`[BE]` — see T001..T005) |
| [BE] | 41 (+8: T052, T053, T054, T055, T057, T059, T060) |
| [FE] | 10 (+1: T056) |
| [OPS] | 2 (T033, T061) (+1) |
| [E2E] | 5 (T035, T036, T049, T050, T051) |
| [SEC] | 2 (T045, T058) (+1) |
| **Total** | **61** (+10) |

Per-US count: US1 = 10 (T017..T026); US2 = 6 (T027..T030, T059, T060) (+2 coalescing); US3 = 7 (T031..T036, T061) (+1 deadlock-doc); US4 = 13 (T037..T044, T052..T057) (+6 SSRF). US5 = 1 doc task (T048) per spec § "out-of-tooling". Polish gains T058 SSRF audit extension.

Parallel lane count: 16 (see Parallel Lanes table).

---

## Critical Path

```
T001 → T002 → T006 → T013 → T027 → T035 → T049
```

7 nodes (Setup → Foundational scheduler → State machine → US2 alert pipeline → US3 deploy E2E → Polish regression). Length 7 — every other phase fans out off T013.

**Critical path unchanged at 7 nodes.** New tasks T052..T061 are off-path: SSRF guard (T052..T058) hangs off T009 (HTTP probe runner) and T037 (config endpoint) — both already off the critical path. Notifier coalescing (T059..T060) hangs off T015, also off-path. waitForHealthy doc (T061) hangs off T031, off-path. None lengthen the existing T001 → T002 → T006 → T013 → T027 → T035 → T049 chain.

---

## Implementation Strategy

1. **Phase 1 (Setup)** is a serial lane — DB schema, migration, manifest type extension, prune-job hook. No user story unblocks until T001..T005 land.
2. **Phase 2 (Foundational)** — probe scheduler + 4 runners + state machine + notifier — fan out probe runners (T008..T011) in parallel after T006/T007. Re-converge at T013. Sync barrier after T016.
3. **Phases 3..6 (US1..US4)** can run in parallel lanes with the constraint that:
   - US1 (P1) and US2 (P1) and US3 (P1) ship together for the MVP cut.
   - US4 (P2) ships in the immediate follow-on but blocks on US1 frontend (shares `useAppHealth` + `HealthDot`).
4. **Phase 7 (Polish)** is the final sync barrier — security audit + cert dedup + US5 doc + regression + perf + migration verify. Nothing ships to production without T045..T051 green.

**MVP scope**: Phases 1, 2, 3, 4, 5 (T001..T036). Delivers per-app health visibility, Telegram alerts, and the wait-for-healthy deploy gate — the three gaps the 2026-04-22 incident exposed. US4 (T037..T044) and Polish (T045..T051) ship in the next train.

**Cross-spec dependencies**:

- **Feature 008 owns `app_certs`**: T010 (cert_expiry probe) WRITES `expires_at` and conditionally `last_renew_at`; T046 (cert window dedup) READS+WRITES `app_cert_events`. Bidirectional contract per spec § Dependencies — 008 owns lifecycle, 006 owns periodic observation. Both directions are explicit in task descriptions. **Order constraint**: feature 008's migration that creates `app_certs` and `app_cert_events` MUST land before T010 / T046 attempt to write — if 008 has not shipped, feature 006 either ships its probes feature-flagged off OR ships behind 008 in the migration sequence.
- **Feature 008 `caddy_admin` reconcile hook**: T029 / T047 surface the unhealthy event; feature 008's reconciler subscribes and marks `app_certs.status = 'pending_reconcile'` per spec 008 FR-009. Cross-spec write boundary — 006 fires the signal, 008 owns the row write.
- **Feature 004 `deploy_locks`**: T007 / T036 READ-only — probe never writes to deploy_locks; deploy never reads probe state.
- **Feature 005 `script_runs` + manifest**: T003 extends the manifest entry type; T033 / T034 augment the runner's transported script + terminal-status mapping. Backward-compatible additive — existing deploy entries unchanged.

**FR coverage check**:

- FR-001 → T006 (poller iterates `monitoringEnabled=true`).
- FR-002 → T002 CHECK ≥10s + T037 Zod min(10) + T013 `Math.max(10_000, ...)`.
- FR-003 → T008 (`deriveContainerName` + `docker inspect` cmd).
- FR-004, FR-005, FR-029, FR-030 → T009 (HTTP runner).
- FR-006 → T013 effective-outcome computation.
- FR-006a → T010 (cert_expiry probe + strict-later `last_renew_at` guard) + T046 (window dedup).
- FR-006b → T011 (caddy_admin probe) + T029 (alert pipeline) + T047 (cross-spec hook).
- FR-007 → T013 (debounce in `commitState`) + T014 unit test.
- FR-008 → T013 (silent unknown→healthy) + T028 case (c).
- FR-009, FR-010 → T027 (alert wiring) + T028 cases (a)(b).
- FR-011 → T007 (interlock read) + T036 (E2E).
- FR-012 → T013 (`persistProbes`) + T002 schema.
- FR-013 → T013 + R-011 split (freshness vs commit).
- FR-014 → T005 retention prune.
- FR-015 → T015 (notifier extension).
- FR-015a → T046 (windowed once-per-lifecycle dedup via `app_cert_events`).
- FR-015b → T029 / T047 (Caddy alert + cross-spec hook).
- FR-016 → T015 deep-link in payload.
- FR-017 → T015 swallow-and-warn + T028 case (f).
- FR-018 → T016 (mute is notification filter only) + T014 case (e) + T027 explicit gate.
- FR-019..FR-021 → T023, T024, T025 (frontend dot + sparkline + aggregate).
- FR-022 → T041 / T042 (HealthCheckUrlInput + form mount).
- FR-023 → T039 (Check Now endpoint, 15s budget) + T043 (button).
- FR-024 → T003 (manifest type fields) + T033 (runner consumes them).
- FR-025 → T031 (5s polling cadence in bash tail).
- FR-026, FR-027 → T034 (exit-code mapping) + T035 cases (b)(c).
- FR-028 → T031 (`{{if .State.Health}}1{{else}}0{{end}}` silent skip) + T035 case (d).
- FR-031 → T008 (no root) + T045 (audit verifies).

- FR-029a → T052 (block list module) + T053 (probe-time gate, authoritative) + T058 (audit).
- FR-029b → T054 (Zod refinement on form schemas) + T055 (validate endpoint) + T056 (FE inline hint).
- FR-032 → T057 (1 MB body cap via streaming reader).
- Edge "flapping rate-limit" → T059 + T060 (notifier coalescing).
- Edge "waitForHealthy deadlock-avoidance" → T061 (inline doc).

No FR uncovered.

---

## Cross-task amendments (2026-04-28 review pass)

- **T041** (HealthCheckUrlInput) — implementation MUST consume the new `POST /api/applications/health-url/validate` endpoint via T056. T041 ships the input field; T056 layers the debounced server-side validation hint on top. No FE work duplicated; T056 is an additive amendment.
- **T037 / T038** (config + apps PATCH endpoints) — Zod schemas now share a `.refine()` from T054 calling `validateUrlForProbe`. Reject with `400 INVALID_PARAMS` `error_code = 'health_url_blocked'` on `{ ok: false }`.
- **T009** (HTTP probe runner) — wire `validateUrlForProbe` (T053) before `fetch`; add 1 MB body cap (T057). Existing T009 unit-test list extended with SSRF-block + body-cap cases — keep T009's existing 12 cases AND add the new ones.
- **T045** (security audit) — scope extended by T058 to cover SSRF block list cloud-IMDS coverage, DNS-rebinding window, body-cap streaming behaviour, and validate-endpoint log redaction.

**Cross-spec resolution note**: SSRF guard tasks (T052..T058) sit in the US4 phase (operator-configures-probe-targets) because that's where `healthUrl` is set, but FR-029a is enforced inside the Foundational HTTP probe runner (T009) — Phase 2. Resolution: T053 lives logically with T009 but the WORK lands in the US4 SSRF lane to keep the security review surface contiguous (block-list module, probe wiring, form wiring, FE hint, validate endpoint, body cap, audit extension all reviewable in one PR). The dependency graph reflects this: `T009 → T053` (Foundational must exist before SSRF wires into it) and `T037 + T038 + T052 → T054` (US4 endpoints must exist before refinement adds).

**Voice**: ship the MVP train (US1+US2+US3) first; US4 and Polish follow within the next sprint. Don't gold-plate the sparkline. Bash tail is heredoc-trivial — write once, never touch again. The cert + caddy probes are honest infrastructure observation, not a parallel-universe of feature 008. Trust the debounce.
