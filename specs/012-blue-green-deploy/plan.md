# Implementation Plan: Blue/Green Deploy with Connection Drain

**Branch**: `012-blue-green-deploy` | **Date**: 2026-05-05 | **Spec**: [spec.md](spec.md)

## Summary

Add a SECOND deploy strategy alongside the existing recreate-in-place
flow. Blue/green deploys spawn the candidate container in parallel with
the outgoing one, wait for compose-defined healthcheck, atomically
switch Caddy upstream, drain in-flight requests for an
operator-configurable window, then stop the outgoing container. Recreate
strategy stays default + bit-identical for backwards compatibility per
spec FR-027.

The story shape is **state-machine + integration-heavy**. New abstractions:
one orchestrator (`blue-green-orchestrator.ts`), one state machine
(`blue-green-state-machine.ts`), one upstream switcher
(`caddy-upstream-switcher.ts`), one drain timer manager
(`drain-timer.ts`), one slot namer (`slot-namer.ts`), one interrupted
scanner (`interrupted-deploys-scanner.ts`), one validator
(`blue-green-validator.ts`), one compose-override generator
(`compose-override-generator.ts`). Plus 6 manual-recovery RPCs in a new
`routes/blue-green.ts` file.

Architectural shape:

- **Schema additions** live in `0012_blue_green_deploy.sql`. Sequence
  fixed: feature 011 reserves 0010, feature 010 reserves 0011, this
  feature gets 0012. Merge order at integration: 0010 → 0011 → 0012.
- **Phase tokens are neutral and role-based** (per spec Q1 clarification):
  `CANDIDATE_STARTING`, `CANDIDATE_HEALTHY`, `SWITCHING`,
  `OUTGOING_DRAINING`, `OUTGOING_STOPPED`, `ACTIVE`, plus 4 failure
  variants. `active_color` toggles after each successful deploy. Container
  names are sticky per slot (`<service>-blue` / `<service>-green`) — no
  rename rituals after the one-time first-deploy migration.
- **Compose dual-container** orchestrated via dynamically-generated
  override compose file per slot (per D1 confirmation): explicit
  `container_name: <service>-<slot>` in the override, deterministic
  container identity, no `--scale` magic.
- **Drain timer** lives in-memory only (per D2): Map<appId,
  NodeTimerHandle>. On dashboard restart, all timers lost; affected
  deploys surface via the interrupted-deploys panel for manual triage.
- **Volume sharing** allowed but requires PATCH-time
  `acknowledgeVolumeSharing: true` (per spec Q2 clarification). Volume
  detection reuses feature 009's compose parser.
- **Caddy admin post-switch failure** halts drain and surfaces a
  dedicated FailureCard with manual-recovery actions (per spec Q3).
- **Restart recovery** surfaces an "Interrupted deploys" panel on the
  apps list at boot; operator picks Resume / Abort / Mark complete per
  row (per spec Q4).
- **SC-001 measurability**: integration-test gate fires request-flood
  during normal deploy, asserts 100% completion; catastrophic-injection
  tests allowed to fail SC-001 but MUST go through the documented
  recovery flow (per spec Q5).

Backwards compatibility: apps with `deploy_strategy='recreate'` (the
default) use existing deploy flow exactly as today — feature 005's
deploy entry point bifurcates ONLY on the strategy column.

## Technical Context

**Existing stack** (inherited 001–011):

- Express 5 + React 19 / Vite 8 / Tailwind 4
- drizzle-orm 0.45 + `postgres` 3.4
- `scriptsRunner.runScript(scriptId, serverId, params, userId, opts)`
  (feature 005) — extension point for blue-green dispatch
- `auditMiddleware` (feature 001) emitting `audit_entries`
- File-tail modal (feature 009) for live script output
- `caddy-admin-client.ts` (feature 008) — atomic config replace via
  `POST /load`. Reused unchanged for blue-green upstream switch.
