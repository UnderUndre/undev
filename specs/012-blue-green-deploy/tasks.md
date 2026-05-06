# Tasks: Blue/Green Deploy with Connection Drain

**Feature**: 012-blue-green-deploy
**Inputs**: `spec.md`, `plan.md`, `research.md`, `data-model.md`, `contracts/api.md`, `contracts/state-machine.md`, `quickstart.md`
**Prerequisites**: features 004/005/006/008 merged. **Cross-feature dep order**: features 011 (0010) and 010 (0011) must merge BEFORE 012 (0012) — 012 references FailureCard contract + FAIL_PHASE enum from 010, notification catalogue from 011.
**Format reminder**: every task line is `- [ ] [TaskID] [AGENT] [Story?] Description with file path`. No `[P]` markers, no chained arrows. Story tag `[USx]` only inside Phase 3..7.

## Agent tags

| Tag | Domain |
|---|---|
| `[SETUP]` | Cross-cutting shared-file writes — single owner per file |
| `[DB]` | Migration `.sql`, `schema.ts`, parameterized Drizzle queries |
| `[BE]` | Server services / routes / lib |
| `[FE]` | React components / hooks / pages |
| `[OPS]` | Documentation, deployment configs (none in this feature) |
| `[E2E]` | Cross-domain integration tests |
| `[SEC]` | Security audit / vulnerability review |

## Status legend

`[ ]` not started · `[~]` in progress · `[x]` done · `[!]` blocked

## Path conventions

- Server: `devops-app/server/`
- Client: `devops-app/client/`
- Migration: `devops-app/server/db/migrations/0012_blue_green_deploy.sql`
- Tests: `devops-app/tests/{unit,integration}/`

---

## Phase 1: Setup

- [x] T001 [SETUP] [BE] Verify no new npm deps required for this feature in `devops-app/package.json` — Caddy admin via existing `caddy-admin-client.ts` (feature 008), compose parser via existing `compose-parser.ts` (feature 009), docker shell-outs via existing `executeWithStdin`. Per Standing Order #2, no `npm install` runs.
- [x] T002 [SETUP] [BE] AGCG compliance audit for the planned files: scan plan.md's Project Structure list — every new `.ts` MUST land typed (no `as any`), pino-only logging (no `console.log`), Zod on every route body, `AppError.*` factories on every throw. Document deviations as inline TODO comments only; no behaviour change.
- [x] T003 [SETUP] [DB] Extend `devops-app/server/db/schema.ts` with Drizzle definitions for **6 new `applications` columns** (`deployStrategy`, `drainSeconds`, `greenHealthcheckTimeoutSeconds`, `activeColor`, `deployState`, `deployStateStartedAt`). Drizzle typed columns only, no raw SQL strings, single atomic edit. Match data-model.md exactly.
- [x] T004 [SETUP] [BE] Verify cross-feature audit catalogue extension compatibility — read `devops-app/server/lib/audit-middleware.ts` (extended by feature 010's T012 / feature 011's T012), confirm catalogue has push/extend pattern that allows this feature's 11 new event types (per data-model.md). Document the integration approach in a 5-line comment for T016.
- [x] T005 [SETUP] [BE] Verify cross-feature dependency order — confirm features 010 + 011 are merged BEFORE this feature ships (012 references `FAILURE_STATE_DECLARATIONS` from 010, `FAIL_PHASE` enum from 010 hooks, `EVENT_CATALOGUE` from 011 notifications). If not yet merged at merge-time, document blocking dep in PR description. No code change.

**Sync barrier — Phase 1 complete before Phase 2 starts.**

---

## Phase 2: Foundational

