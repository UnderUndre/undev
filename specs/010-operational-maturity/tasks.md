# Tasks: Operational Maturity

**Feature**: 010-operational-maturity
**Inputs**: `spec.md`, `plan.md`, `research.md`, `data-model.md`, `contracts/api.md`, `contracts/failure-card.md`, `quickstart.md`
**Prerequisites**: features 001/003/005/007/008/009 merged. **Cross-feature note**: feature 011 occupies `0010_zero_touch.sql`; this feature uses `0011_operational_maturity.sql`. When both branches merge to main, sequence is 0010 → 0011 (alphabetical, also matches spec creation order).
**Format reminder**: every task line is `- [ ] [TaskID] [AGENT] [Story?] Description with file path`. No `[P]` markers, no chained arrows. Story tag `[USx]` only inside Phase 3..8.

## Agent tags

| Tag | Domain |
|---|---|
| `[SETUP]` | Cross-cutting shared-file writes — single owner per file |
| `[DB]` | Migration `.sql`, `schema.ts`, parameterized Drizzle queries |
| `[BE]` | Server services / routes / lib |
| `[FE]` | React components / hooks / pages |
| `[OPS]` | Documentation, deployment configs |
| `[E2E]` | Cross-domain integration tests |
| `[SEC]` | Security audit / vulnerability review |

## Status legend

`[ ]` not started · `[~]` in progress · `[x]` done · `[!]` blocked

## Path conventions

- Server: `devops-app/server/`
- Client: `devops-app/client/`
- Migration: `devops-app/server/db/migrations/0011_operational_maturity.sql`
- Tests: `devops-app/tests/{unit,integration}/`

---

## Phase 1: Setup

- [x] T001 [SETUP] [BE] Verify no new npm deps required for this feature in `devops-app/package.json` — CSV streaming via `Buffer` + `res.write` (no `papaparse`), all other work uses existing infra (Express, drizzle-orm, React, Tailwind). Per Standing Order #2, no `npm install` runs.
- [x] T002 [SETUP] [BE] AGCG compliance audit for the planned files: scan plan.md's Project Structure list — every new `.ts` MUST land typed (no `as any`), pino-only logging (no `console.log`), Zod on every route body, `AppError.*` factories on every throw. Document deviations as inline TODO comments only; no behaviour change.
- [x] T003 [SETUP] [DB] Extend `devops-app/server/db/schema.ts` with Drizzle definitions for: 4 new `applications` columns (`preDeployScriptPath`, `postDeployScriptPath`, `onFailScriptPath`, `preDestroyScriptPath` — all `text("...").default(sql\`NULL\`)`) and extend `created_via` enum tuple to include `'migrate'`. Drizzle typed columns only, no raw SQL strings, single atomic edit. Match data-model.md exactly.
- [x] T004 [SETUP] [BE] Verify cross-feature audit catalogue compatibility — read `devops-app/server/lib/audit-middleware.ts` (or wherever existing `auditMiddleware` enumerates allowed actions per feature 001), confirm the catalogue is extensible (Set/array push pattern, not frozen literal). Document the integration approach in a 5-line comment for T037 (audit-extension task).

**Sync barrier — Phase 1 complete before Phase 2 starts.**

---

## Phase 2: Foundational

- [x] T005 [DB] Create `devops-app/server/db/migrations/0011_operational_maturity.sql` per data-model.md: ALTER `applications` add 4 hook columns (TEXT NULL each), ADD CHECK constraint `applications_script_path_hooks_mutex` per R-002 SQL expression (mutual exclusion FR-013a layer 4), DROP+ADD `applications_created_via_enum` constraint with `'migrate'` per R-003, DOWN migration in commented block warning operators about `created_via='migrate'` rows blocking constraint restore. Reviewable static SQL, no string interpolation. Per Standing Order #1, do NOT execute — file only.
- [x] T006 [BE] Implement `devops-app/server/lib/script-hook-validator.ts` per data-model.md FR-013/FR-013a — exports typed `validateHookFields(fields: HookFields): { ok: true } | { ok: false; error: AppError }`. Implements: (a) per-field regex `/^(?!\/)(?!.*\.\.)(?!.*[;|&$()<>{}[\]\\]).*\.sh$/` + length cap 256 (reused from feature 007), (b) NULL normalisation (empty string → null), (c) cross-field mutual-exclusion check vs `script_path`. Returns discriminated union; no `as any`. Single source of truth for ALL three Zod-layer validations.
- [x] T007 [BE] Add unit tests `devops-app/tests/unit/script-hook-validator.test.ts` — every regex variant (leading slash rejected, `..` rejected, shell metachars rejected, `.sh` required), NULL normalisation (`""` → null), mutual exclusion (script_path + any one hook → `script_path_hooks_mutually_exclusive` error; script_path alone → ok; hooks alone → ok; both NULL → ok). Vitest.
- [x] T008 [BE] Implement `devops-app/server/lib/failure-state-declarations.ts` per `contracts/failure-card.md` — pure-data registry (no React, no callbacks, no client routes) per Session 2026-05-05 review G-P0-2. Exports: typed `FailureActionKind` enum (8 variants — note `Revoke` excluded per G-P0-4, `ForceDelete` added per GE-2), typed `FailureStateDeclaration { icon, applicableContexts, defaultActionKinds, fromStep?, customLabel? }`, exported readonly `FAILURE_STATE_DECLARATIONS: Record<string, FailureStateDeclaration>` covering all states from spec (deploy, bootstrap clone/compose/healthcheck/proxy/cert, cert lifecycle, health, caddy, plus `pre_destroy_hook_failed`). Typed inputs/outputs only, no `as any`.
- [x] T009 [BE] Add unit tests `devops-app/tests/unit/failure-state-declarations.test.ts` — every entry has `defaultActionKinds.length >= 1`; every `bootstrap_state` value matching `/^failed_/` from feature 009 has a declaration entry; `pre_destroy_hook_failed` declaration exists with actions `["Retry", "ForceDelete"]`; `RetryFromFailedStep` declarations always include `fromStep`; `Custom` declarations always include `customLabel`; `FailureActionKind` does NOT include `Revoke` (regression guard for G-P0-4 fix).
- [x] T010 [BE] Scaffold `devops-app/server/services/hard-delete-with-hooks.ts` per R-008 — typed `hardDeleteWithHooks(appId: string, userId: string): Promise<HardDeleteResult>`. Class skeleton: (a) load app row, (b) if `preDestroyScriptPath` non-NULL, dispatch via `scriptsRunner` and abort on non-zero, (c) delegate to `feature008/hard-delete-app` OR `feature009/bootstrap-hard-delete` based on `created_via`. Constructor accepts `scriptsRunner` + delegates as DI for testability. No DB writes here — delegation does that.
- [x] T011 [BE] Scaffold `devops-app/server/services/scripts-runner.ts` HOOK DISPATCH POINTS — locate the existing deploy flow in this file (verify exact symbol during implementation), insert four conditional `runHook(stage, scriptPath)` invocations: pre_deploy (after git fetch+reset, before compose), post_deploy (after compose-up success), on_fail (only on prior failure, warn-only error handling). Hook env builder reuses existing `SECRET_*` export logic per FR-011 + R-001. No new manifest entries — operator-supplied paths invoked as `bash <appDir>/<hookPath>`.
- [x] T012 [BE] Extend the `auditMiddleware` action catalogue (file located in T004) with 4 new event types per data-model.md: `app.hooks_changed`, `app.migrated_from_scan`, `app.migrated`, `app.cross_server_domain_confirmed`. Each gets a typed payload Zod schema. Cross-reference feature 011's catalogue (9 events from that feature) — document that the merged catalogue carries 13 new events post-merge.

