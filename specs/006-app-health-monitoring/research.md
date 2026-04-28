# Research: Application Health Monitoring & Post-Deploy Verification

**Phase 0 output** | **Date**: 2026-04-28

---

## R-001: Probe scheduler design

**Decision**: Per-app `setTimeout` chain (recursive `setTimeout`, NOT `setInterval`), keyed by `appId` in a `Map<string, AppPollState>`. Mirrors the existing `server/services/health-poller.ts` pattern (`schedulePoll → setTimeout → tickHandler → schedulePoll`) exactly.

The `AppHealthPoller.start()` method enumerates `applications WHERE monitoring_enabled = true` and calls `scheduleAppCycle(app)` for each. A separate `dailyCertTimer` (`setInterval(86400000).unref()`) handles the cert_expiry sweep across all apps with non-NULL `domain`. A third `Map<string, CaddyPollState>` keys per-server caddy_admin polls.

**Rationale**:

1. **Pattern parity**: the operator already understands the recursive-setTimeout pattern from `health-poller.ts:149`. Identical semantics for cancellation, overlap-guard, and exception-swallow. Code review burden: zero new mental model.
2. **Per-app interval respect**: each app may have its own `healthProbeIntervalSec` (FR-002 — default 60, lower bound 10). `setInterval` on a single shared timer cannot honour per-app intervals without a complex priority queue; per-app `setTimeout` does it natively.
3. **Drift tolerance**: `setInterval` accumulates drift; recursive `setTimeout` resets the clock per tick. For a 60s probe cadence, drift is irrelevant at the time scale — but we get the better of the two options for free.
4. **Cancellation cleanliness**: `delete polls.get(appId)` + `clearTimeout(state.timer)` cleanly stops one app's loop without affecting others. `setInterval` cancellation requires per-id `clearInterval` lookups anyway, so no advantage there.

**Alternatives considered**:

- **Single shared `setInterval(10000)` with per-app skip-counter**: Saves N timer handles for N apps. At v1 scale (10–50 apps) this is irrelevant — Node handles thousands of timers. The skip-counter logic adds a per-app modulo check on every shared tick, more code than it saves. Rejected.
- **Cron library (`node-cron`, `croner`)**: New dependency. Cron syntax is overkill for a fixed-interval probe (we don't need "every 3rd Tuesday"). Rejected per "no new packages without approval" Standing Order.
- **`node:scheduler` API**: Experimental, no benefit over `setTimeout` for this use case. Rejected.
- **Worker thread per probe**: Probes are I/O bound (SSH, fetch, TLS) — a single Node thread handles thousands of concurrent I/O ops trivially. Worker threads add coordination overhead with no concurrency gain. Rejected.

---

## R-002: Container health probe transport

**Decision**: Reuse `sshPool.exec(serverId, cmd)` for each container probe — the same call shape that `health-poller.ts:89` already uses for the per-server health JSON.

Cmd shape: `docker inspect --format '{{.State.Health.Status}}' <container-name> 2>/dev/null || echo no-container`. The `||` ensures a non-zero exit doesn't bubble as an SSH error — `no-container` is parsed by the runner and translates to `ProbeOutcome.outcome = "error"`.

**Rationale**:

1. **Pool reuse**: `sshPool` already maintains keepalive connections (per spec edge case "SSH connection drop mid-probe" — handled by reconnect-on-demand in `health-poller.ts:50–70`). One probe = one channel-exec on an existing connection. Zero handshake cost amortised.
2. **No new abstraction**: introducing a `dockerExecPool` or similar layer is premature. The existing `sshPool.exec` already returns `{ stdout, stderr, code }` — exactly the shape the probe needs.
3. **FR-031 compliance**: `docker inspect` does not require root with the standard docker group setup that `setup-vps.sh` already provisions for the SSH user.

**Alternatives considered**:

- **Dedicated docker-exec pool**: would let us multiplex many probes through a single SSH channel via `docker exec` with persistent stdin. Overkill for 60s cadence — at 50 apps the steady-state probe rate is 50/60s ≈ 0.83 calls/sec. The existing exec call comfortably handles that.
- **Docker daemon socket forwarding**: would skip per-probe SSH cmd parse. Requires opening port 2375 (insecure) or unix socket forwarding via SSH (works but adds a moving piece). Not worth it at v1 scale.
- **Polling `docker events` stream**: real-time push instead of polling. Stream interruption handling is non-trivial; fits a future v2 if probe latency becomes a bottleneck.

---

## R-003: HTTP probe transport

**Decision**: Node native `fetch()` + `AbortController` with a 10-second `signal` timeout. `redirect: "manual"` to enforce FR-029 (no cross-host redirect). `User-Agent: devops-dashboard-probe/1.0` per FR-030.

```ts
const ctrl = new AbortController();
const timer = setTimeout(() => ctrl.abort(), 10_000);
try {
  const resp = await fetch(app.healthUrl!, {
    method: "GET",
    redirect: "manual",
    headers: { "User-Agent": "devops-dashboard-probe/1.0" },
    signal: ctrl.signal,
  });
  // FR-005 status classification ...
} finally {
  clearTimeout(timer);
}
```

**Rationale**:

1. **Node ≥ 20 has `fetch` natively** — no `node-fetch` dependency.
2. **`redirect: "manual"`** stops at the first 3xx and returns the response with `status === 301/302/etc.` This is FR-029 — a redirect to a different host could be a probe loop or SSRF vector. The 3xx status itself is treated as healthy per FR-005 ("2xx and 3xx as healthy") — the app responded with a redirect, that's a working app.
3. **`AbortController` is the canonical fetch-timeout idiom**. The 10s budget is fixed per FR-004.
4. **No new dep** for retries — FR-002's debounce IS the retry policy; per-probe retries would compound with the state-machine debounce and confuse the failure attribution.

**Alternatives considered**:

- **`http`/`https` core modules with custom timeout handling**: more code, identical capability. Rejected.
- **`undici` directly**: `fetch` already uses undici under the hood in Node 20+. Direct undici would let us get connection-pool stats but those don't matter at this scale.
- **`got`/`axios`**: extra deps, no capability we need.
- **TCP-only probe**: faster but would miss application-layer issues (502, 503, slow-but-not-dead). Spec wants HTTP semantic, not TCP.

---

## R-004: TLS expiry probe — `tls.connect` (Node native) vs `openssl s_client` shellout

**Decision**: Node native `tls.connect`. Despite FR-006a writing the example as `openssl s_client -connect ... | openssl x509 -noout -enddate`, that's a syntactic illustration — the FR text says "performs a TLS handshake … parses notAfter", which is exactly what `getPeerCertificate(false).valid_to` returns from `tls.connect`.

```ts
import { connect } from "node:tls";
const s = connect({ host, port: 443, servername: host, rejectUnauthorized: false });
s.once("secureConnect", () => {
  const cert = s.getPeerCertificate(false);
  s.end();
  // cert.valid_to is RFC2822 ("Apr 28 12:00:00 2026 GMT") — Date constructor parses it natively
});
```

**Rationale**:

1. **No fork overhead**: `child_process.exec` per probe = ~5ms fork + spawn. `tls.connect` = pure async I/O on existing event loop.
2. **No parsing fragility**: `openssl x509 -noout -enddate` outputs `notAfter=Apr 28 12:00:00 2026 GMT` — robust enough but text-shaped. `cert.valid_to` is the same string but bypasses any locale or version variance in the openssl binary.
3. **No openssl version assumptions**: target servers may have openssl 1.1 or 3.0 with subtly different defaults for SNI handshakes. Node's `tls` module is consistent across all our deployments (single Node version).
4. **`rejectUnauthorized: false`** is intentional — we want to read the cert even if it's expired, self-signed, or chain-broken. The cert data is what we need; the trust verdict is not the question this probe answers.

**Alternatives considered**:

- **`openssl` shellout via `sshPool.exec(targetServerId, ...)`**: makes the probe target's openssl version part of the contract. Worse: requires a network roundtrip via SSH to the TARGET to talk to the TARGET's domain — but the TLS handshake should happen from the dashboard's POV (matches the user's POV). Probe target is the public domain, dashboard is the canonical observer (per spec clarification 2026-04-22).
- **`Bun.connect.tls`**: not our runtime.
- **Pure ACME-API query for the cert state**: would talk to Let's Encrypt directly. Rate-limited, doesn't help on `failed` cert states, doesn't observe what the actual server is presenting.

