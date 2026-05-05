# Research: Blue/Green Deploy with Connection Drain

**Date**: 2026-05-05 | **Branch**: `012-blue-green-deploy` | **Plan**: [plan.md](plan.md)

Resolves all NEEDS CLARIFICATION items from plan's Technical Context.
Each entry: Decision · Rationale · Alternatives considered.

---

## R-001 — Caddy `POST /load` atomic config-replace semantics

**Decision**: Use Caddy admin API's `POST /load` endpoint for the
upstream switch. This endpoint replaces the entire active config tree
atomically — no stop/start sequence, no inheritance dance.

```ts
// caddy-upstream-switcher.ts
async function switchUpstream(caddy: CaddyAdminClient, appId: string, newColor: 'blue' | 'green'): Promise<SwitchResult> {
  const newUpstream = `${composeServiceName(appId)}-${newColor}:${appPort(appId)}`;
  const newConfig = buildCaddyConfigWith(appId, newUpstream);
  const response = await caddy.postLoad(newConfig);
  if (!response.ok) {
    return { ok: false, reason: 'caddy_admin_rejected_config', detail: response.statusText };
  }
  return { ok: true, switchedAt: new Date().toISOString() };
}
```

**Atomicity guarantee**: Caddy's `POST /load` is documented to swap the
config atomically. New requests after the response see new upstream;
in-flight requests on old upstream complete on old. This is the entire
foundation of zero-drop switch (SC-001).

**Rationale**:

- Existing infrastructure (`caddy-admin-client.ts` from feature 008)
  already integrates with admin API. Reuse, no new client needed.
- Atomic semantics is what makes blue/green safe — anything less
  (config-merge, partial reload) would have observable race windows.
- Tested in production via feature 008's cert-renewal config updates;
  same code path.

**Alternatives**:

- File-based Caddy config + `POST /reload` — rejected: file-touch
  introduces race window between file write and reload signal.
- Per-app override snippet via `caddy-override-writer.ts` (existing) —
  considered but `POST /load` is more explicit for switch semantics.
  May be used as fallback if `POST /load` proves problematic at scale.
- HAProxy / nginx alternatives — out of scope; spec assumes Caddy
  (FR-006, A-001).

**Caveat**: `POST /load` replaces the ENTIRE active config, not just
one app's upstream. The switcher must reconstruct the full config with
just the target app's upstream changed. Reuse `caddy-config-builder.ts`
(feature 008) for the full-config render; pass overridden upstream for
the target app.

---

## R-002 — `docker rename` zero-downtime for first-deploy migration

**Decision**: First blue/green deploy on an app previously deployed via
`recreate` triggers a one-time `docker rename <existing> <service>-blue`
ritual before candidate spawn. This rename is a metadata-only operation
in containerd's bookkeeping — no container restart, no network blip,
no traffic interruption.

```ts
// slot-namer.ts
async function migrateExistingToBlueSlot(serverId: string, appId: string): Promise<void> {
  const app = await loadApp(appId);
  const existingName = await detectExistingContainerName(serverId, appId);
  const targetName = `${app.composeService}-blue`;
  if (existingName === targetName) return; // idempotent — already migrated
  await sshExec(serverId, `docker rename ${shQuote(existingName)} ${shQuote(targetName)}`);
  await db.update(applications)
    .set({ activeColor: 'blue' })
    .where(eq(applications.id, appId));
}
```

**Rationale**:

- `docker rename` only updates the container's metadata in Docker's
  state store (containerd or moby's local DB). No process restart.
  No network reconnect. No volume remount.
- Caddy upstream resolution by container name DNS — when rename
  completes, next DNS lookup returns new name. Existing connections
  use socket-level addresses, unaffected.
- One-time ritual, idempotent: re-running is no-op if already named
  correctly. Safe to retry on failure.

**Alternatives**:

- Recreate the existing container with new name — would cause downtime
  during the rename. Defeats the whole point of blue/green.
- Use compose project-name override (`-p`) — would create a new project,
  orphaning the old container. Network/volume isolation issues.
- Use docker labels instead of names — Caddy upstream resolves by
  hostname, not labels. Doesn't fit existing networking model.

**Reference**: Docker docs on `docker rename` confirm metadata-only.
Tested locally via spike (rename a running web server, verify TCP
connections persist).

---

## R-003 — Compose dual-container via dynamically-generated override file

**Decision** (per plan D1): generate a per-deploy override compose file
that explicitly names the candidate container. Existing compose
file NEVER modified; the override is layered on top via `docker compose
-f docker-compose.yml -f docker-compose.bg-override.yml up -d`.

```yaml
# Generated as <appDir>/docker-compose.bg-override.yml during deploy
# (deleted after deploy completes successfully OR on failure cleanup)
version: '3.x'
services:
  <upstream_service>:
    container_name: <service>-<candidate-color>
    # Inherit everything else from base compose
```

The orchestrator generates this file with the candidate color (opposite
of `active_color`), runs `docker compose -f base.yml -f override.yml
up -d --no-deps <service>` to spawn the candidate without affecting
the outgoing one. After successful drain + outgoing stop, the override
is deleted and the next deploy will generate a fresh one with the new
candidate color.

**Rationale**:

- Compose's `-f` file layering is a documented, stable feature.
- Override files don't pollute the operator's repo (generated in
  `<appDir>/.dashboard/` namespace, gitignored convention).
- `--no-deps` prevents compose from restarting the outgoing service
  when bringing up the candidate.
- Container naming explicit and deterministic (sticky per slot per
  spec Q1) — no `--scale` magic, no naming surprises.

**Alternatives considered**:

- `docker compose --scale <service>=2` — rejected: compose can't
  differentiate replicas by stable identity (containers are
  `<service>_<replica-num>`). Caddy upstream config can't target
  "the green one" reliably.
- `docker compose -p <project>-green` — rejected: project-name override
  creates a separate compose stack with isolated networks; can't reach
  shared volumes; loses the "single project" semantics.
- Inline patch of the operator's compose file — rejected: pollutes the
  operator's repo, would need git stash dance.

**File lifecycle**:

```
Pre-CANDIDATE_STARTING: write override file with candidate color
After OUTGOING_STOPPED: delete override file
On failure rollback: delete override file + remove candidate container
```

---

## R-004 — Healthcheck signal propagation from compose

**Decision**: Reuse feature 006's `wait-for-healthy` polling pattern
adapted to be container-name-aware (per slot).

```ts
// inside blue-green-orchestrator.ts during CANDIDATE_STARTING phase
async function waitForCandidateHealthy(serverId: string, candidateName: string, timeoutMs: number): Promise<HealthResult> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await sshExec(serverId,
      `docker inspect --format '{{.State.Health.Status}}' ${shQuote(candidateName)}`,
    );
    if (status === 'healthy') return { ok: true };
    if (status === 'unhealthy') return { ok: false, reason: 'compose_healthcheck_unhealthy' };
    await sleep(2_000);  // 2s poll interval, same as feature 006
  }
  return { ok: false, reason: 'timeout' };
}
```

**Rationale**:

- Feature 006 already established `wait-for-healthy` polling pattern
  for cert reconciler health checks. Same shape works here.
- `docker inspect --format '{{.State.Health.Status}}'` is the canonical
  query; works for any container with compose-defined healthcheck.
- 2s poll interval matches feature 006's convention (low overhead, fast
  enough for human-perceivable feedback).
- No new dependency — pure shell-out via `sshExec`.

**Compose healthcheck requirement**: candidate's compose service MUST
declare a `healthcheck:` directive. Apps without one cannot use
blue/green (per spec A-003 + FR-007 implicit). PATCH-time validation
in `blue-green-validator.ts` checks the parsed compose for the
`healthcheck:` field on the upstream service.

**Alternatives**:

- Curl the upstream port directly — rejected: would require knowing
  the candidate's IP, plus app might not have HTTP healthcheck. Compose
  healthcheck is the abstracted contract.
- Docker events stream (`docker events`) — rejected: feature 006
  established polling as the convention; events stream needs persistent
  connection management (disconnect / reconnect / replay), more
  complexity.

---

## R-005 — Drain timer durability: in-memory only

**Decision** (per plan D2): drain timers live in a single in-memory
`Map<appId, NodeTimerHandle>` inside `drain-timer.ts`. Dashboard restart
loses all timers; affected deploys surface via the
interrupted-deploys panel (per Q4 clarification + R-006).