- `compose-parser.ts` (feature 009) — YAML parsing + service detection.
  Reused for volume detection in blue-green PATCH validation.
- `wait-for-healthy` convention (feature 006) — reused for
  CANDIDATE_HEALTHY signal.
- `deployLock` (feature 004) — per-app advisory lock; blue-green deploys
  acquire same lock as recreate (no concurrent deploys per app).
- Pino logger with redact config.
- FailureCard contract (feature 010) — `FailureAction` discriminated
  union. This feature contributes 4 new state tokens to the registry.
- Notification gate (feature 011) — `notification_preferences` table.
  This feature contributes 5 new event types to the catalogue.

**Existing scripts** (no new ones for this feature):

- `scripts/deploy/server-deploy.sh` — recreate-strategy unchanged.
- New blue-green flow does NOT add a shell script — orchestration is
  Node-side via `docker compose` shell-outs (executed via
  `executeWithStdin`) inside `blue-green-orchestrator.ts`.

**New for this feature**:

- One new migration: `devops-app/server/db/migrations/0012_blue_green_deploy.sql`.
- Five new columns on `applications`: `deploy_strategy`, `drain_seconds`,
  `green_healthcheck_timeout_seconds`, `active_color`, `deploy_state`.
- One additional column for diagnostics: `deploy_state_started_at TEXT NULL`.
- Two CHECK constraints: deploy_strategy enum, active_color enum-or-null.
- New audit event types (10): app.deploy_strategy_changed,
  deploy.blue_green_started, deploy.candidate_healthy,
  deploy.traffic_switched, deploy.drained, deploy.outgoing_stopped,
  deploy.candidate_failed_rollback, deploy.aborted,
  deploy.too_late_to_abort, deploy.caddy_admin_failure_pre_switch,
  deploy.caddy_admin_failure_post_switch.
- 8 new server libs / services (see Project Structure).
- 1 new route file (6 manual-recovery RPCs).
- 11 new client components / hooks.
- No new npm dependencies. All work via existing `docker compose` CLI
  shell-outs + existing Caddy admin client + existing compose parser.

**Unknowns resolved in [research.md](research.md)**:

- R-001: Caddy admin `POST /load` atomic config-replace semantics
- R-002: `docker rename` atomicity (zero-downtime metadata-only operation)
- R-003: Compose dual-container approach via override file (D1)
- R-004: Healthcheck signal propagation from compose to orchestrator
- R-005: Drain timer durability (in-memory per D2)
- R-006: Restart recovery scan strategy (boot-time scan + periodic refresh?)
- R-007: Volume detection patterns in compose service definition
- R-008: First-deploy slot migration ritual via `docker rename`

## Project Structure