- [x] T006 [DB] Create `devops-app/server/db/migrations/0012_blue_green_deploy.sql` per data-model.md: ALTER `applications` add 6 cols (`deploy_strategy TEXT NOT NULL DEFAULT 'recreate'`, `drain_seconds INTEGER NOT NULL DEFAULT 30`, `green_healthcheck_timeout_seconds INTEGER NOT NULL DEFAULT 60`, `active_color TEXT NULL`, `deploy_state TEXT NULL`, `deploy_state_started_at TEXT NULL`), 2 CHECK constraints (deploy_strategy enum, active_color enum-or-null), 1 partial index (`idx_applications_deploy_state_active WHERE deploy_state IS NOT NULL`), DOWN migration in commented block warning operators about `deploy_state IS NOT NULL` rows blocking column drop. Reviewable static SQL, no string interpolation. Per Standing Order #1, do NOT execute — file only.
- [x] T007 [BE] Implement `devops-app/server/lib/blue-green-state-machine.ts` per `contracts/state-machine.md` — pure-data exports `Phase` enum, `Transition` interface, `TRANSITIONS: ReadonlyArray<Transition>` (15 documented transitions per state-machine.md table), helpers `canTransition(from, to)` and `findTransition(from, to)`. No DB access, no side effects, no React. Typed inputs/outputs, no `as any`.
- [x] T008 [BE] Add unit tests `devops-app/tests/unit/blue-green-state-machine.test.ts` — assert every transition in `TRANSITIONS` has all required fields populated; `canTransition()` returns true for documented transitions, false for non-documented (sample 5 random invalid pairs); no transition has both `pausesDrainTimer:true` AND `resumesDrainTimer:true`; every Phase value appears as both `from` and `to` somewhere; every FAILED_* state has at least one outgoing transition.
- [x] T009 [BE] Implement `devops-app/server/lib/compose-override-generator.ts` per research.md R-003 — typed `generateOverride(serviceName: string, slotColor: 'blue' | 'green'): string` returns YAML string with `services.<serviceName>.container_name: <serviceName>-<slotColor>`. Pure function. Plus `writeOverride(serverId, appDir, content): Promise<void>` and `deleteOverride(serverId, appDir): Promise<void>` for filesystem operations via SSH. No `as any`, structured error handling.
- [x] T010 [BE] Add unit tests `devops-app/tests/unit/compose-override-generator.test.ts` — fixture compose YAML → expected override content with `container_name: <service>-<slot>`; both 'blue' and 'green' slots produce expected strings; idempotent on re-write (overwrites existing file).
- [x] T011 [BE] Implement `devops-app/server/lib/blue-green-validator.ts` per data-model.md FR-006/007/008/008a — typed `validateBlueGreenConfig(input): { ok: true } | { ok: false; error: ValidationError }` performing 6 cross-field checks: (1) proxy_type='caddy' (FR-006), (2) replicas=1 (FR-007), (3) no network_mode:host (FR-008), (4) no host port pins (FR-008), (5) compose has healthcheck (A-003), (6) `acknowledgeVolumeSharing=true` if compose declares volumes (FR-008a). Reuses feature 009's `compose-parser.ts` for compose introspection. Returns discriminated union with detailed error payloads matching `contracts/api.md` § Response 400 shapes. No `as any`.
- [x] T012 [BE] Add unit tests `devops-app/tests/unit/blue-green-validator.test.ts` — full validation matrix: each FR violation triggers correct error code; happy path (caddy + replicas=1 + no host networks + healthcheck + ack=true with volumes) returns ok:true; volume-less app with ack=false returns ok:true (ack only required when volumes present); fixture YAML covering string-form `"./data:/data"` AND object-form `{ type: bind, source, target }` volumes per R-007.
- [x] T013 [BE] Extend feature 010's `devops-app/server/lib/failure-state-declarations.ts` with **4 new state entries** per `contracts/state-machine.md` § FailureCard mount mapping: `candidate_healthcheck_failed`, `aborted_during_drain`, `caddy_admin_failure_post_switch`, `deploy_interrupted_by_restart`. Each entry has `applicableContexts: ['deploy']`, `defaultActionKinds`, `customLabel?`. Cross-feature touch — coordinate with feature 010 PR if 010 hasn't merged.
- [x] T014 [BE] Extend feature 010's `FAIL_PHASE` enum (consumed by `on_fail` hook env builder in `devops-app/server/services/scripts-runner.ts`) with **6 new values** per `contracts/state-machine.md` § FAIL_PHASE env enum extension: `candidate_starting`, `candidate_healthcheck`, `switching`, `outgoing_draining`, `outgoing_stopping`, `caddy_admin_post_switch`. Cross-feature touch.
- [x] T015 [BE] Extend feature 011's `devops-app/server/lib/event-catalogue.ts` with **5 new event entries** per `contracts/state-machine.md` § Notification gate integration: `deploy.candidate_failed_rollback` (failure, default ON), `deploy.aborted` (security, default ON), `deploy.caddy_admin_failure_pre_switch` (failure, default ON), `deploy.caddy_admin_failure_post_switch` (failure, default ON), `deploy.blue_green_succeeded` (success, default OFF). Cross-feature touch.
- [x] T016 [BE] Extend `devops-app/server/lib/audit-middleware.ts` allowed-actions catalogue (path verified by T004) with **11 new event types** per data-model.md § audit_entries: `app.deploy_strategy_changed`, `deploy.blue_green_started`, `deploy.candidate_healthy`, `deploy.traffic_switched`, `deploy.drained`, `deploy.outgoing_stopped`, `deploy.candidate_failed_rollback`, `deploy.aborted`, `deploy.too_late_to_abort`, `deploy.caddy_admin_failure_pre_switch`, `deploy.caddy_admin_failure_post_switch`. Each gets a typed payload Zod schema matching data-model.md table.

**Sync barrier — Phase 2 complete before any user-story phase starts.**

---

## Phase 3: User Story 1 — Configure deploy strategy and drain settings (P1)

**Goal**: PATCH /api/applications/:id accepts `deployStrategy`, `drainSeconds`, `greenHealthcheckTimeoutSeconds`, `acknowledgeVolumeSharing`. UI surfaces "Deploy Strategy" section with strategy dropdown + drain inputs + volume-ack panel.

**Independent test criteria**: PATCH with valid blue_green config + ack=true succeeds; PATCH violating any of the 6 validator rules returns proper 400 with correct error code; UI disables `blue_green` dropdown option when proxy_type != 'caddy'; UI surfaces volume ack panel when compose declares volumes.