**Sync barrier — Phase 2 complete before any user-story phase starts.**

---

## Phase 3: User Story 1 — Onboard new app via Bootstrap wizard (P1)

**Goal**: Server detail Apps tab gets a "Bootstrap from GitHub" button that opens feature 009's BootstrapWizard component.

**Independent test criteria**: button visible on Apps tab; click opens wizard modal; wizard mount works against existing feature 009 backend (smoke test via mocked SSH + GitHub API); successful bootstrap completion refreshes the Apps list with the new row.

- [x] T013 [FE] [US1] Modify `devops-app/client/components/apps/AppsTab.tsx` — add a "Bootstrap from GitHub" button positioned next to existing "Add Application" and "Scan Server" buttons. Click opens feature 009's `BootstrapWizard` modal (import from `bootstrap/BootstrapWizard.tsx`). On wizard `onComplete` callback, refresh the Apps list (use existing data-fetch hook, verify exact symbol during implementation). Controlled state, no `as any`.
- [~] T014 [E2E] [US1] Add `devops-app/tests/integration/bootstrap-wizard-mount.test.ts` — render Server detail Apps tab with mocked feature 009 backend (SSH + GitHub Contents API + script_runs orchestrator), click Bootstrap button, drive wizard through 5 steps, assert: wizard appears, state machine transitions visible, on completion the Apps list refreshes and new app row appears with `created_via='bootstrap'`. Smoke check per FR-005 + SC-001.

---

## Phase 4: User Story 2 — Inject database migration via pre_deploy hook (P1)

**Goal**: 4 hook columns surfaced in Edit Application form; runner invokes hooks at correct dispatch points; mutual exclusion with `script_path` enforced at all 4 layers (FR-013a).

**Independent test criteria**: PATCH /apps/:id with `preDeployScriptPath: "scripts/migrate-db.sh"` succeeds when `scriptPath` is null and 400-fails when `scriptPath` is non-null; subsequent deploy invokes hook in correct order between git-reset and compose-up; non-zero hook exit aborts deploy.