```
undev/
├── specs/012-blue-green-deploy/
│   ├── spec.md                                  # [EXISTING — clarified through Session 2026-05-05]
│   ├── plan.md                                  # [NEW — this file]
│   ├── research.md                              # [NEW — R-001..R-008]
│   ├── data-model.md                            # [NEW — schema, state machine, audit events]
│   ├── quickstart.md                            # [NEW — operator walkthrough]
│   └── contracts/
│       ├── api.md                               # [NEW — HTTP endpoints, manual-recovery RPCs]
│       └── state-machine.md                     # [NEW — phase token transitions, recovery flows]
└── devops-app/
    ├── server/
    │   ├── db/
    │   │   ├── schema.ts                        # [MOD — 5 new cols + diagnostics col]
    │   │   └── migrations/
    │   │       └── 0012_blue_green_deploy.sql   # [NEW — additive ALTER + CHECK]
    │   ├── lib/
    │   │   ├── blue-green-validator.ts          # [NEW — PATCH validation: replicas, network_mode, ports, volumes ack]
    │   │   ├── blue-green-state-machine.ts      # [NEW — pure-data transition table + canTransition()]
    │   │   └── compose-override-generator.ts    # [NEW — generates per-slot override compose YAML with container_name]
    │   ├── services/
    │   │   ├── blue-green-orchestrator.ts       # [NEW — drives state machine; per-phase actions; audit emit before WS]
    │   │   ├── caddy-upstream-switcher.ts       # [NEW — wraps caddy-admin-client.ts for blue-green-specific switches]
    │   │   ├── drain-timer.ts                   # [NEW — in-memory Map<appId, NodeTimerHandle>; pause/resume/cancel]
    │   │   ├── slot-namer.ts                    # [NEW — first-deploy `docker rename` ritual + slot resolution]
    │   │   ├── interrupted-deploys-scanner.ts   # [NEW — boot-time scan + periodic refresh; surfaces panel data]
    │   │   └── scripts-runner.ts                # [MOD — bifurcates on deploy_strategy; recreate path bit-identical]
    │   └── routes/
    │       ├── apps.ts                          # [MOD — PATCH validation via blue-green-validator]
    │       └── blue-green.ts                    # [NEW — 6 manual-recovery RPCs]
    ├── client/
    │   ├── components/
    │   │   ├── apps/
    │   │   │   ├── EditAppForm.tsx              # [MOD — embed <DeployStrategySection>]
    │   │   │   ├── DeployStrategySection.tsx    # [NEW — strategy dropdown + drain inputs + volume ack]
    │   │   │   ├── VolumeAckPanel.tsx           # [NEW — list detected volumes + safety hint + checkbox]
    │   │   │   └── InterruptedDeploysPanel.tsx  # [NEW — mounts at top of AppsList; per-row actions]
    │   │   └── deploy/
    │   │       ├── BlueGreenDeployLog.tsx       # [NEW — replaces standard DeployLog when strategy=blue_green]
    │   │       ├── BlueGreenPhaseIndicator.tsx  # [NEW — visual state machine progress]
    │   │       ├── DrainCountdown.tsx           # [NEW — real-time countdown OR static (per OQ-001 design call)]
    │   │       ├── AbortDuringDrainDialog.tsx   # [NEW — typed-confirm before abort]
    │   │       └── CaddyAdminFailureRecoveryDialog.tsx  # [NEW — Retry/View config/Mark recovered]
    │   ├── hooks/
    │   │   ├── useDeployStrategy.ts             # [NEW — fetch + mutate deploy_strategy + drain settings]
    │   │   ├── useBlueGreenDeployState.ts       # [NEW — WS subscription to phase changes + REST fallback poll]
    │   │   └── useInterruptedDeploys.ts         # [NEW — boot-time + periodic refresh of panel data]
    │   └── pages/
    │       └── AppsList.tsx                     # [MOD — render <InterruptedDeploysPanel> at top when non-empty]
    └── tests/
        ├── unit/
        │   ├── blue-green-validator.test.ts     # [NEW — replicas/network/ports/volumes validation matrix]
        │   ├── blue-green-state-machine.test.ts # [NEW — every valid + invalid transition; canTransition() truth table]
        │   ├── compose-override-generator.test.ts # [NEW — fixture compose YAML → expected override; container_name sticky]
        │   ├── caddy-upstream-switcher.test.ts  # [NEW — mock caddy-admin-client; assert atomic switch + rollback semantics]
        │   ├── drain-timer.test.ts              # [NEW — start/pause/resume/cancel; cleanup on app delete]
        │   ├── slot-namer.test.ts               # [NEW — first-deploy rename happy path + idempotent re-run]
        │   └── interrupted-deploys-scanner.test.ts # [NEW — boot scan finds non-NULL deploy_state rows + container state probes]
        └── integration/
            ├── blue-green-happy-path.test.ts    # [NEW — full state machine: CANDIDATE_STARTING → ACTIVE]
            ├── blue-green-candidate-fail.test.ts # [NEW — green healthcheck fails → rollback, traffic stays blue]
            ├── blue-green-abort-during-drain.test.ts # [NEW — operator aborts mid-drain → switch back, candidate stopped]
            ├── blue-green-caddy-failure-pre-switch.test.ts # [NEW — admin API down before switch → abort, no rollback needed]
            ├── blue-green-caddy-failure-post-switch.test.ts # [NEW — admin API down mid-drain → drain pauses, FailureCard]
            ├── blue-green-restart-recovery.test.ts # [NEW — kill dashboard mid-DRAINING; boot scan; operator chooses Resume]
            ├── blue-green-volume-ack.test.ts    # [NEW — PATCH with volumes=present + ack=false → 400; ack=true → 200]
            ├── blue-green-recreate-no-regression.test.ts # [NEW — recreate strategy unchanged; existing test fixtures pass]
            └── blue-green-sc-001-request-flood.test.ts # [NEW — request-flood during deploy; asserts 100% completion]
```