- [~] T017 [BE] [US1] Modify `devops-app/server/routes/apps.ts` PATCH handler — extend Zod body schema with `deployStrategy`, `drainSeconds`, `greenHealthcheckTimeoutSeconds`, `acknowledgeVolumeSharing` fields per `contracts/api.md` § BlueGreenFields. Apply `validateBlueGreenConfig` from T011 as `superRefine`. Return 400 with discriminated-union error response per contract on each validator failure (5 distinct error codes). On success, audit `app.deploy_strategy_changed` with full diff payload (including list of acknowledged volumes if applicable). Parameterized Drizzle, no `as any`.
- [ ] T018 [BE] [US1] Add unit tests `devops-app/tests/unit/blue-green-patch-validation.test.ts` — full PATCH request matrix: valid blue_green config → 200; each violation type → correct 400 error code; recreate strategy bypass (no validation triggered when staying on recreate); idempotent re-PATCH with same fields → 200 with audit emit.
- [ ] T019 [FE] [US1] Implement `devops-app/client/components/apps/DeployStrategySection.tsx` — typed component with strategy dropdown (recreate/blue_green; latter DISABLED with tooltip when `proxy_type != 'caddy'`), drain seconds input (range 0..600, default 30), green healthcheck timeout input (range 10..1800, default 60), inline volume ack panel (renders `<VolumeAckPanel>` from T020 when compose declares volumes). Client-side validation mirrors server (`validateBlueGreenConfig` types via shared module). Controlled inputs only, no `dangerouslySetInnerHTML`.
- [ ] T020 [FE] [US1] Implement `devops-app/client/components/apps/VolumeAckPanel.tsx` — typed props `{ detectedVolumes: DetectedVolume[]; acknowledged: boolean; onAcknowledgeChange: (b: boolean) => void }`. Renders list of detected volumes (source/target/mode), safety-categories hint text per spec Q2 clarification (logs OK / uploads OK / DB files NOT OK), single checkbox "I understand both containers share these volumes during drain". Save button gating handled in parent (DeployStrategySection). Controlled inputs.
- [ ] T021 [FE] [US1] Modify `devops-app/client/components/apps/EditAppForm.tsx` — embed `<DeployStrategySection>` as a new collapsible section (collapsed by default). Wire form state through existing form-state pattern (verify exact symbol — likely `useEditAppForm` hook). No `as any`.
- [ ] T022 [FE] [US1] Implement `devops-app/client/hooks/useDeployStrategy.ts` — typed hook returning `{ strategy, drainSeconds, greenHealthcheckTimeoutSeconds, activeColor, isLoading, error }` plus mutation helpers. Uses shared fetch wrapper. Maps server validation errors to typed result variants for UI rendering.
- [ ] T023 [E2E] [US1] Add `devops-app/tests/integration/blue-green-volume-ack.test.ts` — fixture app with compose containing volumes; PATCH with `acknowledgeVolumeSharing: false` → 400 `volume_sharing_unacknowledged` with detected volumes in payload; PATCH with `true` → 200; volume-less app with ack omitted → 200 (ack not required). Cross-validates Zod + validator + route layers.

---

## Phase 4: User Story 2 — Deploy executes blue/green flow (P1)

**Goal**: deploy entry point bifurcates on strategy. blue_green path drives state machine via orchestrator: spawn candidate → wait healthy → atomic Caddy switch → drain → stop outgoing → flip active_color. Live progress via WS.

**Independent test criteria**: deploy on blue_green app drives state machine through happy path within `green_healthcheck_timeout + drain_seconds + 30s`; external probe during deploy window observes 100% request completion (SC-001); compose override file generated + cleaned up; first blue/green deploy renames existing container to `<service>-blue` via `docker rename` (zero downtime).

- [x] T024 [BE] [US2] Implement `devops-app/server/services/caddy-upstream-switcher.ts` per research.md R-001 — typed `switchUpstream(appId, newColor): Promise<SwitchResult>`. Wraps existing feature 008 `caddy-admin-client.ts` + reuses `caddy-config-builder.ts` to render full config with target app's upstream pointed at `<service>-<newColor>`. Calls `caddy.postLoad(newConfig)` for atomic switch. Returns discriminated union (`{ ok: true, switchedAt }` or `{ ok: false, reason }`). Typed inputs/outputs, no `as any`.
- [x] T025 [BE] [US2] Implement `devops-app/server/services/drain-timer.ts` per research.md R-005 + plan D2 — class `DrainTimerService` with in-memory `Map<appId, TimerEntry>`. Methods: `start(appId, drainSeconds, onComplete)`, `pause(appId): { remainingMs } | null`, `resume(appId, remainingMs, onComplete)`, `cancel(appId)`, `getRemainingMs(appId)`. Uses `setTimeout().unref()` so process can exit cleanly. Typed inputs/outputs, no `as any`.
- [x] T026 [BE] [US2] Implement `devops-app/server/services/slot-namer.ts` per research.md R-008 — typed `migrateExistingToBlueSlot(serverId, appId): Promise<void>` runs `docker rename <existing-name> <service>-blue` over SSH (metadata-only per R-002, zero downtime). Idempotent — no-op if already named correctly. Plus helper `resolveContainerName(appId, color: 'blue' | 'green'): string` for sticky slot resolution. Parameterized via `shQuote`.
- [x] T027 [BE] [US2] Implement `devops-app/server/services/interrupted-deploys-scanner.ts` per research.md R-006 — typed `scanAtBoot(): Promise<InterruptedDeployRow[]>` queries `applications WHERE deploy_state IS NOT NULL`; for each row, probes container state via `docker inspect --format` over SSH (in parallel with `Promise.all`). Returns enriched panel data per `contracts/api.md` § GET /interrupted-deploys. Plus in-memory cache `interruptedDeploysCache.set(rows)` populated at boot, cleared per row when operator action completes.
- [x] T028 [BE] [US2] Implement `devops-app/server/services/blue-green-orchestrator.ts` — drives the state machine end-to-end. Public methods: `startDeploy(appId, userId)`, `onCandidateHealthy(appId)`, `onSwitchCommitted(appId)`, `onDrainElapsed(appId)`, `onOutgoingStopped(appId)`. Per-phase actions: CANDIDATE_STARTING (write override file via T009, dispatch `docker compose -f ... -f override.yml up -d --no-deps`), CANDIDATE_HEALTHY (poll healthcheck per R-004), SWITCHING (call T024 caddy-upstream-switcher), OUTGOING_DRAINING (start T025 drain timer), OUTGOING_STOPPED (`docker compose stop --timeout=<stop_grace_period>` outgoing, cleanup override file, flip `active_color`), ACTIVE → cleared to NULL. State transitions wrapped in DB tx (UPDATE deploy_state + INSERT audit_entries) BEFORE WS broadcast. Uses `canTransition()` from T007 to validate every transition. Typed errors, no `as any`. **Before CANDIDATE_STARTING: if `active_color IS NULL`, call `slotNamer.migrateExistingToBlueSlot()` per R-008.**

  **Synthetic audit events** (per /speckit.analyze M3 — emitted as side-effect of cleared/recovered transitions, not stored as phase tokens): `deploy.failure_cleared` on any FAILED_* → NULL transition (when operator clears via Retry/Cleanup); `deploy.caddy_admin_recovered` on FAILED_CADDY_ADMIN_POST_SWITCH → OUTGOING_DRAINING; `deploy.blue_green_succeeded` on ACTIVE → NULL (final-success notification trigger).

  **WS broadcast** (per /speckit.analyze M4): emit `blue_green.state-changed` event topic AFTER DB tx commit using existing WS broadcaster infra (`server/ws/broadcaster.ts` or equivalent — verify exact symbol during implementation). Event payload per `contracts/api.md` § Live progress events. No new event-type registration needed — existing broadcaster supports arbitrary topic strings.
