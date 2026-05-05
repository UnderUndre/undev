# Data Model: Blue/Green Deploy with Connection Drain

**Date**: 2026-05-05 | **Branch**: `012-blue-green-deploy` | **Plan**: [plan.md](plan.md)

Canonical reference for schema additions. Every column / constraint /
audit-event-type here MUST appear in
`devops-app/server/db/migrations/0012_blue_green_deploy.sql` and
`devops-app/server/db/schema.ts`. Drift = test failure.

---

## Modified entities

### `applications` — 6 new columns

| Column | Type | Null | Default | FR | Notes |
|---|---|---|---|---|---|
| `deploy_strategy` | TEXT | no | `'recreate'` | FR-001, FR-002 | Enum `'recreate' \| 'blue_green'`. CHECK constraint enforces enum. |
| `drain_seconds` | INTEGER | no | `30` | FR-003 | Range 0..600. Validation in Zod + application layer (no DB CHECK). |
| `green_healthcheck_timeout_seconds` | INTEGER | no | `60` | FR-004 | Range 10..1800. Naming kept for stability — value applies to whichever slot is candidate this deploy (per spec Q1 clarification). |
| `active_color` | TEXT | yes | NULL | FR-001, FR-016 | Enum-or-NULL `'blue' \| 'green'` or NULL. NULL when strategy is recreate OR before first blue/green deploy. CHECK constraint. |
| `deploy_state` | TEXT | yes | NULL | FR-009, FR-010 | Current phase token (NULL when idle). One of: `CANDIDATE_STARTING \| CANDIDATE_HEALTHY \| SWITCHING \| OUTGOING_DRAINING \| OUTGOING_STOPPED \| ACTIVE \| FAILED_CANDIDATE_HEALTHCHECK \| FAILED_SWITCH \| FAILED_DRAIN_ABORT \| FAILED_CADDY_ADMIN_POST_SWITCH`. NO CHECK constraint at DB level — validation in `blue-green-state-machine.ts` (forward compat). |
| `deploy_state_started_at` | TEXT | yes | NULL | (diagnostic) | ISO-8601 UTC timestamp marking when current `deploy_state` was entered. Used by `interrupted-deploys-scanner.ts` to display "drain was at 18s when crashed". |

**State invariants**:

- `deploy_strategy='recreate'` → `active_color` SHOULD be NULL,
  `deploy_state` MUST be NULL. Switching strategy from blue_green to
  recreate clears `active_color` per FR-028.
- `deploy_strategy='blue_green'` AND `active_color IS NULL` → app is
  configured for blue/green but has never been deployed via blue/green.
  Next deploy is the "first deploy" with slot migration ritual (R-008).
- `deploy_state IS NOT NULL` → there is an active or interrupted deploy
  for this app. `deployLock` should be held (or, after restart, the
  row surfaces in interrupted-deploys panel).
- `active_color IS NULL` AND `deploy_state IS NOT NULL` → currently in
  the middle of the FIRST blue/green deploy initialization (between
  slot migration and CANDIDATE_STARTING transition).

### State transitions for `deploy_state`