## Migration plan

`devops-app/server/db/migrations/0012_blue_green_deploy.sql` — additive
only. Sequence number 0012; merge order 0010 → 0011 → 0012 ensures no
schema collision across the three sibling branches.

### Applications — 6 new columns

```sql
ALTER TABLE "applications" ADD COLUMN "deploy_strategy" TEXT NOT NULL DEFAULT 'recreate';
ALTER TABLE "applications" ADD COLUMN "drain_seconds" INTEGER NOT NULL DEFAULT 30;
ALTER TABLE "applications" ADD COLUMN "green_healthcheck_timeout_seconds" INTEGER NOT NULL DEFAULT 60;
ALTER TABLE "applications" ADD COLUMN "active_color" TEXT NULL;
ALTER TABLE "applications" ADD COLUMN "deploy_state" TEXT NULL;
ALTER TABLE "applications" ADD COLUMN "deploy_state_started_at" TEXT NULL;

ALTER TABLE "applications" ADD CONSTRAINT "applications_deploy_strategy_enum"
  CHECK ("deploy_strategy" IN ('recreate', 'blue_green'));

ALTER TABLE "applications" ADD CONSTRAINT "applications_active_color_enum"
  CHECK ("active_color" IS NULL OR "active_color" IN ('blue', 'green'));

-- deploy_state enum is broader; intentionally NOT a CHECK constraint to
-- allow forward-compat. Validation lives in application code via
-- blue-green-state-machine.ts.
```

Numeric range constraints for `drain_seconds` (0..600) and
`green_healthcheck_timeout_seconds` (10..1800) live in Zod at PATCH time
+ application-layer guards. Adding DB-level CHECK for these is optional
(extra defence-in-depth but rarely needed because PATCH is the only
write path).

### DOWN migration (manual, operator-gated)

```sql
-- WARNING: rows with deploy_state IS NOT NULL must be cleaned up first
-- (interrupted deploys); rows with active_color != NULL must accept
-- the strategy revert.
-- ALTER TABLE "applications" DROP CONSTRAINT "applications_active_color_enum";
-- ALTER TABLE "applications" DROP CONSTRAINT "applications_deploy_strategy_enum";
-- ALTER TABLE "applications" DROP COLUMN "deploy_state_started_at";
-- ALTER TABLE "applications" DROP COLUMN "deploy_state";
-- ALTER TABLE "applications" DROP COLUMN "active_color";
-- ALTER TABLE "applications" DROP COLUMN "green_healthcheck_timeout_seconds";
-- ALTER TABLE "applications" DROP COLUMN "drain_seconds";
-- ALTER TABLE "applications" DROP COLUMN "deploy_strategy";
```

## Constitution Check

No `.specify/memory/constitution.md` in repo. CLAUDE.md Standing Orders +
AGCG serve as proxy (same convention as features 010/011).