- [x] T029 [BE] [US2] Modify `devops-app/server/services/scripts-runner.ts` deploy entry point to bifurcate on `applications.deploy_strategy`: `'recreate'` → existing flow unchanged (FR-027 bit-identical guarantee), `'blue_green'` → delegates to `blueGreenOrchestrator.startDeploy(appId, userId)`. Typed bifurcation, no `as any`. Recreate path MUST remain bit-identical — verify via T055.
- [x] T030 [BE] [US2] Add unit tests `devops-app/tests/unit/caddy-upstream-switcher.test.ts` — mock caddy-admin-client; assert `switchUpstream('appXyz', 'green')` constructs upstream with `<service>-green`; admin returns 200 → success result; admin returns 4xx → permanent rejection; admin network error → transient `caddy_admin_unreachable`.
- [x] T031 [BE] [US2] Add unit tests `devops-app/tests/unit/drain-timer.test.ts` — start/pause/resume/cancel lifecycle; `pause` returns correct `remainingMs`; `resume(appId, remainingMs, onComplete)` fires `onComplete` after `remainingMs` elapses (use Vitest fake timers); `cancel` prevents `onComplete` firing; `unref()` ensures timer doesn't keep process alive.
- [x] T032 [BE] [US2] Add unit tests `devops-app/tests/unit/slot-namer.test.ts` — first-deploy rename: existing container `app_service_1` → `service-blue`, idempotent on re-run (already-named no-op); `resolveContainerName('appXyz', 'blue')` returns `<service>-blue`; SSH error during rename surfaces as `slot_migration_failed`.
- [x] T033 [BE] [US2] Add unit tests `devops-app/tests/unit/interrupted-deploys-scanner.test.ts` — fixture DB rows with non-NULL deploy_state; mock SSH probing; assert returned panel data includes per-row last phase, candidate state, outgoing state. Empty result when no rows have deploy_state set.
- [ ] T034 [BE] [US2] Add unit tests `devops-app/tests/unit/blue-green-orchestrator.test.ts` — happy path through all phase transitions (mock SSH executor + caddy-admin-client + drain-timer); state transitions wrap correctly in DB tx; audit row inserted before WS broadcast (assert ordering); `canTransition()` rejects invalid transitions (e.g. SWITCHING → OUTGOING_STOPPED without going through OUTGOING_DRAINING); first-deploy slot migration triggers when `active_color IS NULL`.
- [ ] T035 [FE] [US2] Implement `devops-app/client/components/deploy/BlueGreenDeployLog.tsx` — replaces standard DeployLog when `app.deploy_strategy === 'blue_green'`. Renders `<BlueGreenPhaseIndicator>` (T036) for visual state machine progress, `<DrainCountdown>` (T037) during OUTGOING_DRAINING phase, log tail per phase (reuses existing file-tail modal infra). Uses `useBlueGreenDeployState` (T038) for WS subscription. Controlled inputs.
- [ ] T036 [FE] [US2] Implement `devops-app/client/components/deploy/BlueGreenPhaseIndicator.tsx` — typed visual indicator showing current phase + completed phases. Maps phase tokens from `blue-green-state-machine.ts` (T007) to display labels (e.g. CANDIDATE_STARTING → "Starting candidate container"). Renders FailureCard inline when phase is FAILED_*.
- [ ] T037 [FE] [US2] Implement `devops-app/client/components/deploy/DrainCountdown.tsx` — typed real-time countdown component. Subscribes to `useBlueGreenDeployState` for `drainRemainingMs` from WS events; renders countdown timer (1s tick resolution per OQ-001 design call — defer if needed). Pauses + shows "PAUSED — Caddy admin recovery in progress" when phase transitions to FAILED_CADDY_ADMIN_POST_SWITCH.
- [ ] T038 [FE] [US2] Implement `devops-app/client/hooks/useBlueGreenDeployState.ts` — typed hook subscribing to `blue_green.state-changed` WS topic for the given appId; returns `{ phase, drainRemainingMs, candidateColor, error }`. Falls back to 2s REST poll on WS disconnect. Uses shared fetch wrapper.
- [ ] T039 [E2E] [US2] Add `devops-app/tests/integration/blue-green-happy-path.test.ts` — fixture app with `deploy_strategy='blue_green'`, mock SSH + Caddy admin + compose healthcheck (returns healthy after 5s). Trigger deploy → assert state machine progresses CANDIDATE_STARTING → CANDIDATE_HEALTHY → SWITCHING → OUTGOING_DRAINING → OUTGOING_STOPPED → ACTIVE → cleared to NULL. Assert `active_color` flipped, override file deleted, all 6 audit events emitted in order, `deploy.blue_green_succeeded` notification dispatched (mocked gate spy).
- [ ] T040 [E2E] [US2] Add `devops-app/tests/integration/blue-green-sc-001-request-flood.test.ts` — happy-path deploy with concurrent HTTP probe firing 100 req/sec for full deploy duration. Assert 100% completion (zero >100ms drops). Catastrophic-failure variant (mock Caddy admin to drop AFTER switch) allowed to fail SC-001 but MUST go through `caddy_admin_failure_post_switch` recovery flow per spec Q5.