**Risk**: `tls.connect` has a corner case where `secureConnect` fires before `peerCertificate` is fully populated for SNI-with-redirect chains. Mitigated by reading the cert inside the `secureConnect` handler (the spec is explicit that the handler is fired after the TLS handshake completes).

---

## R-005: Caddy admin probe SSH-tunnel reuse strategy

**Decision**: Open a short-lived SSH port-forward per probe (one per server per 60s tick). NOT shared with feature 008's reconciler tunnel.

`sshPool.openTunnel(serverId, { remoteHost: "127.0.0.1", remotePort: 2019 })` — new method on `sshPool`, thin wrapper over ssh2's `forwardOut`. Returns `{ localPort: number; close(): void }`. Closes after the single fetch completes.

**Rationale**:

1. **Coordination cost vs. probe cost**: feature 008's reconciler uses an on-demand tunnel during its 5-minute drift cron + on every domain change. Probe runs every 60s. Reusing the reconciler tunnel would require:
   - A long-lived tunnel state machine (hold/release counter, lifetime budget).
   - Cross-feature coupling — probe must know the reconciler's tunnel handle.
   - Failure modes: who closes it on shutdown? Who reopens it after a Caddy reachability blip? Whose retry policy wins?
   The cost of opening a new tunnel is one SSH channel-open RTT (~10ms on a warm pool connection). At 60s cadence per server that's negligible compared to the coordination headache.
2. **Independent failure isolation**: a tunnel held by the reconciler and crashing the probe (or vice versa) leaks across feature boundaries. Independent short-lived tunnels keep each feature's failure domain clean.
3. **`sshPool` already supports this**: ssh2's `Client.forwardOut` is the documented primitive for SSH-tunnel-with-local-port. Adding `openTunnel` to the pool is ~20 lines.

**Alternatives considered**:

- **Shared tunnel**: rejected per above. Coordination cost outweighs benefit.
- **Cmd-shell-via-SSH probe** (`ssh server "curl -fsS http://localhost:2019/config/"`): uses target's curl, depends on curl being installed (it is, per `setup-vps.sh`), but the response body would need to be parsed to ensure 200 OK was returned — `curl -fsS` returns non-zero on 4xx/5xx, but we'd lose the actual status code. Tunnel + native fetch lets us observe the status code directly.
- **Public Caddy admin endpoint**: forbidden by feature 008 FR-028 (`UFW MUST NOT open 2019`).

---

## R-006: Live UI updates — polling every 30s vs WS subscription

**Decision**: WebSocket subscription via the existing `channelManager`. Two channels:

- `app-health:<appId>` — fired on every probe completion (sparkline updates on the detail view).
- `server-apps-health:<serverId>` — fired on every state-change commit on any app of that server (apps-list dot updates).

The Apps tab subscribes to `server-apps-health:<serverId>` once per render and invalidates the react-query cache for the apps list on each event. The detail view subscribes to `app-health:<appId>` for finer-grained updates.

**Rationale**:

1. **Existing infrastructure**: `channelManager` is already used by `health-poller.ts:124` for `health:<serverId>`. Adding two channel patterns is two `broadcast()` calls + two `subscribe()` calls.
2. **Scaling**: polling is O(connected-tabs × servers × apps × 30s-tick) round-trips. WS is O(state-changes-per-second) — orders of magnitude smaller for the typical case (apps are mostly healthy and stable).
3. **Latency**: SC-002 wants alert-to-admin < 3 minutes. Polling caps perceived UI latency at 30s; WS is instant. Both meet SC-002 with margin, but the WS path doesn't dominate the user's experience.
4. **No new infrastructure**: same WS gateway, same auth, same channel lifecycle. Zero ops cost.

**Alternatives considered**:

- **30s react-query polling**: simpler initial implementation. Rejected because the WS infrastructure is already in place — the marginal cost of consuming it is lower than the marginal cost of adding a polling timer to every Apps tab render.
- **Server-sent events (SSE)**: equivalent capability to WS at this scale; the codebase already speaks WS. No reason to introduce a second push channel.
- **Push via long-poll**: legacy fallback for when WS is blocked. Not relevant for this dashboard's deployment topology (operator-internal, no corporate-firewall traversal).

---

## R-007: Per-cert / per-window alert deduplication (FR-015a)