- [x] T015 [BE] [US2] Implement runner hook dispatch in `devops-app/server/services/scripts-runner.ts` (skeleton from T011) — full implementation per R-001 + R-011: linear sequence with explicit fail-fast on `pre_deploy` non-zero, fail-but-don't-rollback on `post_deploy` non-zero, warn-only on `on_fail`. Each hook is independent shell invocation with same env exports (APP_DIR/BRANCH/COMMIT/SECRET_*). **`on_fail` hook ADDITIONALLY receives `FAIL_PHASE` (one of `git_fetch|pre_deploy|compose_up|post_deploy`) and `FAIL_EXIT_CODE` (integer)** per FR-011 + Session 2026-05-05 review GE-3 — env-builder branches on dispatched hook stage. **Before dispatch, runner MUST call `validateHookFields(app)` (T006) and abort with `script_path_hooks_mutually_exclusive` if invariant violated** per FR-013a layer 3 — defends against direct DB writes that bypassed route. Deploy flow's `script_runs.params` JSONB gains `hookContext: DeployHookContext` field per data-model.md (no hook contents, only paths + outcomes). Parameterized Drizzle for state UPDATE.
- [x] T016 [BE] [US2] Implement `pre_destroy` invocation in `devops-app/server/services/hard-delete-with-hooks.ts` (skeleton from T010) — full implementation per R-008a + R-008b: load app, **accept optional `force: boolean` parameter** per Session 2026-05-05 review GE-2; if `force === true`, skip the hook and audit `app.hard_deleted_force_bypass` with payload `{ skippedHookPath, skipReason: "operator_force_bypass" }` BEFORE delegating; otherwise dispatch hook if `preDestroyScriptPath` non-NULL, ABORT on non-zero (throws `AppError.internal("pre_destroy_hook_failed", { exitCode, hookPath, sshStderr })`); finally delegate to feature 008 or feature 009 hard-delete based on `created_via`. Wire as DI dependency, easy to mock in tests. Route handler T018 reads `?force=true` query param and threads to this function.
- [x] T017 [BE] [US2] Modify `devops-app/server/routes/apps.ts` PATCH handler — extend Zod body schema with the 4 hook fields per `contracts/api.md` § HookFields, apply `validateHookFields` from T006 as `superRefine`, return 400 `script_path_hooks_mutually_exclusive` on violation per FR-013a layer 2. Audit `app.hooks_changed` with `addedHooks/removedHooks/changedHooks` key arrays (paths included — paths are not secret, but no script CONTENTS).
- [x] T018 [BE] [US2] Modify hard-delete route handlers (`devops-app/server/routes/apps.ts` for feature 008 path AND `devops-app/server/routes/bootstrap.ts` for feature 009 path) — switch the import to call `hardDeleteWithHooks(appId, userId, { force })` instead of the underlying services directly. **Add Zod query schema validating `force: z.coerce.boolean().default(false)`** per Session 2026-05-05 review GE-2 contract; thread `force` to the wrapper. On hook-failure response, return 422 `pre_destroy_hook_failed` with `{ hookPath, exitCode, sshStderr }` so client renders FailureCard with Retry+ForceDelete actions per FR-010. Verify both routes call into the wrapper. Per CLAUDE.md decorator pattern goal — no modification of feature 008/009 services.
- [x] T019 [FE] [US2] Modify `devops-app/client/components/apps/EditAppForm.tsx` — add a collapsible **Lifecycle Hooks** section (collapsed by default per FR-012). Section contains 4 controlled inputs (preDeployScriptPath, postDeployScriptPath, onFailScriptPath, preDestroyScriptPath). Client-side validation mirrors server (`validateHookFields` regex via shared module). When user types a hook path AND `scriptPath` is non-empty, Save button disabled with inline error "Pick either script_path OR lifecycle hooks, not both" (FR-013a layer 1). **Add a "Switch from script_path to hooks" button** per Session 2026-05-05 review GE-6: clicking pre-fills the pending PATCH with `script_path: null` so operator can populate hooks AND clear `script_path` in a single atomic submit. CHECK constraint validates final row state, not intermediate. No `as any`, controlled inputs only.
- [x] T020 [BE] [US2] Add unit tests `devops-app/tests/unit/scripts-runner-hooks.test.ts` — fixture-driven dispatch order: pre_deploy fails → deploy aborts before compose, on_fail fires; pre_deploy succeeds → compose runs; post_deploy fails → deploy `failed` but compose state UNTOUCHED; on_fail failure → warn log, no propagation. Mock `executeWithStdin` and `runScript`; assert env exports include all SECRET_*.
- [x] T021 [BE] [US2] Add unit tests `devops-app/tests/unit/hard-delete-with-hooks.test.ts` — pre_destroy hook absent → delegates straight to feature 008 or 009 path; pre_destroy hook present + exit 0 → delegate proceeds; pre_destroy non-zero → throws `pre_destroy_hook_failed`, never reaches delegate (asserts feature 008/009 hard-delete NOT called via spy).
- [~] T022 [E2E] [US2] Add `devops-app/tests/integration/hooks-end-to-end.test.ts` — PATCH /apps/:id setting `preDeployScriptPath` succeeds (assert audit `app.hooks_changed`); attempting to set `preDeployScriptPath` while `scriptPath` already set fails with 400 `script_path_hooks_mutually_exclusive`; trigger a deploy on the patched app, mock SSH executor, assert hook dispatched after git-reset and before compose-up; assert `script_runs.params.hookContext.preDeploy.exitCode === 0`. Cross-validates 3 Zod layers (form is implicit through PATCH request body validation).
- [x] T063 [FE] [US2] Modify `devops-app/client/components/apps/HardDeleteDialog.tsx` (verify exact path during implementation — may live as inline component in a parent page) — when DELETE response is 422 `pre_destroy_hook_failed`, render `<FailureCard state="pre_destroy_hook_failed">` instead of generic error toast. FailureCard surfaces `Retry` (re-runs hook by re-issuing DELETE without `?force`) and `ForceDelete` (re-issues DELETE with `?force=true`, opens typed-confirm dialog requiring app name) per FR-010 + Session 2026-05-05 review GE-2. After successful ForceDelete, surface confirmation that `app.hard_deleted_force_bypass` audit emitted. Controlled inputs only, no `dangerouslySetInnerHTML`.

---

## Phase 5: User Story 3 — Unified FailureCard across deploy / bootstrap / cert (P1)

**Goal**: typed `FailureAction` discriminated union mounted in DeployLog (FR-015), BootstrapStateBadge (FR-016), DomainTlsSection (FR-017) per single canonical lexicon.

**Independent test criteria**: each of the three mount sites renders a FailureCard on its respective failure state; action set per context matches the registry; renderer's switch is exhaustive (compile fails if a variant is unhandled); `RetryFromFailedStep` includes `fromStep` for bootstrap context.