---

## Phase 5: User Story 3 — Candidate healthcheck failure rollback (P2)

**Goal**: candidate fails healthcheck → orchestrator transitions to FAILED_CANDIDATE_HEALTHCHECK → Caddy NEVER touched → traffic stays on outgoing → candidate stopped + removed → FailureCard renders for operator recovery.

**Independent test criteria**: bad-image candidate scenario; assert traffic served by outgoing throughout the deploy attempt; assert candidate cleaned up (no orphan); assert FailureCard mounted with state `candidate_healthcheck_failed`.

- [ ] T041 [BE] [US3] Verify orchestrator (T028) FAILED_CANDIDATE_HEALTHCHECK transition path — explicit unit-test addition to `devops-app/tests/unit/blue-green-orchestrator.test.ts`: candidate healthcheck times out → state transitions to FAILED_CANDIDATE_HEALTHCHECK; Caddy admin client NEVER called; candidate container `docker rm -f` issued; `active_color` UNCHANGED; audit `deploy.candidate_failed_rollback` emitted with `failureReason`, `candidateColor`, `lastLogLines`.
- [ ] T042 [FE] [US3] Verify FailureCard rendering for `candidate_healthcheck_failed` state — relies on T013 declaration entry. No new component needed; `<BlueGreenPhaseIndicator>` (T036) consumes feature 010's FailureCard mount when phase is FAILED_*. Add component test asserting the right `defaultActionKinds` (Retry, EditConfig, ViewLog) render.
- [ ] T043 [E2E] [US3] Add `devops-app/tests/integration/blue-green-candidate-fail.test.ts` — fixture app with `deploy_strategy='blue_green'`, mock SSH + compose healthcheck (returns unhealthy / never healthy). Trigger deploy → assert FAILED_CANDIDATE_HEALTHCHECK reached within `green_healthcheck_timeout`; assert Caddy admin NEVER called (no upstream switch); assert candidate container removed; assert `active_color` UNCHANGED in DB; assert audit `deploy.candidate_failed_rollback` row written; assert FailureCard renders in DeployLog with action set [Retry, EditConfig, ViewLog].
- [ ] T044 [E2E] [US3] Add `devops-app/tests/integration/blue-green-caddy-failure-pre-switch.test.ts` — fixture app where compose healthcheck passes but Caddy admin returns 500 on `POST /load`. Trigger deploy → assert state reaches CANDIDATE_HEALTHY → SWITCHING → FAILED_SWITCH; assert traffic stays on outgoing throughout; assert candidate cleaned up; assert audit `deploy.caddy_admin_failure_pre_switch` emitted.

---

## Phase 6: User Story 4 — Mid-deploy abort + recovery RPCs (P2)

**Goal**: 6 manual-recovery RPCs in `routes/blue-green.ts` covering abort during drain, Caddy admin recovery (Retry/Mark recovered), and restart-recovery panel actions (Resume/Abort/Mark complete). Frontend dialogs for each typed-confirm flow.

**Independent test criteria**: abort during drain switches Caddy back, stops candidate, marks deploy failed; Mark recovered after Caddy admin failure resumes drain from paused position; restart-recovery panel surfaces interrupted deploys with per-row action buttons working end-to-end.