```ts
// drain-timer.ts
class DrainTimerService {
  private timers = new Map<string, { handle: NodeJS.Timeout; expectedEndAt: number }>();

  start(appId: string, drainSeconds: number, onComplete: () => void): void {
    const handle = setTimeout(() => {
      this.timers.delete(appId);
      onComplete();
    }, drainSeconds * 1000);
    handle.unref();  // don't keep process alive on shutdown
    this.timers.set(appId, { handle, expectedEndAt: Date.now() + drainSeconds * 1000 });
  }

  pause(appId: string): { remainingMs: number } | null {
    const entry = this.timers.get(appId);
    if (!entry) return null;
    clearTimeout(entry.handle);
    this.timers.delete(appId);
    return { remainingMs: Math.max(0, entry.expectedEndAt - Date.now()) };
  }

  resume(appId: string, remainingMs: number, onComplete: () => void): void {
    if (remainingMs <= 0) { onComplete(); return; }
    const handle = setTimeout(() => {
      this.timers.delete(appId);
      onComplete();
    }, remainingMs);
    handle.unref();
    this.timers.set(appId, { handle, expectedEndAt: Date.now() + remainingMs });
  }

  cancel(appId: string): void {
    const entry = this.timers.get(appId);
    if (entry) clearTimeout(entry.handle);
    this.timers.delete(appId);
  }
}
```

**Rationale**:

- Single-instance dashboard assumption (A-007 of feature 011) means
  timers don't need cross-instance sync.
- Persistent durability would require either: a polling reconciler
  (cron checks elapsed time vs `deploy_state_started_at`, fires drain
  completion when due) — additional complexity for marginal benefit;
  OR a persistent timer service (Redis/queue) — out of scope, no Redis
  in this project.
- Restart loses timers, but the `interrupted-deploys-scanner.ts` finds
  the row with `deploy_state = 'OUTGOING_DRAINING'` and surfaces it
  to operator for triage. Operator decides resume vs abort.
- `handle.unref()` ensures dashboard graceful shutdown isn't blocked
  by pending timers — process can exit cleanly.

**Alternatives**:

- Polling reconciler reading `deploy_state_started_at` + `drain_seconds`
  — rejected: extra background job, less precise timing, more code.
- Persistent timer queue — rejected: requires Redis/external queue.
- Per-deploy worker process — rejected: process orchestration overkill.

**Caddy admin failure mid-drain**: when `caddy-upstream-switcher.ts`
detects admin API drop during DRAINING (typically discovered by next
operation that requires admin API, e.g. healthcheck poll), the
orchestrator calls `drainTimer.pause(appId)`. State transitions to
`FAILED_CADDY_ADMIN_POST_SWITCH`. Operator's `Mark recovered` action
calls `drainTimer.resume(appId, remainingMs, onComplete)` with the
preserved remainingMs.

---

## R-006 — Restart recovery: boot-time scan

**Decision**: `interrupted-deploys-scanner.ts` runs ONCE at server
start (called from `server/index.ts` initialization, after migrations
apply). Queries `applications WHERE deploy_state IS NOT NULL`; for each
row, probes container state via `docker inspect` (over SSH) to enrich
the panel data. Result cached in-memory; UI fetches via
`GET /api/applications/interrupted-deploys` endpoint.

```ts
// interrupted-deploys-scanner.ts
async function scanAtBoot(): Promise<InterruptedDeployRow[]> {
  const rows = await db
    .select(/* applications fields */)
    .from(applications)
    .where(isNotNull(applications.deployState));
  return Promise.all(rows.map(async (row) => {
    const candidateColor = oppositeColor(row.activeColor);
    const candidateName = `${row.composeService}-${candidateColor}`;
    const outgoingName = `${row.composeService}-${row.activeColor}`;
    const [candidateState, outgoingState] = await Promise.all([
      probeContainerState(row.serverId, candidateName),
      probeContainerState(row.serverId, outgoingName),
    ]);
    return {
      appId: row.id,
      lastPhase: row.deployState,
      lastPhaseStartedAt: row.deployStateStartedAt,
      activeColor: row.activeColor,
      candidate: { name: candidateName, state: candidateState },
      outgoing: { name: outgoingName, state: outgoingState },
    };
  }));
}

// Called once from server/index.ts during boot:
const interruptedAtBoot = await scanAtBoot();
interruptedDeploysCache.set(interruptedAtBoot);
```

**Rationale**:

- Boot-time scan is sufficient — operator panel is reactive to operator
  clicking actions (Resume/Abort/Mark complete), each of which clears
  the row and refreshes the cache.
- Periodic refresh NOT needed — between boot and operator action,
  nothing else can put rows into `deploy_state IS NOT NULL` state
  (only the orchestrator writes that column, and during normal flow
  it transitions forward).
- Probing container state via `docker inspect` enriches the panel
  with "candidate exited 5m ago" / "outgoing still running" for
  operator's decision-making.

**Alternatives**:

- Periodic re-scan every 30s — rejected: unnecessary churn, no new
  data after boot.
- WS-pushed updates — rejected: panel state changes only on
  operator action; pull-on-action is sufficient.