| Rule (CLAUDE.md) | Status | Notes |
|---|---|---|
| #1 Never commit/push without request | ✓ | Plan is files only |
| #2 Never install packages without approval | ✓ | **Zero new npm deps** |
| #3 Never use `--force / --yes / -y` flags | ✓ | All destructive flows (abort, force-stop) require typed-confirm |
| #4 Never put secrets in code/commits/logs | ✓ | No new secret material introduced |
| #5 Never run migrations directly | ✓ | `0012` ships as reviewable SQL |
| #6 No destructive without 3x consent | ✓ | Abort during drain + interrupted-deploys cleanup both require typed-confirm dialogs |
| #7 Never read .env unless asked | ✓ | Operator-supplied env vars consumed via existing env-vars-store path (feature 011 / 010) |
| AGCG: no `as any` | ✓ | All state-machine transitions typed via discriminated unions |
| AGCG: no `throw new Error()` raw | ✓ | Use `AppError.*` factories |
| AGCG: no `console.log` | ✓ | Pino with `ctx` |
| AGCG: no swallowed `catch (e) { }` | ✓ | All catches log + re-throw or convert to typed result |
| AGCG: no `req.body.field` without Zod | ✓ | Every new route validates body |
| AGCG: no `dangerouslySetInnerHTML` | ✓ | All UI uses React tree |

**Gate status: PASS.** No waivers.

## Phase 0: Outline & Research

Output: [research.md](research.md). Resolves R-001..R-008. Each entry
has Decision / Rationale / Alternatives.

Key resolutions:

- **R-001** Caddy `POST /load` atomic semantics: yes, atomic at
  config-tree-replace level. New requests after the response see new
  upstream; in-flight requests on old upstream complete on old. This
  is the entire foundation of zero-drop switch.
- **R-002** `docker rename` zero-downtime: confirmed via Docker docs.
  Pure metadata operation in containerd's bookkeeping; no container
  restart, no network blip. Safe for first-deploy migration ritual.
- **R-003** Compose dual-container via override file (per D1): generate
  `<app>/docker-compose.bg-override.yml` containing `services.<service>.container_name: <service>-<slot>`,
  pass via `docker compose -f docker-compose.yml -f docker-compose.bg-override.yml up -d`.
  Compose merges the override; container gets explicit name. Cleanup:
  delete override file after deploy completes (or per-slot if both alive).
- **R-004** Healthcheck signal: reuse feature 006's `wait-for-healthy`
  polling pattern. Container-name-aware: poll `docker inspect
  --format '{{.State.Health.Status}}' <service>-<slot>` until "healthy"
  or timeout per spec FR-012.
- **R-005** Drain timer durability: in-memory `Map<appId, NodeTimer>`
  per D2. Single-instance dashboard assumption (A-007 of feature 011)
  applies. Restart loses timers; surfaces via interrupted panel.
- **R-006** Restart recovery: boot-time scan in `interrupted-deploys-scanner.ts`
  runs ONCE at server start; queries `applications WHERE deploy_state IS NOT NULL`;
  for each, probes container state via `docker inspect` to enrich the
  panel. Periodic refresh NOT needed (panel is operator-driven; one
  scan per dashboard lifetime is enough).
- **R-007** Volume detection: parse compose YAML via existing
  `compose-parser.ts`, extract `services.<service>.volumes:` field.
  Volumes can be string-form (`"./data:/data"`) or object-form
  (`{ type: bind, source: ./data, target: /data }`); both must be
  detected for the PATCH-time ack check.
- **R-008** First-deploy slot migration: on first blue/green deploy when
  `active_color IS NULL`, run pre-flight `docker rename
  <existing-container-name> <service>-blue` (zero downtime per R-002),
  set `active_color = 'blue'` in same DB tx, then proceed with
  candidate-spawn in green slot.

## Phase 1: Design & Contracts

Outputs:

- [data-model.md](data-model.md) — schema additions, state-machine
  transition table, audit event catalogue, in-memory drain-timer shape.
- [contracts/api.md](contracts/api.md) — PATCH /apps/:id extension for
  blue-green fields, 6 manual-recovery RPCs, structured error responses.
