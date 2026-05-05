# State Machine Contract: Blue/Green Deploy

**Date**: 2026-05-05 | **Branch**: `012-blue-green-deploy` | **Plan**: [../plan.md](../plan.md)

This is the operational contract for `blue-green-state-machine.ts` —
the pure-data transition table + `canTransition()` helper that gates
every phase change in `blue-green-orchestrator.ts`.

---

## State machine diagram

```
                    ┌─────────────┐
                    │ NULL (idle) │
                    └──────┬──────┘
                           │
                           │ operator clicks Deploy
                           │ (deploy_strategy='blue_green')
                           │
        ┌──────────────────┴──────────────────┐
        │  First-deploy initialization:        │
        │   active_color IS NULL → docker      │
        │   rename existing → active_color     │
        │   = 'blue'                           │
        └──────────────────┬──────────────────┘
                           ▼
                ┌──────────────────────┐
                │ CANDIDATE_STARTING   │
                │  (compose up         │
                │  --no-deps for       │
                │  candidate slot)     │
                └─────┬──────────────┬─┘
                      │              │
        candidate     │              │ healthcheck timeout / exit
        passes        │              │
        healthcheck   ▼              ▼
                ┌──────────────────────┐    ┌────────────────────────────┐
                │ CANDIDATE_HEALTHY    │    │ FAILED_CANDIDATE_HEALTHCHECK│
                └─────┬────────────────┘    └────────────────────────────┘
                      │                              │
                      │ orchestrator initiates       │ FailureCard:
                      │ Caddy switch                 │  Retry / EditConfig / ViewLog
                      ▼
                ┌──────────────────────┐
                │ SWITCHING            │
                │  (POST /load to      │
                │  Caddy admin)        │
                └─────┬────────────┬───┘
                      │            │
        Caddy 2xx     │            │ Caddy 4xx/5xx / unreachable
                      ▼            ▼
                ┌────────────────┐  ┌──────────────────┐
                │OUTGOING_DRAINING│  │ FAILED_SWITCH    │
                │ (drain timer)  │  └──────────────────┘
                └─┬────────┬─────┴──────┐
                  │        │            │
       drain      │ Caddy  │ operator   │
       elapsed    │ admin  │ clicks     │
                  │ drops  │ Abort      │
                  ▼        ▼            ▼
            ┌────────────┐ ┌────────────┐ ┌──────────────────┐
            │OUTGOING_   │ │FAILED_     │ │ FAILED_DRAIN_    │
            │STOPPED     │ │CADDY_ADMIN_│ │ ABORT            │
            └─────┬──────┘ │POST_SWITCH │ └──────────────────┘
                  │        │ (timer     │
                  │        │ paused)    │
                  ▼        └─┬────────┬─┘
            ┌──────────┐     │        │
            │ ACTIVE   │     │ Mark   │ Abort
            └────┬─────┘     │recover │ (typed-
                 │           │ed      │ confirm)
                 │           ▼        ▼
                 │     ┌──────────┐  (back to FAILED_DRAIN_ABORT)
                 │     │ resumes  │
                 │     │ OUTGOING │
                 │     │_DRAINING │
                 │     └──────────┘
                 ▼
            ┌──────────┐
            │ NULL     │
            │ (cleared)│
            └──────────┘
```

---

## Transition table (canonical)