- [x] T023 [FE] [US3] Implement `devops-app/client/components/failure/FailureCard.tsx` per `contracts/failure-card.md` — typed component with discriminated-union `FailureAction[]` actions prop, props `{ state, summary, details?, actions? }`. Renders red-border container, status icon (resolved via `FAILURE_STATE_DECLARATIONS[state].icon` from server-side declarations module per Session 2026-05-05 review G-P0-2), summary as `<h3>`, details inline (React tree, NOT `dangerouslySetInnerHTML`), action row at bottom-right. Empty/omitted `actions` → no action row. Destructive actions auto-positioned far-right with extra margin.
- [x] T024 [FE] [US3] Implement `devops-app/client/components/failure/FailureActionButton.tsx` — variant-aware renderer with exhaustive `switch (action.kind)` over all **8 variants** (Retry, RetryFromFailedStep, EditConfig, ViewLog, HardDelete, **ForceDelete**, ForceRenew, Custom — note `Revoke` removed per Session 2026-05-05 review G-P0-4, `ForceDelete` added per GE-2). Uses `_never: never` exhaustiveness assertion at default branch — but **throws `AppError.internal("unhandled_failure_action", { kind: _never })`, NOT raw `throw new Error(...)`** per Session 2026-05-05 review G-P1-5 + CLAUDE.md AGCG. Internal helper `renderTrigger(action, label, ButtonKind)` switches on `action.trigger.type` ("navigate" → href button, "callback" → onClick button) — also exhaustive with AppError on default. Maps to fixed display labels per contract (no freeform except `Custom.label`). Destructive variants (HardDelete, ForceDelete, ForceRenew) render as red buttons. No `dangerouslySetInnerHTML`.
- [x] T025 [FE] [US3] Add unit tests `devops-app/tests/unit/failure-card.test.ts` — fixture rendering for each variant: assert label, icon class, and onClick/href wiring per contract; assert empty actions → no action row; assert exhaustive switch (TypeScript-enforced at compile, runtime test asserts `_never` branch never fires under valid input).
- [x] T026 [FE] [US3] Modify `devops-app/client/components/deploy/DeployLog.tsx` — replace existing red banner on `job.status === 'failed'` with `<FailureCard>` driven by `wireActions(job.failureState ?? 'failed', { kind: 'deploy', jobId, appId }, callbacks)` from T064 wiring module + T065 callbacks hook. Default state token `'failed'` if more specific state not provided. Per FR-015 action set: Retry, ViewLog, optionally EditConfig.
- [x] T027 [FE] [US3] Modify `devops-app/client/components/bootstrap/BootstrapStateBadge.tsx` — when `app.bootstrapState` matches `/^failed_/`, expand the inline badge to a `<FailureCard>` with `state={app.bootstrapState}`, summary from `bootstrapStateSummary` helper, details from `<BootstrapEventTail>`. Actions wired via `wireActions(app.bootstrapState, { kind: 'bootstrap', appId, bootstrapState }, callbacks)` from T064/T065. Action set per FR-016: `RetryFromFailedStep` carrying `fromStep`, `EditConfig`, `HardDelete`. Existing healthy/in-progress states unchanged.
- [x] T028 [FE] [US3] Modify `devops-app/client/components/apps/DomainTlsSection.tsx` — when cert status is `failed`, `rate_limited`, or `pending_reconcile`, render a `<FailureCard>` with `state={\`cert_${certStatus}\`}`. Action set per FR-017 (revised): `ForceRenew`, `EditConfig` only. **`Revoke` is INTENTIONALLY excluded** per Session 2026-05-05 review G-P0-4 — Revoke lives on the normal cert UI when status is `active`, never inside FailureCard. Existing happy-path UI (rendered when status is `active`) unchanged and continues to expose Revoke as a regular cert-management action.
- [~] T029 [E2E] [US3] Add `devops-app/tests/integration/failure-card-deploy.test.ts` — render DeployLog with mocked `failed` job, assert FailureCard mounted, assert "Retry" + "View full log" buttons present, click Retry → asserts dispatch (mocked).
- [~] T030 [E2E] [US3] Add `devops-app/tests/integration/failure-card-bootstrap.test.ts` — render app row with `bootstrapState='failed_clone'`, assert BootstrapStateBadge expanded to FailureCard, assert "Retry from cloning" button present (RetryFromFailedStep with `fromStep='cloning'`), assert "Hard delete…" button opens typed-confirm dialog (NOT direct delete).
- [~] T031 [E2E] [US3] Add `devops-app/tests/integration/failure-card-cert.test.ts` — render DomainTlsSection with mocked cert in `rate_limited` state, assert FailureCard mounted, assert "View full log" button present BUT NO "Retry" (per registry for cert_rate_limited — operator must wait out window).
- [x] T064 [FE] [US3] Implement `devops-app/client/lib/failure-state-wiring.ts` per `contracts/failure-card.md` (Session 2026-05-05 review G-P0-2 server/client split) — typed `wireActions(state: string, ctx: FailureContext, callbacks: FailureCallbacks): FailureAction[]` consumes server-side `FAILURE_STATE_DECLARATIONS` (T008) and produces fully-wired `FailureAction[]` for the four contexts (deploy/bootstrap/cert/health). Pure helper functions `editHrefForCtx`, `logHrefForCtx`, `customTriggerForState` live in same module. Internal `wireOne(kind, declaration, ctx, callbacks)` switch is exhaustive over all 8 `FailureActionKind` values; default branch throws `AppError.internal("unhandled_action_kind")` (NOT raw `throw new Error`). No `as any`, typed inputs/outputs.
- [x] T065 [FE] [US3] Implement `devops-app/client/hooks/useFailureCallbacks.ts` per `contracts/failure-card.md` mount-site references — typed hook returning `FailureCallbacks` interface (`retryDeploy`, `retryFromStep`, `forceRenew`, `openHardDeleteDialog`, `openForceDeleteDialog`). Each callback wires to existing application-state mutators (e.g. `retryDeploy` calls existing `useDeployRetry` mutation). Returned object stable across renders (`useMemo`) so `wireActions` doesn't re-fire on every render. No `as any`.

---

## Phase 6: User Story 4 — Cross-server domain conflict report with typed-confirm (P2)

**Goal**: `GET /api/applications/cross-server-domain-check` enumerates conflicts; domain edit dialog renders conflict panel + typed-confirm field per FR-021.

**Independent test criteria**: GET cross-server endpoint returns conflicts excluding self + soft-deleted; domain edit dialog with conflicts disables Save until typed-confirm matches domain string exactly; server-side re-checks conflicts at write time per US4 edge case.