```
NULL (idle)
  │
  │ operator clicks Deploy on blue_green app
  ▼
CANDIDATE_STARTING
  │
  ├─ healthcheck pass within timeout ──▶ CANDIDATE_HEALTHY
  └─ healthcheck timeout / candidate exit ──▶ FAILED_CANDIDATE_HEALTHCHECK ─────┐
                                                                                  │
CANDIDATE_HEALTHY                                                                │
  │                                                                              │
  │ orchestrator initiates Caddy switch                                          │
  ▼                                                                              │
SWITCHING                                                                        │
  │                                                                              │
  ├─ POST /load 2xx ──▶ OUTGOING_DRAINING                                        │
  └─ POST /load fails / admin unreachable ──▶ FAILED_SWITCH ────────────────────┤
                                                                                  │
OUTGOING_DRAINING                                                                │
  │                                                                              │
  ├─ drain timer elapsed ──▶ OUTGOING_STOPPED                                    │
  ├─ operator clicks Abort (typed-confirm) ──▶ FAILED_DRAIN_ABORT ──────────────┤
  └─ Caddy admin API drops mid-drain ──▶ FAILED_CADDY_ADMIN_POST_SWITCH ────────┤
                                                                                  │
FAILED_CADDY_ADMIN_POST_SWITCH (drain timer paused)                              │
  │                                                                              │
  ├─ operator clicks Mark recovered (typed-confirm) ──▶ OUTGOING_DRAINING        │
  │   (drain resumes from paused position)                                       │
  └─ operator clicks Abort (typed-confirm) ──▶ FAILED_DRAIN_ABORT ──────────────┤
                                                                                  │
OUTGOING_STOPPED                                                                 │
  │                                                                              │
  │ active_color flipped + override file deleted                                 │
  ▼                                                                              │
ACTIVE                                                                           │
  │                                                                              │
  │ deploy_state cleared to NULL within seconds                                  │
  ▼                                                                              │
NULL (idle)                                                                      │
                                                                                 │
                                                  ┌──────────────────────────────┘
                                                  ▼
                                           FAILED_* states
                                                  │
                                           operator chooses:
                                           - Retry (re-runs deploy from CANDIDATE_STARTING)
                                           - Edit Config (navigate to app edit)
                                           - View Log (failure details)
                                                  │
                                                  │ on Retry
                                                  ▼
                                           NULL (cleared, ready for next deploy)
```

**Per-FAILED-state recovery**:

| Failed state | Recovery actions |
|---|---|
| `FAILED_CANDIDATE_HEALTHCHECK` | Retry, EditConfig, ViewLog |
| `FAILED_SWITCH` | Retry, EditConfig, ViewLog |
| `FAILED_DRAIN_ABORT` | Retry, EditConfig, ViewLog |
| `FAILED_CADDY_ADMIN_POST_SWITCH` | Retry healthcheck (re-pings caddy admin), View last-known config, Mark recovered (typed-confirm), Abort (switches back) |
| `deploy_interrupted_by_restart` (synthetic, not a stored state) | Resume from `<phase>`, Abort and clean up candidate, Mark complete (typed-confirm) |

The `deploy_interrupted_by_restart` token is NOT stored as a phase
value; it's the FailureCard state synthesized at boot time when the
scanner finds rows with non-NULL `deploy_state` after dashboard restart.
The actual stored value is whatever phase the deploy was in at crash.

---

## New constraints

```sql
ALTER TABLE "applications" ADD CONSTRAINT "applications_deploy_strategy_enum"
  CHECK ("deploy_strategy" IN ('recreate', 'blue_green'));

ALTER TABLE "applications" ADD CONSTRAINT "applications_active_color_enum"
  CHECK ("active_color" IS NULL OR "active_color" IN ('blue', 'green'));
```

Numeric range constraints for `drain_seconds` and
`green_healthcheck_timeout_seconds` are application-layer only (Zod at
PATCH route + validator lib). Adding DB-level CHECKs would be a v2
defence-in-depth polish; PATCH is the only write path so route-layer
validation is sufficient.

---

## Modified entity: `audit_entries` — new event types

10 new event types per spec § Key Entities:

| Action | Payload shape |
|---|---|
| `app.deploy_strategy_changed` | `{ appId, fromStrategy, toStrategy, fromDrainSeconds?, toDrainSeconds?, fromGreenTimeout?, toGreenTimeout?, acknowledgedVolumes: string[] }` |
| `deploy.blue_green_started` | `{ appId, candidateColor, outgoingColor, drainSeconds, greenTimeoutSeconds }` |
| `deploy.candidate_healthy` | `{ appId, candidateColor, candidateName, healthyAfterMs }` |
| `deploy.traffic_switched` | `{ appId, fromColor, toColor, switchedAtIso }` |
| `deploy.drained` | `{ appId, drainElapsedMs, suppressedRequests?: number }` (suppressedRequests optional, populated only if probe-counter available) |
| `deploy.outgoing_stopped` | `{ appId, stoppedColor, stoppedName, finalActiveColor }` |
| `deploy.candidate_failed_rollback` | `{ appId, candidateColor, candidateName, failureReason: 'timeout' \| 'container_exit' \| 'unhealthy', exitCode?, timeoutSeconds?, lastLogLines: string[] }` |
| `deploy.aborted` | `{ appId, abortedFromPhase, abortedBy, candidateColor, outgoingColor }` |
| `deploy.too_late_to_abort` | `{ appId, currentPhase, attemptedBy }` |
| `deploy.caddy_admin_failure_pre_switch` | `{ appId, httpStatus?, errorMessage, retryCount }` |
| `deploy.caddy_admin_failure_post_switch` | `{ appId, candidateColor, lastKnownConfig: string, httpStatus?, errorMessage, drainElapsedAtFailureMs }` |