```ts
// blue-green-state-machine.ts

export type Phase =
  | "CANDIDATE_STARTING"
  | "CANDIDATE_HEALTHY"
  | "SWITCHING"
  | "OUTGOING_DRAINING"
  | "OUTGOING_STOPPED"
  | "ACTIVE"
  | "FAILED_CANDIDATE_HEALTHCHECK"
  | "FAILED_SWITCH"
  | "FAILED_DRAIN_ABORT"
  | "FAILED_CADDY_ADMIN_POST_SWITCH";

export type PhaseOrIdle = Phase | null;  // null = idle

export interface Transition {
  from: PhaseOrIdle;
  to: PhaseOrIdle;
  trigger: string;                      // human-readable reason
  requiresOperatorAction: boolean;      // true for typed-confirm transitions
  resetsDrainTimer: boolean;
  pausesDrainTimer: boolean;
  resumesDrainTimer: boolean;
  emitsAuditEvent: string;
}

export const TRANSITIONS: ReadonlyArray<Transition> = [
  // Happy path
  { from: null, to: "CANDIDATE_STARTING", trigger: "operator_clicked_deploy", requiresOperatorAction: false, resetsDrainTimer: false, pausesDrainTimer: false, resumesDrainTimer: false, emitsAuditEvent: "deploy.blue_green_started" },
  { from: "CANDIDATE_STARTING", to: "CANDIDATE_HEALTHY", trigger: "compose_healthcheck_pass", requiresOperatorAction: false, resetsDrainTimer: false, pausesDrainTimer: false, resumesDrainTimer: false, emitsAuditEvent: "deploy.candidate_healthy" },
  { from: "CANDIDATE_HEALTHY", to: "SWITCHING", trigger: "orchestrator_initiated_switch", requiresOperatorAction: false, resetsDrainTimer: false, pausesDrainTimer: false, resumesDrainTimer: false, emitsAuditEvent: "deploy.switching_started" },
  { from: "SWITCHING", to: "OUTGOING_DRAINING", trigger: "caddy_post_load_2xx", requiresOperatorAction: false, resetsDrainTimer: true, pausesDrainTimer: false, resumesDrainTimer: false, emitsAuditEvent: "deploy.traffic_switched" },
  { from: "OUTGOING_DRAINING", to: "OUTGOING_STOPPED", trigger: "drain_timer_elapsed", requiresOperatorAction: false, resetsDrainTimer: false, pausesDrainTimer: false, resumesDrainTimer: false, emitsAuditEvent: "deploy.drained" },
  { from: "OUTGOING_STOPPED", to: "ACTIVE", trigger: "outgoing_container_stopped_and_active_color_flipped", requiresOperatorAction: false, resetsDrainTimer: false, pausesDrainTimer: false, resumesDrainTimer: false, emitsAuditEvent: "deploy.outgoing_stopped" },
  { from: "ACTIVE", to: null, trigger: "cleanup_complete", requiresOperatorAction: false, resetsDrainTimer: false, pausesDrainTimer: false, resumesDrainTimer: false, emitsAuditEvent: "deploy.blue_green_succeeded" },

  // Failure paths
  { from: "CANDIDATE_STARTING", to: "FAILED_CANDIDATE_HEALTHCHECK", trigger: "compose_healthcheck_timeout_or_exit", requiresOperatorAction: false, resetsDrainTimer: false, pausesDrainTimer: false, resumesDrainTimer: false, emitsAuditEvent: "deploy.candidate_failed_rollback" },
  { from: "SWITCHING", to: "FAILED_SWITCH", trigger: "caddy_post_load_failed", requiresOperatorAction: false, resetsDrainTimer: false, pausesDrainTimer: false, resumesDrainTimer: false, emitsAuditEvent: "deploy.caddy_admin_failure_pre_switch" },
  { from: "OUTGOING_DRAINING", to: "FAILED_CADDY_ADMIN_POST_SWITCH", trigger: "caddy_admin_dropped_mid_drain", requiresOperatorAction: false, resetsDrainTimer: false, pausesDrainTimer: true, resumesDrainTimer: false, emitsAuditEvent: "deploy.caddy_admin_failure_post_switch" },
  { from: "OUTGOING_DRAINING", to: "FAILED_DRAIN_ABORT", trigger: "operator_aborted", requiresOperatorAction: true, resetsDrainTimer: false, pausesDrainTimer: false, resumesDrainTimer: false, emitsAuditEvent: "deploy.aborted" },

  // Recovery paths
  { from: "FAILED_CADDY_ADMIN_POST_SWITCH", to: "OUTGOING_DRAINING", trigger: "operator_marked_recovered_or_retry_healthcheck_pass", requiresOperatorAction: true, resetsDrainTimer: false, pausesDrainTimer: false, resumesDrainTimer: true, emitsAuditEvent: "deploy.caddy_admin_recovered" },
  { from: "FAILED_CADDY_ADMIN_POST_SWITCH", to: "FAILED_DRAIN_ABORT", trigger: "operator_aborted_during_caddy_recovery", requiresOperatorAction: true, resetsDrainTimer: false, pausesDrainTimer: false, resumesDrainTimer: false, emitsAuditEvent: "deploy.aborted" },

  // Cleanup paths (failed → null after operator chooses Retry / Cleanup)
  { from: "FAILED_CANDIDATE_HEALTHCHECK", to: null, trigger: "operator_clicked_retry_or_cleanup", requiresOperatorAction: true, resetsDrainTimer: false, pausesDrainTimer: false, resumesDrainTimer: false, emitsAuditEvent: "deploy.failure_cleared" },
  { from: "FAILED_SWITCH", to: null, trigger: "operator_clicked_retry_or_cleanup", requiresOperatorAction: true, resetsDrainTimer: false, pausesDrainTimer: false, resumesDrainTimer: false, emitsAuditEvent: "deploy.failure_cleared" },
  { from: "FAILED_DRAIN_ABORT", to: null, trigger: "abort_cleanup_complete", requiresOperatorAction: false, resetsDrainTimer: false, pausesDrainTimer: false, resumesDrainTimer: false, emitsAuditEvent: "deploy.failure_cleared" },
];

export function canTransition(from: PhaseOrIdle, to: PhaseOrIdle): boolean {
  return TRANSITIONS.some((t) => t.from === from && t.to === to);
}

export function findTransition(from: PhaseOrIdle, to: PhaseOrIdle): Transition | undefined {
  return TRANSITIONS.find((t) => t.from === from && t.to === to);
}
```