- [contracts/state-machine.md](contracts/state-machine.md) — full
  phase-token state diagram, valid transitions, per-failure recovery
  paths, cross-feature audit / FailureCard / FAIL_PHASE coupling.
- [quickstart.md](quickstart.md) — operator walkthrough across 5 US
  with smoke-checks mapped to SC-001..SC-007.

### Agent context update

The repo has no `.specify/scripts/powershell/update-agent-context.ps1`.
Per user direction (carried over from features 010/011), CLAUDE.md is
**not** modified by this plan.

## Re-evaluate Constitution Check post-design

After draft of data-model.md + contracts/api.md + contracts/state-machine.md:

| Rule | Status |
|---|---|
| All Standing Orders + AGCG | ✓ (no design choice introduces a violation) |
| Migration is additive | ✓ (only ALTER ADD + CHECK) |
| State machine transitions all typed | ✓ (TypeScript discriminated union; compile fails on missing case) |
| Caddy switch atomicity respected | ✓ (single `POST /load` call; rollback path on FAILED_SWITCH) |
| Drain budget honoured | ✓ (force-kill at end of drain per spec FR-015 / Q clarification A-005) |

**Gate status: PASS post-design.** No re-design required.

## Cross-feature coordination

- **Migration sequence**: this plan reserves `0012_blue_green_deploy.sql`.
  Feature 010 reserves `0011_operational_maturity.sql`. Feature 011
  reserves `0010_zero_touch.sql`. Merge order: 0010 → 0011 → 0012.
- **`auditMiddleware` event-type catalogue**: feature 011 introduces 9
  new types, feature 010 adds 4 more, this feature adds 11. After
  all-three merge, catalogue carries 24 new events.
- **`FAILURE_STATE_DECLARATIONS` (feature 010 FailureCard registry)**:
  this feature adds 4 new states — `candidate_healthcheck_failed`,
  `aborted_during_drain`, `caddy_admin_failure_post_switch`,
  `deploy_interrupted_by_restart`. Each declaration entry includes
  `applicableContexts: ["deploy"]` and `defaultActionKinds`.
- **`FAIL_PHASE` enum (feature 010 hook env)**: this feature extends
  the enum with 6 new values — `candidate_starting`,
  `candidate_healthcheck`, `switching`, `outgoing_draining`,
  `outgoing_stopping`, `caddy_admin_post_switch`.
- **`EVENT_CATALOGUE` (feature 011 notification preferences)**: this
  feature adds 5 new event types per spec § Notification triggers.
- **Spec 005 disclaimer**: feature 005 explicitly declares "no
  blue-green / canary / staged-rollout". This feature lifts that.
  When this feature ships, feature 005's spec.md should be amended with
  a cross-reference to 012 in its "Out of Scope" section. Tracked as a
  small follow-up PR.

## Open dependencies

- **Feature 010 must ship before 012** (or in same merge group): 012
  references FailureCard contract + FAIL_PHASE enum + audit middleware
  extensions from 010. If 010 hasn't merged at 012's merge time, 012's
  FailureCard mounts will fail compile.
- **Feature 011 must ship before 012**: 012 declares 5 notification
  events; without 011's `notification_preferences` table + event
  catalogue, the notify path no-ops silently.
- **Feature 008 caddy-admin-client.ts** is foundation for 012's
  upstream switcher. Already shipped.

## Stop point

Plan ends at Phase 2. Implementation tasks (Phase 3) are produced by
`/speckit.tasks` from this plan + the spec.

## Generated artifacts

- [plan.md](plan.md) (this file)
- [research.md](research.md)
- [data-model.md](data-model.md)
- [contracts/api.md](contracts/api.md)
- [contracts/state-machine.md](contracts/state-machine.md)
- [quickstart.md](quickstart.md)

Suggested next: `/speckit.tasks`.