- [x] T032 [BE] [US4] Implement `devops-app/server/services/cross-server-domain-check.ts` per R-005 — typed `findCrossServerConflicts(domain: string, excludeAppId: string): Promise<DomainConflict[]>`. Single parameterized SELECT with subquery for cert status (latest by created_at). Excludes soft-deleted apps. Returns sorted by serverLabel + appName.
- [x] T033 [BE] [US4] Implement route file `devops-app/server/routes/cross-server-domain-check.ts` — `GET /api/applications/cross-server-domain-check` with Zod query schema (domain + excludeAppId), delegates to service from T032, returns array per `contracts/api.md`. Read-only, no audit emit. Standards: typed inputs/outputs, no `as any`.
- [x] T034 [BE] [US4] Implement shared helper `devops-app/server/lib/domain-attach-validator.ts` per Session 2026-05-05 review G-P0-1 (D2 from review outline) — typed `validateDomainAttach(domain, excludeAppId, typedConfirmation): Promise<{ ok: true; conflicts: [] } | { ok: true; conflicts: DomainConflict[]; auditEvent: 'app.cross_server_domain_confirmed' } | { ok: false; error: 'domain_confirmation_required'; conflicts: DomainConflict[] }>`. Used by THREE routes: `POST /apps/:id/domain` (feature 008, this task wires it), `POST /apps/migrate` (T051 wires it), and feature 009's `POST /apps/bootstrap` (cross-feature extension). **Audit `app.cross_server_domain_confirmed` ONLY when conflicts ACTUALLY found at write time** per Session 2026-05-05 review GE-5 — no false-positive audits when conflicts resolved between dialog and submit. Zod validation, parameterized Drizzle in service-side conflict query, structured error responses, no `as any`.
- [x] T035 [FE] [US4] Implement `devops-app/client/components/apps/CrossServerDomainConflictPanel.tsx` — typed props `{ conflicts: DomainConflict[] }`, renders inline panel (NOT a separate dialog) with one row per conflict: server label + app name + cert status icon + deeplink to that app's detail view. Empty conflicts → render nothing (panel is conditional). No `dangerouslySetInnerHTML`.
- [~] T036 [FE] [US4] Modify `devops-app/client/components/apps/DomainEditDialog.tsx` — call `useCrossServerDomainCheck` hook on domain change (debounced 300ms), embed `<CrossServerDomainConflictPanel>` when conflicts present. When conflicts present, replace the existing "Try anyway" checkbox with a typed-confirmation text input that requires the operator to type the exact domain string to enable Save (per FR-021). Empty/mismatched input disables Save with inline hint.
- [x] T037 [FE] [US4] Implement `devops-app/client/hooks/useCrossServerDomainCheck.ts` — typed `useCrossServerDomainCheck(domain: string \| null, excludeAppId: string \| null)`, returns `{ conflicts, isLoading, error }`. Debounced fetch via shared fetch wrapper. Empty inputs → no fetch.
- [~] T038 [BE] [US4] Add unit tests `devops-app/tests/unit/cross-server-domain-check.test.ts` — fixture DB rows: same-domain on different servers → returned as conflicts; same-domain self-app → excluded via `excludeAppId`; soft-deleted same-domain → excluded; no conflicts → empty array.
- [~] T039 [E2E] [US4] Add `devops-app/tests/integration/cross-server-domain-confirm.test.ts` — happy path: POST domain with no conflicts → 200 ok; conflict path: POST domain with conflicts but no typedConfirmation → 400 `domain_confirmation_required`; same with mismatched typedConfirmation → 400; same with exact-match typedConfirmation → 200 + audit `app.cross_server_domain_confirmed` emitted with conflict snapshot.
- [x] T066 [BE] [US4] Modify `devops-app/server/routes/apps.ts` `POST /api/applications/:id/domain` (existing feature 008 endpoint) — extend Zod body with optional `typedConfirmation: string \| null`. On submit, call `validateDomainAttach(domain, appId, typedConfirmation)` from T034's shared validator. When validator returns `{ ok: false, error: 'domain_confirmation_required' }`, return 400 with conflict snapshot. When validator returns `{ ok: true, conflicts, auditEvent }`, emit `app.cross_server_domain_confirmed` audit (in addition to existing `app.domain_changed`) per Session 2026-05-05 review G-P0-1 (closes H1 coverage gap from prior /speckit.analyze). Standards: parameterized Drizzle, no `as any`, structured error responses.
- [x] T067 [BE] [US4] **Cross-feature task** — extend feature 009's `POST /api/applications/bootstrap` endpoint to accept `domainTypedConfirmation: string \| null` and consume `validateDomainAttach` from T034 when `domain` is non-null (per Session 2026-05-05 review G-P0-1 + G-E-9 + closes H2 coverage gap). Bootstrap wizard's Domain step (feature 009 frontend) renders `<CrossServerDomainConflictPanel>` (T035) when conflicts surface. Mark task as cross-feature: lives across feature 010 + feature 009 PR boundaries; coordinate merge order so feature 010's T034 ships first OR ships in same merge group. If feature 009 has no follow-up PR planned, this work moves into a feature-009 sub-PR rather than feature 010 — flag in plan's Cross-feature coordination section.

---

## Phase 7: User Story 5 — Audit log UI with faceted filters and CSV export (P2)

**Goal**: `/audit` page with reverse-chronological list + faceted filters + URL-state-sync + CSV export streaming.

**Independent test criteria**: GET /api/audit with multi-select facets returns paginated rows respecting page caps; URL state survives page reload; CSV export streams (no full-buffer); deleted resources render plaintext label fallback.

- [x] T040 [BE] [US5] Implement `devops-app/server/services/audit-query.ts` per R-004 + R-012 — typed `query(filters, page, pageSize): Promise<AuditQueryResult>` with parameterized Drizzle, 100-row page cap, 10000-row total cap, **response includes `isCapped: boolean`** (true when actual matching rows would exceed 10000) per Session 2026-05-05 review G-P1-7. Plus `streamCsv(filters, req, res): Promise<void>` cursor-paginated streaming (500-row batches via `lastSeen` cursor, `res.write` chunks, hard-cap at 10000 rows). **Stream loop MUST register `req.on("close", ...)` and check abort flag at every batch boundary** per Session 2026-05-05 review GE-4 — closed-tab download releases DB cursor at next batch instead of running to cap. Typed inputs/outputs, no `as any`.
- [x] T041 [BE] [US5] Implement route file `devops-app/server/routes/audit.ts` — two endpoints: `GET /api/audit` with Zod query schema **including `resourceType: z.enum(["server", "application", "cert", "bootstrap", "other"])`** (added `'other'` per Session 2026-05-05 review G-P1-7 to match response domain), delegates to `audit-query.query`, response includes `isCapped` flag; `GET /api/audit/export.csv` with same query schema (minus pagination), delegates to `audit-query.streamCsv(filters, req, res)` (passes `req` so abort listener can register), `Content-Type: text/csv` + `Content-Disposition: attachment; filename=audit-<ISO>.csv`. Standards: Zod everywhere, no `as any`.
- [x] T042 [FE] [US5] Implement `devops-app/client/components/audit/AuditFilters.tsx` — typed filter sidebar component with: actor multi-select (auto-populated from API), action multi-select (auto-populated), resource type single-select (server/application/cert/bootstrap), time range presets (1h/24h/7d/30d/custom). State synced bidirectionally with URL query params via `useSearchParams` (or equivalent). Controlled inputs, no `as any`.
- [x] T043 [FE] [US5] Implement `devops-app/client/components/audit/ResourceLink.tsx` — typed renderer for the Resource cell. If resource still exists (lookup via `resourceId` non-null + matching server/app row), render as `<a>` deeplink; else render `resourceLabel` + `resourceId` as plaintext. Handles all 4 resource types (server, application, cert, bootstrap). No `dangerouslySetInnerHTML`.
- [x] T044 [FE] [US5] Implement `devops-app/client/components/audit/AuditTable.tsx` — typed reverse-chronological list with columns: Timestamp, Actor, Action, Resource (renders `<ResourceLink>`), Details (JSON tree component, NOT raw HTML). Pagination footer (page nav, page size selector capped at 100), **render "≥10,000 results — narrow filter to see all" banner when `isCapped: true`** in response (per Session 2026-05-05 review G-P1-7) instead of misleading "exactly 10,000 results". Export CSV button anchored to `/api/audit/export.csv` with current filter query. No `dangerouslySetInnerHTML`.
- [x] T045 [FE] [US5] Implement `devops-app/client/hooks/useAuditQuery.ts` — typed `useAuditQuery(filters, page, pageSize)` returns `{ rows, totalCount, isLoading, error }`. Uses shared fetch wrapper. Maps backend `details: unknown` to React-renderable structure for the JSON tree.
- [x] T046 [FE] [US5] Implement page `devops-app/client/pages/AuditPage.tsx` — composes `<AuditFilters>` (left sidebar) + `<AuditTable>` (main area). Reads URL query state via `useSearchParams`. Layout responsive (filter sidebar collapsible on small screens).
- [x] T047 [FE] [US5] Modify `devops-app/client/lib/sidebar-routes.ts` (verify exact module name during implementation — likely a routes registry or App layout) to add a new sidebar entry "Audit Log" routing to `/audit`. Single-line registration if pattern allows.
- [x] T048 [BE] [US5] Add unit tests `devops-app/tests/unit/audit-query.test.ts` — facet combinations (single facet, multiple facets, time range), page cap respected (request pageSize=200 → response pageSize=100), totalCount cap (mock 50000-row table → returns 10000), CSV streaming yields cursor-paginated rows in correct order with proper escaping (commas/quotes/newlines in `details_json`).
- [~] T049 [E2E] [US5] Add `devops-app/tests/integration/audit-page-faceted.test.ts` — render /audit with mocked audit_entries, apply facet filter (single actor + action), assert URL query updated, assert table shows only matching rows, click Export CSV → assert response is text/csv with correct Content-Disposition + at least one row.