---

## FailureCard mount mapping

Per feature 010 contract, each failure phase token maps to a
FailureCard `state` value with declared `defaultActionKinds`:

| Phase | FailureCard state | Default action kinds |
|---|---|---|
| `FAILED_CANDIDATE_HEALTHCHECK` | `candidate_healthcheck_failed` | `Retry`, `EditConfig`, `ViewLog` |
| `FAILED_SWITCH` | `caddy_admin_failure_pre_switch` | `Retry`, `EditConfig`, `ViewLog` |
| `FAILED_DRAIN_ABORT` | `aborted_during_drain` | `Retry`, `ViewLog` |
| `FAILED_CADDY_ADMIN_POST_SWITCH` | `caddy_admin_failure_post_switch` | `Custom: "Retry healthcheck"`, `Custom: "View last-known config"`, `Custom: "Mark recovered"` (typed-confirm), `Custom: "Abort"` (typed-confirm) |
| (synthesized at boot) | `deploy_interrupted_by_restart` | `Custom: "Resume from <phase>"`, `Custom: "Abort and clean up"`, `Custom: "Mark complete"` (typed-confirm) |

These declarations live in `failure-state-declarations.ts` (server-side
data registry per feature 010 R-009 split). Client-side
`failure-state-wiring.ts` provides the actual callbacks.

---

## FAIL_PHASE env enum extension (feature 010 hook integration)

Feature 010's `on_fail` hook receives a `FAIL_PHASE` env var with the
phase name where failure occurred. This feature extends the enum with
6 new values:

```ts
// feature 010's on_fail hook env builder
const FAIL_PHASE_ENUM = [
  // existing values from features 005/010:
  "git_fetch", "pre_deploy", "compose_up", "post_deploy",
  // new values added by 012:
  "candidate_starting",
  "candidate_healthcheck",
  "switching",
  "outgoing_draining",
  "outgoing_stopping",
  "caddy_admin_post_switch",
] as const;
```

Mapping from blue-green failure phase to `FAIL_PHASE` value:

| Failure phase | FAIL_PHASE value |
|---|---|
| `FAILED_CANDIDATE_HEALTHCHECK` (during CANDIDATE_STARTING phase) | `candidate_starting` if container exited; `candidate_healthcheck` if timeout |
| `FAILED_SWITCH` | `switching` |
| `FAILED_DRAIN_ABORT` | `outgoing_draining` |
| `FAILED_CADDY_ADMIN_POST_SWITCH` | `caddy_admin_post_switch` |

The `on_fail` hook fires once per failure with the appropriate
FAIL_PHASE value. Operators can route alerts by phase
(e.g. `caddy_admin_post_switch` → page on-call critical; `candidate_healthcheck`
→ Slack #deploys).

---

## Cross-feature audit events

Per feature 011 + 010 + 012 audit-middleware extension, the merged
catalogue across all three features carries 24 new event types. This
feature's 11 listed below; full list in feature 011 + 010 + 012's
`data-model.md` event tables.

This feature's audit events:

```
app.deploy_strategy_changed
deploy.blue_green_started
deploy.candidate_healthy
deploy.traffic_switched
deploy.drained
deploy.outgoing_stopped
deploy.candidate_failed_rollback
deploy.aborted
deploy.too_late_to_abort
deploy.caddy_admin_failure_pre_switch
deploy.caddy_admin_failure_post_switch
deploy.caddy_admin_recovered (synthetic — emitted on FAILED_CADDY_ADMIN_POST_SWITCH → OUTGOING_DRAINING transition)
deploy.failure_cleared (synthetic — emitted when operator clears any FAILED_* state)
deploy.blue_green_succeeded (emitted on ACTIVE → null transition)
deploy.interrupted_resumed
deploy.interrupted_aborted_cleanup
deploy.interrupted_marked_complete_by_operator
deploy.caddy_admin_marked_recovered_by_operator
deploy.caddy_admin_recovered_via_retry
```

---

## Notification gate integration

Per feature 011's `notification_preferences` + `EVENT_CATALOGUE`, this
feature contributes 5 entries to the catalogue (per spec § Notification
triggers + plan Cross-feature coordination):

```ts
{ type: "deploy.candidate_failed_rollback", description: "Blue/green: candidate failed healthcheck, rolled back", defaultEnabled: true, category: "failure" },
{ type: "deploy.aborted", description: "Blue/green: operator aborted during drain", defaultEnabled: true, category: "security" },
{ type: "deploy.caddy_admin_failure_pre_switch", description: "Blue/green: Caddy admin unreachable before switch (deploy aborted)", defaultEnabled: true, category: "failure" },
{ type: "deploy.caddy_admin_failure_post_switch", description: "Blue/green: Caddy admin unreachable after switch (manual recovery required)", defaultEnabled: true, category: "failure" },
{ type: "deploy.blue_green_succeeded", description: "Blue/green deploy completed", defaultEnabled: false, category: "success" },
```

Other 6 audit events from this feature are NOT notification events —
they're forensic-only (audit log + UI display, no TG message).

---

## Test invariants

For `blue-green-state-machine.test.ts`:

1. Every transition in `TRANSITIONS` has all required fields populated.
2. `canTransition()` returns true for every documented transition;
   false for non-documented (sample 5 random invalid transitions).
3. No transition has both `pausesDrainTimer: true` AND
   `resumesDrainTimer: true` (mutually exclusive).
4. Every Phase value appears at least once as a `from` and at least
   once as a `to` in TRANSITIONS (no orphan states).
5. Every FAILED_* state has at least one outgoing transition (operator
   can recover or clear).

For `blue-green-orchestrator.test.ts`:

1. State transitions wrapped in DB tx — UPDATE deploy_state +
   `audit_entries` INSERT same tx.
2. WS broadcast happens AFTER DB commit (R-012 of feature 009 R-008).
3. Operator-action transitions (typed-confirm) reject without typed
   confirmation match.
4. `pausesDrainTimer` / `resumesDrainTimer` calls hit the in-memory
   timer service correctly.