- [ ] T045 [BE] [US4] Implement `devops-app/server/routes/blue-green.ts` per `contracts/api.md` § US3/US4 — **6 POST RPCs**: `POST /api/applications/:id/blue-green/abort` (typed-confirm; switches Caddy back; stops candidate; deploy_state → FAILED_DRAIN_ABORT), `POST /api/applications/:id/blue-green/recover-caddy/retry-healthcheck` (re-pings Caddy admin; on success resumes drain), `POST /api/applications/:id/blue-green/recover-caddy/mark-recovered` (typed-confirm; resumes drain from paused position), `POST /api/applications/:id/blue-green/interrupted/resume` (sanity probe + resume from chosen phase), `POST /api/applications/:id/blue-green/interrupted/abort-cleanup` (typed-confirm; force-stops candidate; outgoing preserved), `POST /api/applications/:id/blue-green/interrupted/mark-complete` (typed-confirm; operator-supplied finalActiveColor; clears deploy_state). Each RPC: Zod body validation, structured 4xx errors per contract, parameterized Drizzle, audit emit. No `as any`. **NOTE**: GET endpoint for interrupted-deploys panel data lives in T045a (separate task per /speckit.analyze H1).
- [ ] T045a [BE] [US4] Implement `GET /api/applications/interrupted-deploys` in `devops-app/server/routes/blue-green.ts` per `contracts/api.md` § Restart-recovery panel data — typed handler returning `{ rows: InterruptedDeployRow[] }` from `interruptedDeploysCache` populated by `interrupted-deploys-scanner.ts` (T027). Empty cache → empty array. Read-only, no audit emit. No body validation (empty query). Standards: typed inputs/outputs, no `as any`.
- [ ] T046 [BE] [US4] Add unit tests `devops-app/tests/unit/routes-blue-green.test.ts` — per RPC: happy path response shape; typed-confirm mismatch → 400 `typed_confirmation_mismatch`; abort outside DRAINING window → 409 `too_late_to_abort`; resume sanity probe inconsistency → 422 `inconsistent_state_for_resume`; **GET /interrupted-deploys returns cache contents** (per T045a); mock orchestrator + drain-timer dependencies.
- [ ] T047 [FE] [US4] Implement `devops-app/client/components/deploy/AbortDuringDrainDialog.tsx` — typed-confirm dialog. Operator types app's name to enable Abort button. Calls `POST /api/applications/:id/blue-green/abort`. Maps server error codes to inline UI hints. Controlled inputs.
- [ ] T048 [FE] [US4] Implement `devops-app/client/components/deploy/CaddyAdminFailureRecoveryDialog.tsx` — renders for state `caddy_admin_failure_post_switch`. Three actions: "Retry healthcheck" (calls `/recover-caddy/retry-healthcheck`), "View last-known config" (modal showing config from response), "Mark recovered" (typed-confirm dialog, calls `/recover-caddy/mark-recovered`). Surfaces critical alert info. Controlled inputs.
- [ ] T049 [FE] [US4] Implement `devops-app/client/components/apps/InterruptedDeploysPanel.tsx` — typed component fetching from `GET /api/applications/interrupted-deploys`. Renders one card per interrupted deploy showing: app name, server, last phase, candidate state, outgoing state. Three buttons per card: "Resume from <phase>" (opens phase selector), "Abort and clean up" (typed-confirm), "Mark complete" (typed-confirm + finalActiveColor selector). Hidden when fetched data is empty array.
- [ ] T050 [FE] [US4] Implement `devops-app/client/hooks/useInterruptedDeploys.ts` — typed hook fetching `GET /api/applications/interrupted-deploys` on mount + refetch on operator action. Returns `{ rows, isLoading, error, refetch }`. Uses shared fetch wrapper.
- [ ] T051 [FE] [US4] Modify `devops-app/client/pages/AppsList.tsx` — render `<InterruptedDeploysPanel>` at the top of the page (above the apps grid) when its returned data is non-empty. Verify exact path during implementation (likely `client/pages/AppsList.tsx` or `client/pages/Apps.tsx`).
- [ ] T052 [E2E] [US4] Add `devops-app/tests/integration/blue-green-abort-during-drain.test.ts` — drive deploy to OUTGOING_DRAINING phase; POST `/abort` with mismatched typed-confirm → 400; POST with correct app name → 200; assert Caddy admin called with revert config; assert candidate stopped + removed; assert deploy_state → FAILED_DRAIN_ABORT → cleared to NULL; assert `active_color` reverted to pre-deploy value; audit `deploy.aborted` emitted.
- [ ] T053 [E2E] [US4] Add `devops-app/tests/integration/blue-green-caddy-failure-post-switch.test.ts` — drive deploy past SWITCHING; mock Caddy admin to drop mid-drain; assert state transitions to FAILED_CADDY_ADMIN_POST_SWITCH; assert drain timer paused (verify via `drain-timer.getRemainingMs(appId)` non-null); critical TG alert dispatched. Operator action: POST `/recover-caddy/mark-recovered` → assert drain resumes from paused remainingMs; deploy completes normally to ACTIVE; audit `deploy.caddy_admin_marked_recovered_by_operator` emitted.
- [ ] T054 [E2E] [US4] Add `devops-app/tests/integration/blue-green-restart-recovery.test.ts` — fixture: row with `deploy_state='OUTGOING_DRAINING'` and `deploy_state_started_at` set. Mock containers (candidate running, outgoing running) + Caddy reachable. Boot dashboard → `interrupted-deploys-scanner.scanAtBoot()` populates cache; GET `/interrupted-deploys` returns the row. Test all 3 operator paths: (a) POST `/interrupted/resume` with phase=OUTGOING_DRAINING → drain timer restarts with full `drain_seconds`, (b) POST `/interrupted/abort-cleanup` → candidate removed, deploy_state cleared, active_color unchanged, (c) POST `/interrupted/mark-complete` with finalActiveColor → active_color set to operator value, deploy_state cleared.

---

## Phase 7: User Story 5 — Stateful service opt-out (P3)

**Goal**: existing `recreate` strategy apps continue working with zero behavior change. Verify via no-regression tests + bifurcation invariant.

**Independent test criteria**: existing recreate-strategy integration tests pass without modification; deploy on recreate app produces bit-identical script_runs entries to pre-feature-012 baseline.

- [ ] T055 [BE] [US5] Verify `scripts-runner.ts` bifurcation (T029) preserves recreate path bit-identical — explicit unit-test addition to `devops-app/tests/unit/scripts-runner.test.ts`: deploy on `recreate` app produces same script_runs row shape as pre-T029 baseline; no orchestrator code path executed; no override file generated; no slot rename. Regression guard for FR-027.
- [ ] T056 [E2E] [US5] Add `devops-app/tests/integration/blue-green-recreate-no-regression.test.ts` — fixture app with `deploy_strategy='recreate'` (default). Trigger deploy → assert existing single-phase recreate flow runs unchanged (single `docker compose up -d`, no candidate spawn, no Caddy switch, no drain timer). Compare result row vs golden snapshot from pre-feature-012 fixture.
- [ ] T057 [E2E] [US5] Add `devops-app/tests/integration/blue-green-strategy-switch.test.ts` — start with recreate, PATCH to blue_green (no deploy yet), assert active_color stays NULL, deploy_state stays NULL; deploy → first-deploy rename ritual fires, active_color → 'blue' → flips after deploy; PATCH back to recreate → active_color cleared to NULL on save.