**Decision**: Persist a row in feature 008's `app_cert_events` table for each window-fire. Lookup before alerting:

```sql
SELECT 1 FROM app_cert_events
 WHERE cert_id = $1 AND event_type = 'expiry_alert'
   AND event_data->>'window_days' = $2
   AND occurred_at > $3              -- $3 = the cert's last issued_at OR last successful renew_at
```

If a row exists for `(cert_id, window_days)` since the last issuance/renewal, the alert is skipped. On successful renewal (`expires_at` jumps past the next window), the next time the probe sees `daysLeft ≤ window`, no event row exists for THIS cert lifecycle — alert fires.

**Rationale**:

1. **In-memory `Set` is wrong**: dashboard restart wipes it. After a restart, every cert in a window would re-alert. The whole point of windowed-once-per-lifecycle is "the operator already saw this signal, don't repeat".
2. **Persistent log is the natural place**: feature 008 already requires `app_cert_events` for audit (FR-026). Reusing it for alert dedupe is a single query, one new event_type (`expiry_alert`), zero schema impact.
3. **Lifecycle reset semantics**: comparing `occurred_at > last_renewal_or_issue` is the only correct definition of "this cert lifecycle". A new cert lifecycle is bounded by issuance or successful renewal — both are recorded in `app_cert_events` already.
4. **Cross-bidirectional contract with 008**: 008 owns the table schema; 006 reads from and writes to it for this specific event_type. This matches the spec's "Probe lives here, lifecycle lives in 008" decision (Session 2026-04-28 — Q1).

**Alternatives considered**:

- **In-memory `Set` of `(certId, windowDays)`**: wipes on restart. Already-alerted certs re-alert. Rejected.
- **Boolean column on `app_certs` per window** (`alerted_14d`, `alerted_7d`, ...): four columns of alert state. Cleared on renewal. Works, but mixes lifecycle data with alert state, and the column count is a hint that something's wrong with the modelling.
- **Separate `cert_alert_events` table owned by feature 006**: parallel-universe of `app_cert_events`. Feature 008's spec already prescribes the table; carve-out wastes coordination.

---

## R-008: Sparkline rendering — raw probes vs pre-aggregated 5-min buckets

**Decision**: Raw probes. The 24h sparkline reads `app_health_probes WHERE app_id = ? AND probed_at > now() - 24h ORDER BY probed_at ASC`. SVG-only rendering (no chart library), one tick per probe row, colour-coded by outcome.

**Rationale**:

1. **Data volume**: 24h × 60s cadence = 1440 rows max per app per type. Container + HTTP = up to 2880 rows/24h/app. At 50 apps and 30-day retention, total table size is ~4.3M rows — well within Postgres comfort.
2. **Query cost**: `(app_id, probed_at desc)` index covers the sparkline query exactly. Single index scan, returns 1440 rows, ~1ms.
3. **Aggregation buys nothing visible**: human eye can't distinguish 1-minute resolution from 5-minute resolution at sparkline width (~200px). But the 1-minute resolution makes flapping/recovery patterns visible — useful for diagnosis. Aggregation would smooth them out.
4. **Aggregation is premature optimisation**: if A-005's 100+ app projection is reached, hourly summaries become worth the complexity. Until then, the table size is fine.

**Alternatives considered**:

- **5-min bucket aggregation table** updated by the prune job: writes additional rows on every probe, complicates retention (delete-from-2-tables), saves zero perceptible UI quality. Deferred to v2.
- **In-memory rolling buffer**: lost on restart. The sparkline post-restart would be empty for the first 24h. Rejected — operators expect history to be persistent.

---

## R-009: Wait-for-healthy bash tail injection

**Decision**: Append the tail to the transported script buffer in `scripts-runner.ts`, using the same heredoc-safe concatenation pattern feature 005 uses for `common.sh` injection. The tail is built by `buildHealthCheckTail({ container, timeoutMs })` — a pure function, unit-testable.

```ts
const tail = entry.waitForHealthy
  ? buildHealthCheckTail({ container: deriveContainerName(app), timeoutMs: entry.healthyTimeoutMs ?? 180_000 })
  : "";
const transportedScript = [commonShPreamble, commonShBody, "", targetScript, "", tail].join("\n");
```