---

## Phase 8: User Story 6 — Migration toolkit for legacy apps (P3)

**Goal**: `POST /api/applications/migrate` adopts an existing manually-configured app — INSERT new row OR PATCH-promote existing scan-row per FR-033a.

**Independent test criteria**: migrate on fresh path → 201 INSERT with `created_via='migrate'`; migrate on existing scan-row path → 200 PATCH-promote preserving `created_via='scan'`; migrate on existing manual/bootstrap/migrate row → 409 `path_already_managed`; migrate on missing target path → 422 `target_path_invalid`.

- [x] T050 [BE] [US6] Implement `devops-app/server/services/migration-toolkit.ts` per R-006 + R-010 — typed `adopt(input: MigrationInput, userId: string): Promise<MigrationResult>`. Internal flow: (a) **path-jail check via `path-jail.ts:resolveAndJailCheck(serverId, remotePath, server.scan_roots)`** per Session 2026-05-05 review GE-1 — out-of-jail paths reject with 422 `target_path_jail_violation` BEFORE any DB write; defends against `/etc`/`/var/log`/symlink-escape adoption that would later let Hard Delete brick the host; (b) SSH `test -d` validation → 422 `target_path_invalid` on fail; (c) **if `domain` non-null, call `domain-attach-validator.ts:validateDomainAttach`** (T034) per Session 2026-05-05 review G-P0-1 + G-E-9 — typed-confirm REQUIRED in this flow when conflicts present; emit `app.cross_server_domain_confirmed` audit only when conflicts ACTUALLY found at write time (per GE-5); (d) collision query for `(server_id, remote_path)` active row; (e) branch — no row → INSERT with `created_via='migrate'` + audit `app.migrated`; scan-row → PATCH-promote (fill missing fields, preserve `created_via='scan'`) + audit `app.migrated_from_scan`; other origin → 409 `path_already_managed`. Reuses feature 009's compose parser for service detection. Reuses feature 003's scan output for path autocomplete (read-only). Parameterized Drizzle, typed inputs/outputs, no `as any`.
- [x] T051 [BE] [US6] Implement route file `devops-app/server/routes/migration.ts` — `POST /api/applications/migrate` with Zod body schema per `contracts/api.md`, delegates to `migration-toolkit.adopt`, maps service result discriminator to HTTP status (201 INSERT / 200 PATCH-promote / 409 / 422). **Body MUST accept `domainTypedConfirmation: string | null`** per Session 2026-05-05 review G-P0-1; service-layer toolkit consumes T034's `domain-attach-validator.ts` so 409 `domain_confirmation_required` surfaces from validator at write time (not from this route directly — validator is the single check site). Optionally trigger first health probe (feature 006) when `healthUrl` provided; optionally trigger Caddy reconcile (feature 008) when `domain` provided. Structured error responses, no `as any`.
- [x] T052 [FE] [US6] Implement `devops-app/client/components/apps/MigrateExistingAppWizard.tsx` — typed multi-step wizard: Step 1 path input (autocomplete from feature 003 scan output via existing fetch), Step 2 compose file detection (calls feature 009 compose parser via backend), Step 3 optional health URL + domain, Step 4 review + submit. **NO hooks fields** per Session 2026-05-05 review G-P0-3 — operator configures hooks via EditAppForm AFTER migration succeeds. **When `domain` is set, render `<CrossServerDomainConflictPanel>` (T035) inline at Step 4** per Session 2026-05-05 review G-P0-1 + G-E-9: if conflicts present, surface typed-confirm field requiring exact-match domain string before submit; pass `domainTypedConfirmation` in request body. Calls `POST /api/applications/migrate`, maps response discriminator (`branch: "insert" | "patch_promote"`) to UI feedback ("Created" vs "Augmented existing scan row"). On 422 `target_path_jail_violation` response, surface error with `resolvedPath` + `allowedRoots` from response body. Controlled inputs, no `as any`.
- [x] T053 [FE] [US6] Modify `devops-app/client/components/apps/AppsTab.tsx` (already touched by T013) — add a fourth button "Migrate Existing App" next to Bootstrap / Add / Scan. Click opens `<MigrateExistingAppWizard>` modal. Verify single-owner-per-file rule from Phase 1 (T013 owns the file); this task's edit must integrate cleanly with T013's edit (recommended: both edits consolidated by Lane FE if they run sequentially).
- [x] T054 [FE] [US6] Implement `devops-app/client/hooks/useMigrationAdopt.ts` — typed mutation hook returning `{ mutate, isLoading, error, result }`. Maps server discriminator to typed result variant for UI rendering.
- [~] T055 [BE] [US6] Add unit tests `devops-app/tests/unit/migration-toolkit.test.ts` — collision detection: no row → INSERT branch; scan row → PATCH-promote branch (asserts `created_via` STAYS `'scan'`); manual/bootstrap/migrate row → reject branch with `path_already_managed`; SSH test -d failure → `target_path_invalid` reason `not_a_directory`; SSH connect failure → `ssh_unreachable`. Mock `executeWithStdin` and `db.select`.
- [~] T056 [E2E] [US6] Add `devops-app/tests/integration/migration-scan-promote.test.ts` — seed DB with existing scan-row (`created_via='scan'`, missing health URL + domain), POST /api/applications/migrate with health URL + domain → assert response code 200 (NOT 201), assert response body `branch: "patch_promote"` + `addedFields` lists `["healthUrl","domain"]` + `preservedCreatedVia: "scan"`, assert DB row has `created_via='scan'` (NOT mutated to migrate) AND new fields populated. Audit `app.migrated_from_scan` row written.