---

## Phase 8: Polish & Cross-Cutting Concerns

- [ ] T058 [BE] Wire `interrupted-deploys-scanner.ts` (T027) into `devops-app/server/index.ts` — call `scanAtBoot()` once during initialization, after migrations apply but before route registration. Persist result to in-memory cache. Failure to scan logs at warn but does NOT block boot (operator can still reach apps; panel just empty).
- [ ] T059 [SEC] Security audit on Caddy admin call paths + override file lifecycle: confirm `caddy-upstream-switcher.ts` (T024) never logs admin token in cleartext; confirm override compose file is written under `<appDir>/.dashboard/` namespace (gitignored convention) and ALWAYS deleted after deploy completes (success OR failure path); confirm `docker rename` (T026) only operates on container names matching app's expected naming pattern (no arbitrary rename injection). Document findings inline (`docs/SECURITY_CHECKLIST.md` if existing pattern).
- [ ] T060 [SEC] Audit drain timer state for memory leaks across many sequential deploys: confirm `drain-timer.cancel(appId)` in finally blocks of failure paths (no orphan timers in Map); confirm `unref()` on every `setTimeout` (process can exit cleanly); add memory-leak test in `devops-app/tests/unit/drain-timer.test.ts` simulating 1000 sequential start+complete cycles, assert Map size === 0 at end.
- [ ] T061 [BE] Quickstart smoke check `devops-app/tests/integration/quickstart-012.test.ts` — drives the operator-facing flow from quickstart.md Steps 1..7 against mocked SSH + mocked Caddy admin + mocked compose: configure blue_green via PATCH → deploy (happy path) → induce candidate fail → induce abort during drain → induce caddy_admin_failure_post_switch → induce restart recovery → revert to recreate (no regression). Asserts each step's audit row appears in expected order.
- [ ] T062 [BE] Final lint+typecheck+test pass per `npm run validate` per CLAUDE.md — every new file passes Biome/ESLint with no warnings, every Zod schema typecheck-clean, full test suite green. Failure here blocks merge.

---

## Dependency Graph

Following STRICT syntax (one rule per line, `→` single-unlock, `,` fan-out, `+` fan-in):

```
# Phase 1 → Phase 2 (sync barrier — fan-in uses `+` per syntax rules)
T001 + T002 + T003 + T004 + T005 → T006
T001 + T002 + T003 + T004 + T005 → T007
T001 + T002 + T003 + T004 + T005 → T009
T001 + T002 + T003 + T004 + T005 → T011
T001 + T002 + T003 + T004 + T005 → T013
T001 + T002 + T003 + T004 + T005 → T014
T001 + T002 + T003 + T004 + T005 → T015
T001 + T002 + T003 + T004 + T005 → T016

# Phase 2 internal
T007 → T008
T009 → T010
T011 → T012

# Cross-Phase shared file: T014 + T029 both edit scripts-runner.ts
# (FAIL_PHASE enum extension consumed by on_fail hook env builder which lives
# in same file as deploy entry point bifurcation). Explicit edge ensures T014
# lands first per /speckit.analyze G1 fix.
T014 → T029

# Phase 2 → Phase 3 (US1)
T011 + T012 + T016 → T017
T017 → T018
T011 → T019
T011 → T020
T019 + T020 → T021
T011 → T022
T017 + T021 → T023

# Phase 2 → Phase 4 (US2)
T006 + T007 + T009 + T016 → T024
T006 + T007 → T025
T006 + T007 → T026
T006 + T007 → T027
T006 + T007 + T009 + T024 + T025 + T026 → T028
T028 → T029
T024 → T030
T025 → T031
T026 → T032
T027 → T033
T028 → T034
T028 → T035
T028 → T036
T025 → T037
T028 → T038
T029 + T035 + T036 + T037 + T038 → T039
T029 → T040

# Phase 4 → Phase 5 (US3)
T028 → T041
T013 + T036 → T042
T028 + T013 → T043
T024 + T028 → T044

# Phase 4 → Phase 6 (US4)
T028 + T024 + T025 → T045
T027 + T045 → T045a
T045 + T045a → T046
T045 → T047
T045 → T048
T027 + T045a → T049
T045a → T050
T049 → T051
T045 + T047 → T052
T045 + T048 → T053
T045a + T049 + T051 → T054

# Phase 4 → Phase 7 (US5)
T029 → T055
T029 → T056
T017 + T029 → T057

# Phase 8 (Polish) — sync barrier on all US phases
T027 → T058
T024 + T028 + T029 → T059
T025 → T060
T039 + T040 + T043 + T044 + T052 + T053 + T054 + T056 + T057 + T058 → T061
T039 + T040 + T043 + T044 + T052 + T053 + T054 + T056 + T057 + T058 + T059 + T060 + T061 → T062
```

### Self-validation

- [x] Every task ID in Dependencies exists in T001..T062 list **plus T045a** (re-verified after /speckit.analyze G1 + H1 fixes — 63 tasks total, no orphan IDs).
- [x] No circular dependencies (DAG topology: Phase N → Phase N+ only; lateral within phase via fan-in).
- [x] Fan-in uses `+` only, fan-out uses `,` only — Phase 1→2 transitions explicitly use `+`.
- [x] No chained arrows on a single line.
- [x] Phase boundaries enforced as multi-source fan-ins.
- [x] **Frontend** shared file ownership: `EditAppForm.tsx` (T021), `AppsList.tsx` (T051) — each single-owner, no race risk.
- [x] **Backend** shared file ownership: `scripts-runner.ts` shared between T014 (FAIL_PHASE enum) and T029 (deploy bifurcation) — explicit `T014 → T029` edge added per G1 fix to enforce sequencing.
- [x] All other backend services / libs are single-owner per file.