The tail is plain bash with no source-overrides needed — it runs after the target script's main work completes. Exit codes:

- `0` = healthy (success)
- `1` = unhealthy reported by docker inspect (failed)
- `124` = timeout (chosen to match the GNU `timeout` exit-code convention)

`scripts-runner.ts`'s terminal-status handler maps these to `script_runs.status` per FR-026..FR-028.

**Rationale**:

1. **Scope-local**: `__WFH_*` prefix on all bash variables prevents collision with target script vars. Empty quotes around `$__WFH_CONTAINER` handle container names with dashes (which is the default).
2. **No source-override needed**: the tail runs at top-level after the target script's last command — no nested function-override drama. R-003 of feature 005 covered the override; this is the inverse case (we KNOW the layout because we're appending).
3. **`docker inspect` behaviour for missing healthcheck**: `{{if .State.Health}}1{{else}}0{{end}}` returns `0` if the container has no healthcheck struct. We branch on that explicitly per FR-028 (silent skip). Tested in `tests/unit/build-health-check-tail.test.ts`.
4. **5s polling cadence**: spec says "every 5s" (FR-025). One-second polling would be more responsive but burn 5x more `docker inspect` calls; spec's 5s is the explicit choice.

**Alternatives considered**:

- **Probe-via-dashboard during deploy** (use `app-health-poller`'s out-of-cycle probe): cross-process coordination, dashboard would need to learn when the container is "newly started" vs "old healthy state". Target-side bash is local and authoritative.
- **`waitForHealthy` as a separate ScriptRun** (sequential after the deploy run): requires linking two runs to the same deploy, two log files, two job IDs. Operator confusion. Tail-append keeps it one run.
- **Healthcheck-baked-into-deploy.sh**: every deploy script would need to add the tail manually. Defeats the manifest extension's whole point.

---

## R-010: Probe-during-deploy interlock — lock acquisition order

**Decision**: Probe loop READS `deploy_locks` row (`SELECT app_id FROM deploy_locks WHERE app_id = $1`) before each probe tick. Skips the tick if the row exists. Probe NEVER takes a lock.

Deploy still acquires the Postgres advisory lock + writes the `deploy_locks` row (per feature 004). Probe is a non-blocking observer of that state.

**Rationale**:

1. **One-way coordination**: deploy is the writer of "I'm running"; probe is the reader. The asymmetry maps cleanly to one-side-acquires, the-other-side-checks.
2. **No deadlock possible**: probe doesn't take any locks → no lock-cycle can form between probe and deploy.
3. **No false-pause**: if `deploy_locks` row is for a different app on the same server, probe of THIS app proceeds (per FR-011 — "during an active deploy of an app X, the probe cycle for X is paused" — only X).
4. **Simple recovery**: if dashboard crashes mid-deploy, the lock row is wiped by feature 004's startup reconciliation. Probe resumes naturally on next tick.

**Alternatives considered**:

- **Probe takes the same lock**: introduces the deadlock risk and prevents probe from running ever during a deploy on any app on the server. Rejected per FR-011's per-app scope.
- **Probe takes a row-lock (`SELECT ... FOR UPDATE`)**: gates the deploy on probes finishing. Wrong direction — deploy must dominate.
- **Pause via in-memory flag**: doesn't survive dashboard restart. Wrong locality (probe running in same process as the deploy ack).

---

## R-011: `health_status` denormalisation freshness — write on every probe vs write on transition

**Decision**: Two columns, two cadences:

- `health_checked_at` — UPDATEd on every probe (freshness indicator).
- `health_message` — UPDATEd on every probe (most recent failure reason if any).
- `health_status` — UPDATEd ONLY on transition commit (after debounce).
- `health_last_change_at` — UPDATEd ONLY on transition commit.

**Rationale**:

1. **Spec wording**: FR-013 says "current effective health state MUST be denormalised" — that's `health_status`. FR-007 says "transition requires 2 consecutive probes" — that's the gate. So `health_status` reflects the COMMITTED state, not the most recent probe state.
2. **UI semantics**: a green dot that flickers to red for a single probe and back is misleading. The dot SHOULD reflect the committed state — green if the app is committed-healthy, even mid-flap.
3. **`health_checked_at` is the freshness signal**: operator wants to know "was the probe alive in the last 60s?". That's a different question from "is the app healthy?". Two columns, two answers.
4. **Performance neutral**: each probe was already going to touch the row to update freshness; transition commits add one more row update on transition. Negligible.

**Alternatives considered**:

- **Single column updated on every probe**: causes the flicker UX issue. Rejected.
- **Dedicated `applications_health_state` summary table**: row per app, denormalised. Adds indirection, query joins. The 8 columns on `applications` are simpler.

---

## R-012: Container name derivation (FR-003)

**Decision**: Default to `<compose-project>-<service>-1` (Docker Compose v2 convention). Fall back to `<compose-project>-<service>` if `-1` doesn't exist (single-service projects sometimes drop the replica suffix).

`<compose-project>` is derived from `applications.remotePath` basename (Docker's default project-name behaviour) UNLESS the app row has a future `composeProject` override (v2). `<service>` is derived from the first service in the compose file as observed by the scanner. For v1, we add `applications.containerName TEXT NULL` — operator can override.

The derivation runs at probe time in the runner:

```ts
function deriveContainerName(app: AppRow): string {
  if (app.containerName) return app.containerName;          // operator override wins
  const project = path.basename(app.remotePath).replace(/[^a-z0-9_-]/gi, "_").toLowerCase();
  const service = app.serviceName ?? "app";                  // sane default
  return `${project}-${service}-1`;
}
```

**Rationale**:

Spec FR-003 documents the convention but acknowledges variance. Operator override (`containerName`) is the safety valve for projects that use a non-default naming scheme (`container_name:` in compose, `--project-name` flag, etc.).

**Risks acknowledged**:

- Compose v1 used `_` separators (`<project>_<service>_1`). Edge case — modern Compose v2 uses `-`. Override field handles legacy.
- Multi-replica services produce multiple containers (`<project>-<service>-1`, `-2`, ...). v1 probes only `-1`; multi-replica probing is a v2 enhancement.

This is more of a footnote than a research-equal decision — included here so future readers know the override field is intentional.

---

## R-013: Caddy admin probe scope — per server vs per app

**Decision**: Per server. One `caddy_admin` probe per `servers.id` that has at least one app with a non-NULL `domain`. Servers with no managed-domain apps still get probed — per spec edge case, "alert fires regardless".

The probe row in `app_health_probes` uses `server_id` (with `app_id` NULL — see migration plan in plan.md for the XOR constraint).

**Rationale**:

Caddy is per-server infrastructure. Probing per-app would generate N redundant probes for N apps on the same server. Per-server cadence is what the operator cares about — one Caddy down means EVERY app on that server has a reverse-proxy problem.

**Alternatives considered**:

- **Per-app caddy_admin probe**: redundant, noisy, wasteful.
- **Skip Caddy probes for servers with no managed-domain apps**: edge case in spec explicitly says probe still runs. The infrastructure problem (Caddy down) is still real even if no current app uses it; operators learn about it before the next domain attach.

---

## Summary of Unknowns Resolved

| Topic | Decision |
|-------|----------|
| Probe scheduler (R-001) | Per-app recursive `setTimeout` chain mirroring `health-poller.ts` |
| Container probe (R-002) | Reuse `sshPool.exec` per probe |
| HTTP probe (R-003) | Native `fetch` + `AbortController` 10s, `redirect: "manual"` |
| TLS expiry (R-004) | Native `tls.connect` + `getPeerCertificate().valid_to` (NOT `openssl` shellout) |
| Caddy tunnel (R-005) | Short-lived per-probe tunnel, NOT shared with feature 008 reconciler |
| Live UI (R-006) | WebSocket subscription via existing `channelManager` |
| Cert window dedupe (R-007) | Persistent rows in feature 008's `app_cert_events` |
| Sparkline (R-008) | Raw probes, no pre-aggregation; 24h × per-min = 1440 rows max |
| Wait-for-healthy tail (R-009) | Bash tail appended to transported script; exit 0/1/124 mapped |
| Probe-deploy interlock (R-010) | Probe READS `deploy_locks` row, never takes lock |
| Freshness denormalisation (R-011) | `health_checked_at` every probe; `health_status` on commit only |
| Container name derivation (R-012) | `<project>-<service>-1` default + operator-override column |
| Caddy probe scope (R-013) | Per server, not per app |