---

## Phase 9: Polish & Cross-Cutting Concerns

- [~] T057 [BE] Cross-feature audit catalogue verification — once both feature 010 + feature 011 merged, `auditMiddleware` catalogue should accept all 13 new event types (9 from 011 + 4 from 010). Add integration test `devops-app/tests/integration/audit-catalogue-cross-feature.test.ts` that emits one of each new type and asserts no rejection. Run AFTER both branches merge.
- [x] T058 [SEC] Security audit pass on hook execution paths: confirm hooks never log script CONTENTS (only paths + outcomes), confirm `script_runs.params.hookContext` shape contains only metadata, confirm `audit_entries.payload` for `app.hooks_changed` carries paths but not script CONTENTS, confirm pino redact extends to any new env-var leakage paths from `SECRET_*` exports inside hook env. Document findings inline (`docs/SECURITY_CHECKLIST.md` if existing pattern).
- [x] T059 [SEC] Security audit pass on migration toolkit: confirm `target_path` SSH check uses parameterised `shQuote` (no path injection), confirm scan-row PATCH-promote path cannot be triggered to escalate privileges (e.g. setting `script_path` or hooks via PATCH-promote — verify ONLY allowed-fields are PATCHed), confirm 409 `path_already_managed` response doesn't leak details about non-accessible apps. Document inline.
- [x] T060 [BE] Boot-time check `devops-app/server/lib/boot-checks.ts` extension — assert `audit_entries` schema includes the 4 new action types in catalogue (T012's wiring is correct), warn if any pre-0011 row has `created_via='migrate'` (impossible by data flow, but a sanity check against rogue inserts).
- [~] T061 [BE] Quickstart smoke check `devops-app/tests/integration/quickstart-010.test.ts` — drives the operator-facing flow from quickstart.md Steps 1..6 against mocked SSH + mocked GitHub API: bootstrap wizard mount → hook PATCH + deploy with hook → induce failure + FailureCard render → cross-server domain conflict + typed-confirm → audit page faceted query → migration toolkit PATCH-promote. Asserts each step's audit row appears in expected order.
- [x] T062 [BE] Final lint+typecheck+test pass per `npm run validate` per CLAUDE.md — every new file passes Biome/ESLint with no warnings, every Zod schema typecheck-clean, full test suite green. Failure here blocks merge.

---

## Dependency Graph

Following STRICT syntax (one rule per line, `→` single-unlock, `,` fan-out, `+` fan-in):

```
# Phase 1 → Phase 2 (sync barrier — fan-in uses `+` per syntax rules,
# fixed in /speckit.analyze pass after carried HIGH G1)
T001 + T002 + T003 + T004 → T005
T001 + T002 + T003 + T004 → T006
T001 + T002 + T003 + T004 → T008
T001 + T002 + T003 + T004 → T012

# Phase 2 internal
T006 → T007
T008 → T009
T010 → T011
T005 + T006 + T008 + T010 + T011 + T012 → T013

# Phase 2 → Phase 3 (US1)
T013 → T014

# Phase 2 → Phase 4 (US2)
T005 + T006 + T010 + T011 + T012 → T015
T010 → T016
T006 → T017
T016 → T018
T006 → T019
T015 → T020
T016 → T021
T015 + T017 + T018 → T022
T018 + T023 + T024 → T063

# Phase 2 → Phase 5 (US3)
T008 → T023
T008 → T024
T023 + T024 → T025
T008 → T064
T064 → T065
T023 + T024 + T064 + T065 → T026
T023 + T024 + T064 + T065 → T027
T023 + T024 + T064 + T065 → T028
T026 → T029
T027 → T030
T028 → T031

# Phase 2 → Phase 6 (US4)
T005 + T012 → T032
T032 → T033
T012 → T034
T033 → T035
T035 → T036
T033 → T037
T032 → T038
T033 + T034 + T036 → T039
T034 → T066
T034 → T067

# Phase 2 → Phase 7 (US5)
T012 → T040
T040 → T041
T041 → T042
T041 → T043
T041 + T042 + T043 → T044
T041 → T045
T042 + T044 + T045 → T046
T046 → T047
T040 → T048
T046 + T047 → T049

# Phase 2 → Phase 8 (US6)
T005 + T012 → T050
T050 → T051
T051 → T052
T052 → T053
T051 → T054
T050 → T055
T051 + T052 + T053 → T056

# Shared file constraint: AppsTab.tsx is touched by T013 (US1, Bootstrap
# button) AND T053 (US6, Migrate Existing App button). Force T053 to
# follow T013 to prevent FE-agent race on the same file (carried HIGH F1
# fix from prior /speckit.analyze pass).
T013 → T053

# Phase 9 (Polish) — sync barrier (extended to include T063..T067 from
# /speckit.analyze HIGH H1..H5 fixes)
T012 + T022 + T039 + T049 + T056 + T063 + T066 → T057
T015 + T017 + T022 + T063 → T058
T050 + T051 → T059
T012 → T060
T014 + T022 + T029 + T030 + T031 + T039 + T049 + T056 + T063 + T064 + T065 + T066 → T061
T014 + T022 + T029 + T030 + T031 + T039 + T049 + T056 + T057 + T058 + T059 + T060 + T061 + T063 + T064 + T065 + T066 + T067 → T062
```

### Self-validation

- [x] Every task ID in Dependencies exists in T001..T067 list (re-verified after G1/F1/H1..H5 fixes — 67 tasks, no orphan IDs).
- [x] No circular dependencies (DAG topology: Phase N → Phase N+ only).
- [x] Fan-in uses `+` only, fan-out uses `,` only — re-verified after G1 fix (Phase 1→2 transition fixed from `,` to `+`).
- [x] No chained arrows on a single line.
- [x] Phase boundaries enforced as multi-source fan-ins.
- [x] Shared file `AppsTab.tsx` (T013 + T053) has explicit `T013 → T053` edge — F1 fix.

---

## Parallel Lanes

After Phase 2 sync barrier (T012 done), six user-story lanes fork in parallel — all 6 US declared independently shippable per spec Session 2026-05-02:

| Lane | Agent flow | Tasks | Start condition |
|---|---|---|---|
| **Lane A — US1 Bootstrap mount** | FE→E2E | T013..T014 | Phase 2 complete |
| **Lane B — US2 Hooks** | BE→FE→E2E | T015..T022 | Phase 2 complete |
| **Lane C — US3 FailureCard** | FE→E2E | T023..T031 | Phase 2 complete (T008 specifically) |
| **Lane D — US4 Cross-server domain** | BE→FE→E2E | T032..T039 | Phase 2 complete |
| **Lane E — US5 Audit log UI** | BE→FE→E2E | T040..T049 | Phase 2 complete |
| **Lane F — US6 Migration toolkit** | BE→FE→E2E | T050..T056 | Phase 2 complete |

**Shared file note**: `AppsTab.tsx` is touched by both Lane A (T013 — Bootstrap button) and Lane F (T053 — Migrate Existing App button). Per the shared-file extraction rule, Lane A's T013 is the SETUP for the file's first edit; Lane F's T053 must run AFTER T013. Reflected in graph: `T013 → ... → T053`.

Polish phase (T057..T062) runs after every US lane closes — pure sync barrier.

### Agent Summary

Some Phase-1 tasks carry two tags (e.g. `[SETUP] [BE]` for shared-file
writes that need backend judgement) — this is why tag occurrences exceed
unique task count.

| Agent | Tag occurrences | Notable phases |
|---|---|---|
| `[SETUP]` | 4 | All in Phase 1 (T001..T004), each cross-tagged with implementing agent |
| `[DB]` | 2 | T003 (schema), T005 (migration) |
| `[BE]` | 32 | Bulk of work — Phase 2..8 services + routes + unit tests + T066/T067 (review-fix coverage) |
| `[FE]` | 22 | UI components in US1..US6 + T063 (HardDelete recovery) + T064 (state-wiring) + T065 (callbacks hook) |
| `[OPS]` | 0 | No new scripts or CI changes |
| `[E2E]` | 9 | Integration tests across every US + quickstart smoke |
| `[SEC]` | 2 | T058 (hook execution audit), T059 (migration toolkit audit) |
| **Unique tasks** | **67** | sum of tags is 71 due to 4 cross-tagged Phase-1 tasks |

### Critical Path

Longest dependency chain (~11 nodes after H1..H5 additions):

```
T005 → T006 → T015 → T017 → T022 → T058 → T061 → T062
DB migration → validator lib → runner hook dispatch → PATCH route → US2 E2E → security audit → quickstart smoke → final validate
```

Plus the FE-side critical sub-path through US3 (T008 → T064 → T065 → T026/T027/T028 → T029/T030/T031) finishing before T061 quickstart.

Wall-clock estimate: ~6-7 working sessions of focused implementation (each node ~1-2 hours with tests).

---

## Implementation Strategy

### MVP scope

**Smallest demoable slice: US1 + US3** (P1 + P1 frontend-heavy).

- US1 alone gives operator immediate value: "I can bootstrap a fresh app from the UI without SSHing".
- US3 alone makes every existing failure surface visually consistent — operators see the unified vocabulary even before US2 ships hooks.

Both are independent (Lane A + Lane C run in parallel). Skip US2/US4/US5/US6 for MVP — they extend the same foundations but aren't blocking the demo.

**Recommended demo path**: Phase 1 → Phase 2 → Lane A (T013..T014) + Lane C (T023..T031) in parallel → smoke via T061 quickstart. Operator demos: bootstrap a fresh app via wizard, induce a deploy failure, see unified FailureCard.

### Incremental delivery

After MVP:

1. **Lane B (US2 Hooks, P1)** — biggest backend slice, unblocks per-app deploy customisation. Requires Phase 2 + nothing else.
2. **Lane E (US5 Audit log UI, P2)** — operator-visible forensic value. No US dependency.
3. **Lane D (US4 Cross-server, P2)** — incremental safety polish. Uses existing feature 008 dialog as base.
4. **Lane F (US6 Migration, P3)** — unblocks legacy app onboarding. Requires Phase 2 + nothing else.
5. **Phase 9 (Polish)** — runs after every US lane closes.

### Parallel agent strategy

Six concurrent agents post-Phase 2 — this feature is unusually parallel-friendly:

- **Agent BE-A** (Lane B): runner hook dispatch + hard-delete decorator + PATCH validation
- **Agent BE-B** (Lane D): cross-server check service + route + dialog refactor backend
- **Agent BE-C** (Lane E): audit query + CSV stream + routes
- **Agent BE-D** (Lane F): migration toolkit + route
- **Agent FE-A** (Lanes A+C): Bootstrap mount + FailureCard + 3 mount sites + state mapper consumer
- **Agent FE-B** (Lanes B+D+E+F UI): EditAppForm hooks section + DomainEditDialog refactor + Audit page + Migrate wizard

No file overlap between lanes EXCEPT `AppsTab.tsx` (Lane A's T013 + Lane F's T053). Sequencing guaranteed by graph.

---

## Independent test criteria summary (per US)

| US | Test gate | Tasks |
|---|---|---|
| US1 | Bootstrap button visible + wizard mount drives state machine | T014 |
| US2 | Hooks PATCH validated 3 layers; runner dispatches at correct points | T020, T021, T022 |
| US3 | FailureCard mounts at 3 sites; exhaustive switch | T029, T030, T031 |
| US4 | Cross-server check + typed-confirm enforces domain match | T039 |
| US5 | Audit page faceted filters + URL state + CSV stream | T049 |
| US6 | Migration INSERT/PATCH-promote/409 branches all triggered | T056 |
| Polish | Quickstart end-to-end smoke | T061 |

---

## Generated by `/speckit.tasks`

Suggested next: `/speckit.implement` (or `/speckit.analyze` for cross-artifact consistency check first).