---

## Parallel Lanes

After Phase 2 sync barrier (T016 done), 5 user-story lanes fork. Note: US3/US4 dependent on US2's orchestrator (T028) before they can start their main work; US5 dependent on T029 (bifurcation).

| Lane | Agent flow | Tasks | Start condition |
|---|---|---|---|
| **Lane A — US1 Configure** | BE→FE→E2E | T017..T023 | Phase 2 complete |
| **Lane B — US2 Deploy execution** | BE→FE→E2E | T024..T040 | Phase 2 complete |
| **Lane C — US3 Rollback** | BE→FE→E2E | T041..T044 | Lane B's T028 done |
| **Lane D — US4 Abort + recovery RPCs** | BE→FE→E2E | T045..T054 | Lane B's T028+T024+T025+T027 done |
| **Lane E — US5 Opt-out verification** | BE→E2E | T055..T057 | Lane B's T029 done |

Polish phase (T058..T062) runs after every US lane closes — pure sync barrier.

### Agent Summary

Some Phase-1 tasks carry two tags (e.g. `[SETUP] [BE]` for shared-file
writes that need backend judgement) — this is why tag occurrences exceed
unique task count.

| Agent | Tag occurrences | Notable phases |
|---|---|---|
| `[SETUP]` | 5 | All in Phase 1 (T001..T005), each cross-tagged with implementing agent |
| `[DB]` | 2 | T003 (schema), T006 (migration) |
| `[BE]` | 35 | Bulk of work — Phase 2..7 services + routes + unit tests + cross-feature catalogue extensions (+T045a per /speckit.analyze H1 fix) |
| `[FE]` | 14 | UI components + hooks in US1, US2, US4 |
| `[OPS]` | 0 | No new scripts or CI changes |
| `[E2E]` | 9 | Integration tests across US1..US5 + quickstart + restart-recovery |
| `[SEC]` | 2 | T059 (Caddy/override file audit), T060 (drain timer leak audit) |
| **Unique tasks** | **63** | sum of tags is 68 due to 5 cross-tagged Phase-1 tasks (62→63 after T045a addition) |

### Critical Path

Longest dependency chain (~12 nodes):

```
T006 → T007 → T028 → T029 → T039 → T053 (caddy-failure-post-switch E2E) → T058 → T061 → T062
```

Or alternative path through US4 abort chain:

```
T006 → T007 → T028 → T029 → T045 → T054 (restart-recovery E2E) → T061 → T062
```

Wall-clock estimate: ~7-9 working sessions of focused implementation
(orchestrator T028 alone is ~2 sessions due to state-machine complexity
+ DB-tx wrapping per transition + WS broadcast ordering).

---

## Implementation Strategy

### MVP scope

**Smallest demoable slice: US1 + US2 happy path + US5 verification** (P1 + P1 + P3 verification).

- US1 alone gives operator the dial — they can flip strategy + tune drain.
- US2 happy path proves the end-to-end story without the full failure
  matrix (US3/US4 can ship in iteration 2).
- US5 verification ensures no regression — recreate path keeps working.

**Recommended demo path**: Phase 1 → Phase 2 → Lane A (T017..T023) +
Lane B happy-path subset (T024..T029, T035..T039) + Lane E (T055..T056)
in parallel → smoke via T061 quickstart.

Operator demos: configure blue_green on a stateless web app → deploy →
watch state machine progress → see traffic switch with no drops → verify
recreate-strategy app still works.

### Incremental delivery

After MVP:

1. **Lane C (US3 Rollback)** — completes the "candidate fails" recovery
   path. Small, mostly tests + UI verification.
2. **Lane D (US4 Abort + recovery RPCs)** — biggest UX surface area;
   manual-recovery paths for caddy admin failure + restart recovery.
3. **Lane B remaining** (T040 SC-001 request-flood) — production readiness
   gate.
4. **Phase 8 (Polish)** — security audit + memory leak audit + validate.

### Parallel agent strategy

Five concurrent lanes post-Phase 2 (constrained by US2's orchestrator
being foundational for US3/US4):

- **Agent BE-A** (Lane A): PATCH validation + EditAppForm wiring
- **Agent BE-B** (Lane B): orchestrator + state machine + Caddy switcher + drain timer + slot namer
- **Agent BE-C** (Lane D): manual-recovery RPCs (after T028)
- **Agent FE-A** (Lanes A+B+D): DeployStrategySection + BlueGreenDeployLog + AbortDialog + CaddyAdminFailureRecoveryDialog + InterruptedDeploysPanel
- **Agent E2E** (all lanes): integration test fixtures + cross-domain assertions

No file overlap between lanes. `EditAppForm.tsx` owned by T021 (Lane A);
`AppsList.tsx` owned by T051 (Lane D); other components are single-owner.

---

## Independent test criteria summary (per US)

| US | Test gate | Tasks |
|---|---|---|
| US1 | PATCH validation matrix + UI volume ack panel | T023 |
| US2 | Happy-path state machine + SC-001 request-flood + first-deploy rename | T039, T040 |
| US3 | Candidate fail + Caddy pre-switch fail rollback paths | T043, T044 |
| US4 | Abort during drain + Caddy post-switch recovery + restart recovery | T052, T053, T054 |
| US5 | Recreate strategy unchanged + strategy switch lifecycle | T056, T057 |
| Polish | Quickstart end-to-end smoke | T061 |

---

## Generated by `/speckit.tasks`

Suggested next: `/speckit.analyze` (recommended after experience with 010/011 — analyze caught orphan refs + graph syntax + coverage gaps in prior runs).