**Cross-feature note**: features 011, 010, and this feature add 9 + 4 +
11 = **24 new event types** total. When all three branches merge to
main, the `auditMiddleware` catalogue contains the full set. Each
feature's plan documents its delta.

---

## In-memory state shapes (no DB)

### Drain timer state (inside `drain-timer.ts`)

Not persisted. Map<appId, TimerEntry>:

```ts
interface TimerEntry {
  handle: NodeJS.Timeout;
  expectedEndAt: number;     // Date.now() + drainSeconds * 1000
  pausedAt: number | null;   // Date.now() at pause; cleared on resume
  remainingMs: number | null; // Set on pause for resume calculation
}
```

Reset on dashboard restart per Q4 + R-005. Affected rows surface via
interrupted-deploys panel.

### Interrupted deploys cache (inside `interrupted-deploys-scanner.ts`)

Populated once at server boot. Refreshed only after operator action
(Resume / Abort / Mark complete clears the row's `deploy_state` and
removes from cache).

```ts
interface InterruptedDeployRow {
  appId: string;
  appName: string;
  serverId: string;
  serverLabel: string;
  lastPhase: string;                     // value of deploy_state at boot
  lastPhaseStartedAt: string;            // ISO from deploy_state_started_at
  activeColor: 'blue' | 'green' | null;
  candidate: {
    name: string;                        // <service>-<candidate-color>
    state: 'running' | 'exited' | 'missing' | 'unhealthy';
    exitCode?: number;
  };
  outgoing: {
    name: string;
    state: 'running' | 'exited' | 'missing';
  };
}
```

---

## Cross-feature interactions

### Feature 008 — caddy-admin-client.ts

Reused unchanged. `caddy-upstream-switcher.ts` calls
`caddy.postLoad(newConfig)` for atomic switch.

### Feature 009 — compose-parser.ts

Reused unchanged. `blue-green-validator.ts` parses operator's
`docker-compose.yml` to detect:
- `services.<upstream_service>.deploy.replicas` — must be 1
- `services.<upstream_service>.network_mode` — must NOT be `host`
- `services.<upstream_service>.ports` — must NOT pin host ports
- `services.<upstream_service>.volumes` — triggers volume-ack requirement
- `services.<upstream_service>.healthcheck` — must be defined

### Feature 005 — scripts-runner.ts

Modified to bifurcate on `deploy_strategy`:

```ts
async function executeDeploy(appId: string, userId: string): Promise<DeployResult> {
  const app = await loadApp(appId);
  if (app.deployStrategy === 'blue_green') {
    return blueGreenOrchestrator.startDeploy(appId, userId);
  }
  return executeRecreateDeploy(appId, userId);  // existing path, unchanged
}
```

The recreate path remains bit-identical to today's behaviour (FR-027).

### Feature 010 — FailureCard / FAIL_PHASE / hooks

- FailureCard registry (`FAILURE_STATE_DECLARATIONS`) gains 4 new entries:
  `candidate_healthcheck_failed`, `aborted_during_drain`,
  `caddy_admin_failure_post_switch`, `deploy_interrupted_by_restart`.
- FAIL_PHASE enum (consumed by `on_fail` hook env builder) gains 6 new
  values: `candidate_starting`, `candidate_healthcheck`, `switching`,
  `outgoing_draining`, `outgoing_stopping`, `caddy_admin_post_switch`.
- `pre_deploy` / `post_deploy` / `pre_destroy` / `on_fail` hook
  contracts unchanged.

### Feature 011 — notification catalogue

`EVENT_CATALOGUE` (in `event-catalogue.ts`) gains 5 new entries:

```ts
{ type: "deploy.candidate_failed_rollback", description: "Blue/green: candidate failed healthcheck, rolled back", defaultEnabled: true, category: "failure" },
{ type: "deploy.aborted", description: "Blue/green: operator aborted during drain", defaultEnabled: true, category: "security" },
{ type: "deploy.caddy_admin_failure_pre_switch", description: "Blue/green: Caddy admin unreachable before switch (deploy aborted, no impact)", defaultEnabled: true, category: "failure" },
{ type: "deploy.caddy_admin_failure_post_switch", description: "Blue/green: Caddy admin unreachable after switch (manual recovery required)", defaultEnabled: true, category: "failure" },
{ type: "deploy.blue_green_succeeded", description: "Blue/green deploy completed successfully", defaultEnabled: false, category: "success" },
```

Default-enabled state per spec § Notification triggers.

### Feature 004 — deployLock

Reused. Blue/green deploys acquire the same per-app lock as recreate
deploys. Concurrent deploys on the same app are serialized regardless
of strategy.

---

## Index strategy

- `applications.deploy_state` — partial index `WHERE deploy_state IS NOT NULL`
  speeds up the boot-time scan. Worth adding because the column is NULL
  for the vast majority of rows (only 0..N at any moment, where N is
  active blue/green deploys).

```sql
CREATE INDEX "idx_applications_deploy_state_active"
  ON "applications" ("deploy_state")
  WHERE "deploy_state" IS NOT NULL;
```

This is the only new index for this feature. Other access patterns
(per-app lookup) covered by existing PK.

---

## Validation rules summary

| FR | Rule | Enforced by |
|---|---|---|
| FR-002 | `deploy_strategy` enum | DB CHECK + Zod |
| FR-003 | `drain_seconds` 0..600 | Zod + application validator |
| FR-004 | `green_healthcheck_timeout_seconds` 10..1800 | Zod + application validator |
| FR-006 | `blue_green` requires `proxy_type='caddy'` | `blue-green-validator.ts` cross-field check |
| FR-007 | `blue_green` requires `replicas=1` | `blue-green-validator.ts` parse check |
| FR-008 | `blue_green` requires no `network_mode:host` and no host port pins | `blue-green-validator.ts` parse check |
| FR-008a | volumes detected → `acknowledgeVolumeSharing: true` required | `blue-green-validator.ts` + Zod superRefine |
| A-003 | compose service has `healthcheck:` directive | `blue-green-validator.ts` parse check |
| FR-014 | Drain window honours `drain_seconds` | `drain-timer.ts` setTimeout |
| FR-015 | At end of drain, SIGTERM then SIGKILL after stop_grace_period | `blue-green-orchestrator.ts` shell-out to `docker compose stop --timeout` |
| FR-016 | `active_color` flips after OUTGOING_STOPPED | `blue-green-orchestrator.ts` DB UPDATE in same tx as state transition |

---

## Migration test fixtures

`tests/fixtures/applications-pre-0012.ts` — pre-migration row shapes:

```ts
export const APP_ROW_PRE_0012 = {
  id: "app_legacy",
  // ... existing columns ...
  // (no deploy_strategy, drain_seconds, etc — they don't exist yet)
};

export const APP_ROW_POST_MIGRATE = {
  // After ALTER TABLE 0012:
  deployStrategy: "recreate",                     // DEFAULT applied
  drainSeconds: 30,
  greenHealthcheckTimeoutSeconds: 60,
  activeColor: null,
  deployState: null,
  deployStateStartedAt: null,
};

export const APP_ROW_POST_FIRST_BG_DEPLOY = {
  deployStrategy: "blue_green",
  drainSeconds: 30,
  greenHealthcheckTimeoutSeconds: 60,
  activeColor: "green",                           // candidate became active
  deployState: null,                              // back to idle after ACTIVE → NULL
  deployStateStartedAt: null,
};

export const APP_ROW_INTERRUPTED_BY_RESTART = {
  deployStrategy: "blue_green",
  drainSeconds: 30,
  greenHealthcheckTimeoutSeconds: 60,
  activeColor: "blue",                            // pre-deploy state
  deployState: "OUTGOING_DRAINING",               // crashed mid-drain
  deployStateStartedAt: "2026-05-05T14:23:01.123Z",
};
```