- Lazy scan on first panel-fetch — considered; rejected because boot-
  time scan also lets us emit a critical alert via notification gate
  if interrupted deploys are detected (operator may have missed the
  Telegram while dashboard was down).

---

## R-007 — Volume detection in compose service

**Decision**: parse compose YAML via existing `compose-parser.ts`
(feature 009), extract `services.<service>.volumes:` field. Both string-
form (`"./data:/data"`) and object-form (`{ type: bind, source: ./data,
target: /data }`) are detected. Empty array or absent field = no
volumes; PATCH validation does not require `acknowledgeVolumeSharing`
in that case.

```ts
// blue-green-validator.ts
interface DetectedVolume {
  source: string;       // host-side path or named volume
  target: string;       // container-side mount point
  mode: 'bind' | 'named' | 'tmpfs';
}

function detectVolumes(parsedCompose: ParsedCompose, serviceName: string): DetectedVolume[] {
  const service = parsedCompose.services.find((s) => s.name === serviceName);
  if (!service?.volumes) return [];
  return service.volumes.map(parseOneVolume);
}

function parseOneVolume(v: string | Record<string, unknown>): DetectedVolume {
  if (typeof v === 'string') {
    const [source, target] = v.split(':');
    return {
      source: source ?? '',
      target: target ?? source ?? '',
      mode: source?.startsWith('/') || source?.startsWith('.') ? 'bind' : 'named',
    };
  }
  return {
    source: String(v.source ?? ''),
    target: String(v.target ?? ''),
    mode: (v.type as 'bind' | 'named' | 'tmpfs') ?? 'bind',
  };
}
```

**Rationale**:

- Spec FR-008a requires PATCH-time detection + `acknowledgeVolumeSharing`
  field. Parsing logic must be exhaustive (both compose syntax forms).
- Volume metadata enriches the volume-ack panel UI (operator sees
  source paths + mode for informed decision).
- `tmpfs` volumes are per-container, NOT shared — those wouldn't
  trigger the ack requirement. Only `bind` and `named` volumes are
  cross-container persistent.

**Edge case**: anonymous volumes (compose declares `- /data` without
host source) — these ARE per-container ephemeral, but compose's
implicit naming may collide between blue/green slots. Treat as
shared-with-warning for safety: trigger ack requirement.

**Alternatives**:

- Skip volume detection, ALWAYS require ack — rejected: false-positive
  ack noise; operator has to ack even for volume-less stateless apps.
- Skip detection, NEVER require ack — rejected: violates spec FR-008a
  + operator-informed-consent principle.

---

## R-008 — First-deploy slot migration ritual

**Decision**: on PATCH that sets `deploy_strategy='blue_green'` for the
first time on an app (i.e. `active_color IS NULL` at PATCH time):
- DO NOT trigger rename at PATCH time. PATCH is a config change only.
- DO trigger rename at the START of the FIRST blue_green deploy (during
  initialization phase, before CANDIDATE_STARTING).

```ts
// blue-green-orchestrator.ts
async function startBlueGreenDeploy(appId: string, userId: string): Promise<DeployResult> {
  const app = await loadApp(appId);
  if (app.activeColor === null) {
    // First blue/green deploy — migrate existing container to blue slot
    await slotNamer.migrateExistingToBlueSlot(app.serverId, appId);
    // Now active_color = 'blue', existing container named <service>-blue
  }
  // Proceed with normal flow: candidate color = opposite of active_color
  const candidateColor = oppositeColor(app.activeColor!);
  await transitionState(appId, 'CANDIDATE_STARTING');
  // ... rest of state machine
}
```

**Rationale**:

- Deferring the rename to deploy-time keeps PATCH a pure metadata
  change — operator can flip strategy in config without touching
  containers.
- Idempotent: if `migrateExistingToBlueSlot` runs and finds the
  container already named `<service>-blue`, it's a no-op (R-002 confirms
  rename is idempotent at metadata level).
- Operator can switch strategy back to `recreate` without leaving
  artifacts — only the deploy-time first-run does the rename.

**Edge case**: operator switches `recreate → blue_green → recreate`
without ever deploying blue/green. `active_color` stays NULL; container
keeps original compose-default name. Clean revert.

**Edge case**: operator switches to `blue_green`, deploys once
(active_color='green' after), switches back to `recreate`. The next
recreate deploy finds container named `<service>-green` (sticky from
last blue/green). Recreate flow is name-agnostic — uses compose's
service name resolution, which works regardless of container_name.
After recreate's compose-up, container may get re-created with default
name (compose project semantics). `active_color` should be set to NULL
on strategy revert PATCH (per spec FR-028).
