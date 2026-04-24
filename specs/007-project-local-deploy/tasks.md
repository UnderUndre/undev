# Tasks: Project-Local Deploy Script Dispatch

**Input**: Design documents from `/specs/007-project-local-deploy/`
**Prerequisites**: plan.md (v1.1), spec.md (v1.0 + Session 2026-04-24 clarifications + Session 2026-04-24 GPT-review addendum), research.md, data-model.md, contracts/api.md, quickstart.md

**Tests**: Yes — unit tests for the validator + new helpers, integration tests per user story. TDD-Lite: tests land either before or alongside the implementation they cover (per CLAUDE.md / coding-standards §7 Workflow).

**Organization**: 5 user stories (US-1..US-5). US-1/US-2 are P1 (ship-blockers). US-3/US-4 are P2 (visibility + safety). US-5 is P3 (operator velocity). Rollback UX (FR-024) ships inside US-1 because adopting project-local deploy is the trigger for needing the confirmation dialog.

**Change from initial revision**: GPT review pass (Session 2026-04-24) surfaced 3 P0 / 4 P1 gaps. This revision (v1.1) incorporates: (a) strict-typed validator input (`string | null | undefined`, no coercion), (b) ASCII-only + `\` reject path policy, (c) runner pre-insert wrapper for FR-044 lifecycle, (d) ApplicationDetail visibility surface, (e) rollback integration test, (f) typed `params.scriptPath` extraction helper (no `as any`).

## Format: `[ID] [AGENT] [Story?] Description`

## Agent Tags

| Tag | Agent | Domain |
|-----|-------|--------|
| `[SETUP]` | — (orchestrator) | Shared file edits / build-system moves |
| `[DB]` | database-architect | Drizzle schema + migration |
| `[BE]` | backend-specialist | Services, validator, wrapper, routes, tests |
| `[FE]` | frontend-specialist | React components, form fields, dialogs, detail view |
| `[SEC]` | security-auditor | Three-layer validation audit |

No `[OPS]` phase — this feature introduces no Dockerfile changes, no CI workflow changes, no infrastructure. No `[E2E]` phase — integration tests live inside each user story's `[BE]` block against mocked `sshPool` + `postgres` drivers (same convention as feature 005).

## Task Statuses

| Status | Meaning |
|--------|---------|
| `- [ ]` | Pending |
| `- [→]` | In progress |
| `- [X]` | Completed |
| `- [!]` | Failed |
| `- [~]` | Blocked |

## Path Conventions

All paths relative to repo root (`undev/`). Server code lives under `devops-app/server/`, client under `devops-app/client/`, tests under `devops-app/tests/`. No bundled bash script for this feature — the project-local script lives on the target inside the checked-out repo.

---

## Phase 1: Setup

**Purpose**: Land the schema change + migration so the rest of the feature's code has a column to read/write.

- [ ] T001 [DB] Extend `devops-app/server/db/schema.ts` applications table: add `scriptPath: text("script_path")` (nullable by default). Place alphabetically among existing columns. No `as any`, no `notNull()` wrapper.
- [ ] T002 [DB] Create migration `devops-app/server/db/migrations/0006_project_local_deploy.sql` per data-model.md §Migration. Includes: ADD COLUMN + CHECK constraint (`IS NULL OR LENGTH(TRIM(...)) > 0`). Include migration header documenting non-destructive ADD + DOWN migration. Append journal entry `{ idx: 6, tag: "0006_project_local_deploy", when: <epoch-ms>, breakpoints: true }` to `devops-app/server/db/migrations/meta/_journal.json`. Admin applies manually on release (CLAUDE.md rule 5).

**Checkpoint**: Schema field exists in Drizzle; migration file reviewable; journal updated.

---

## Phase 2: Foundational (Validator + Manifest + Dispatch + Runner + Pre-Insert Wrapper)

**Purpose**: Build the three-layer validation primitive, register the new manifest entry, extend the deploy dispatcher, add the remote-exec runner branch, and add the pre-insert wrapper that guarantees the SC-007 forensics trail. Every user-story phase blocks on this phase completing.

### Shared validator (strict typing + ASCII policy)

- [ ] T003 [BE] Create `devops-app/server/lib/validate-script-path.ts` with typed inputs/outputs per plan.md §Shared validator: exported `validateScriptPath(raw: string | null | undefined): ValidateResult` where `ValidateResult = { ok: true; value: null } | { ok: true; value: string } | { ok: false; error: string }`. Rules in this order: (1) null/undefined → `{ok:true,value:null}`; (2) trim, empty → `{ok:true,value:null}`; (3) length > 256 → `"Path must be ≤256 characters"`; (4) `!/^[\x20-\x7E]+$/.test(trimmed)` → `"Path must be printable ASCII"`; (5) starts with `/` → `"Must be a relative path inside the repo"`; (6) contains `..` segment → `"Path cannot contain parent-directory traversal"`; (7) contains space or any of `\` `;` `|` `&` `$` backtick `<` `>` `"` `'` → `"Path contains characters that are not allowed"`. Returns trimmed string (no `./` rewriting — pass through). Input type is STRICT — no `unknown`, no coercion. No `as any`, no `console.log`.
- [ ] T004 [BE] Write unit test `devops-app/tests/unit/validate-script-path.test.ts` covering the SC-006 injection suite plus GPT-review edge cases (≥ 55 cases total). Export a `FIXTURES` const array at module level (T006 imports it). Categories: (a) **Non-string input rejection** — ensure route layer rejects these before they reach the validator, OR document that the validator's signature narrows them out — test the route-layer behaviour in T018 instead; (b) **Traversal**: `../foo`, `foo/../bar`, `a/../../b`, `scripts/../../etc/passwd`; (c) **Absolute**: `/etc/passwd`, `//netloc`, `/`; (d) **Shell metachars**: `foo;rm -rf /`, `$(id)`, `` `whoami` ``, `foo|bar`, `foo&bar`, `foo>out`, `foo<in`, `foo"bar`, `foo'bar`, `foo bar` (space), `foo\\bar` (backslash — **NEW GPT-P1-5**); (e) **Control chars / non-ASCII**: `foo\nbar`, `foo\0bar`, `скрипты/деплой.sh` (Cyrillic — **NEW GPT-P1-6**, expect `"printable ASCII"` error), `scripts/café.sh` (Latin extended), `scripts/😀.sh` (emoji); (f) **Length**: exact 256 ASCII chars → pass, 257 → reject, `"a".repeat(512)` → reject; (g) **Empty / whitespace**: `""`, `"   "`, `"\t"`, `null`, `undefined` → `{ok:true,value:null}`; (h) **Valid**: `scripts/devops-deploy.sh`, `scripts/nested/path/deploy.sh`, `a.sh`, `._hidden.sh`, `./scripts/deploy.sh` (GPT-P1-5 — `./` ALLOWED, pass through unchanged); (i) **Regression**: the `.` segment alone is allowed (`./foo/./bar.sh`). TDD-Lite: lands in the same commit as T003.
- [ ] T005 [FE] Create `devops-app/client/lib/validate-script-path.ts` mirroring T003 byte-for-byte in logic. Same strict typed signature `(raw: string | null | undefined)`. TypeScript `ValidateResult` is the same discriminated union. Import-shape identical so a PR author can diff the two files for parity. No `as any`, no `console.log`.
- [ ] T006 [BE] Write parity test `devops-app/tests/unit/validate-script-path-parity.test.ts` that imports both `server/lib/validate-script-path` and `client/lib/validate-script-path`, runs the `FIXTURES` array from T004 against both, and asserts `deepEqual(serverResult, clientResult)` for every fixture. Fails loud on any divergence.

### Manifest entry + dispatch extension

- [ ] T007 [BE] Extend `devops-app/server/scripts-manifest.ts` `manifest` array with the `deploy/project-local-deploy` entry per data-model.md §New manifest entry. Fields: `id`, `category: "deploy"`, `description`, `locus: "target"`, `requiresLock: true`, `timeout: 1_800_000`, `dangerLevel: "low"`. `params` Zod schema: `z.object({ appDir: z.string(), scriptPath: z.string().refine((s) => { const r = validateScriptPath(s); return r.ok && r.value !== null; }, "Invalid scriptPath"), branch: z.string().regex(BRANCH_REGEX), commit: z.string().regex(SHA_REGEX).optional(), noCache: z.boolean().default(false), skipCleanup: z.boolean().default(false) })`. Import `validateScriptPath` from `./lib/validate-script-path.js`. The `z.string()` on `scriptPath` is STRICT — the refine only runs when the input IS a string, so the refine can trust the parameter type (narrower than the validator's `string | null | undefined`, and an empty/null would fail `z.string()` first).
- [ ] T008 [BE] Extend `devops-app/tests/unit/scripts-manifest.test.ts` with project-local-deploy assertions: (a) `validateManifestLenient()` returns `{ valid: true, validationError: null }`; (b) `getManifestDescriptor()` surfaces 6 fields (`app-dir`, `script-path`, `branch`, `commit`, `no-cache`, `skip-cleanup`); (c) `params.parse({ scriptPath: "../evil", ... })` throws ZodError with the refine's `"Invalid scriptPath"` message; (d) `params.parse({ scriptPath: null, ... })` throws ZodError from `z.string()` (null not a string — never reaches refine); (e) `params.parse({ scriptPath: 123, ... })` throws ZodError from `z.string()` (non-string rejected upfront). TDD-Lite: lands with T007.
- [ ] T009 [BE] Extend `devops-app/server/services/deploy-dispatch.ts` `resolveDeployOperation` with a new top-of-function branch: when `app.scriptPath` is truthy (canonical non-null string), return `{ scriptId: "deploy/project-local-deploy", params: { appDir: app.remotePath, scriptPath: app.scriptPath, branch, noCache: runParams.noCache ?? false, skipCleanup: runParams.skipCleanup ?? false, ...(runParams.commit ? { commit: runParams.commit } : {}) } }`. Existing branches unchanged below. Update `ResolveDeployInput` + `ResolveDeployResult` types. Pure function, no side effects.
- [ ] T010 [BE] Extend `devops-app/tests/unit/resolve-deploy-operation.test.ts` with 4 new cases per plan.md + 3 null-passthrough regression cases (the FR-020 contract): (a) `scriptPath="scripts/devops-deploy.sh" + source=manual + repoUrl=git` → project-local; (b) `scriptPath set + scan+git` → project-local (wins over scan heuristic); (c) `scriptPath set + docker://` → project-local (wins over docker heuristic); (d) `scriptPath null + manual+git` → `deploy/server-deploy` (regression); (e) `scriptPath null + scan+git+skipInitialClone` → `deploy/server-deploy` with `skipInitialClone:true` preserved; (f) `scriptPath null + docker://+skipInitialClone` → `deploy/deploy-docker`. TDD-Lite: lands with T009.

### Runner remote-exec branch + command builder

- [ ] T011 [BE] Create `devops-app/server/services/build-project-local-command.ts` with typed inputs/outputs per plan.md §buildProjectLocalCommand helper: exported pure function producing `bash <appDir>/<scriptPath> --app-dir=... --branch=... [--commit=...] [--no-cache] [--skip-cleanup]`. Imports `shQuote` from `../lib/sh-quote.js`.
- [ ] T012 [BE] Write unit test `devops-app/tests/unit/build-project-local-command.test.ts` (≥ 20 cases): happy path; with commit; with flags; adversarial `appDir` containing `'` → shQuote-escaped; adversarial `appDir` with spaces (`/opt/my app`) → still single-quoted; extremely long values. TDD-Lite: lands with T011.
- [ ] T013 [BE] Extend `devops-app/server/services/scripts-runner.ts` `runScript` method: (1) add optional `reuseRunId?: string` to the `options` parameter; when set, the runner UPDATEs the existing `script_runs` row by id instead of INSERTing a new row (pending→running→terminal transitions still happen, just on the pre-existing row); (2) add dispatch-kind branch — after the existing `entry.params.parse(params)` + lock + pre-insert/reuse step, if `scriptId === "deploy/project-local-deploy"`, call `const cmd = buildProjectLocalCommand(parsedParams); await sshPool.execStream(serverId, cmd, runId)` INSTEAD of the bundled-script common.sh-concat + `executeWithStdin` path. Existing bundled path unchanged for all other scriptIds. The runner does NOT catch ZodError from the parse — it propagates to the wrapper (see T014). No `as any`, structured logger `{ ctx: "scripts-runner-project-local", ... }`.

### Pre-insert wrapper (FR-044 lifecycle)

- [ ] T014 [BE] Create `devops-app/server/services/project-local-deploy-runner.ts` with typed inputs/outputs per plan.md §Pre-insert wrapper. Exports `dispatchProjectLocalDeploy({ scriptId, serverId, params, userId, deploymentId }): Promise<{ runId; jobId }>`. Allocates `runId = randomUUID()`; inserts `script_runs` row with `status: "pending"`, raw `params`, `scriptId`, `serverId`, `userId`, `deploymentId`, `startedAt`; calls `scriptsRunner.runScript(scriptId, serverId, params, userId, { linkDeploymentId: deploymentId, reuseRunId: runId })`; on success, returns `{ runId, jobId }` (row already transitioned to terminal status by runner); on ZodError, UPDATEs the row to `status: "failed"`, `errorMessage: "scriptPath failed runtime validation: " + err.issues[0].message`, `finishedAt: now`, then throws a `ProjectLocalValidationError` (new custom error class in the same file). Other thrown errors propagate without wrapping. Drizzle ORM parameterized queries, no raw SQL. Typed inputs, no `as any`.
- [ ] T015 [BE] Write integration test `devops-app/tests/integration/project-local-deploy-runner.test.ts` against mocked `scriptsRunner` + `postgres`: (a) **Happy path**: wrapper inserts pending row, calls runner with `reuseRunId`, runner transitions row through `running → success`; returned `{ runId, jobId }` match the allocated runId; (b) **ZodError path (SC-007 critical)**: seed a tampered `scriptPath: "../evil"`; invoke wrapper; assert (i) pending row WAS inserted (spy on Drizzle insert), (ii) the row WAS subsequently updated to `status: 'failed', errorMessage` matching `/scriptPath failed runtime validation: .*/`, (iii) `finishedAt` populated, (iv) `ProjectLocalValidationError` thrown; (c) **Non-Zod error path**: runner throws a `DeploymentLockedError`; wrapper does NOT update row to failed (that's the runner's responsibility on lock failure); error re-thrown unchanged; (d) **Row-id reuse invariant**: assert exactly 1 row inserted + ≤ 1 update (no double-insert). TDD-Lite: lands with T014.

**Checkpoint**: Validator exists with strict typing + ASCII rules; manifest entry registered; dispatcher routes correctly; runner has remote-exec branch + `reuseRunId` support; wrapper guarantees SC-007 forensics trail. User-story lanes can fork.

---

## Phase 3: User Story 1 — Replace builtin deploy with project's own script (Priority: P1)

**Goal**: An operator can set `scriptPath` on an application and subsequent deploys invoke the project-local script; rollback surfaces a confirmation dialog; `scriptPath` is visible in the application detail view (US-1, FR-002, FR-024, SC-001, SC-004, SC-005).

**Independent Test**: Create an app with `scriptPath: "scripts/devops-deploy.sh"` via `POST /api/apps`. Application detail view displays the field. Click Deploy → `script_runs` row has `script_id = "deploy/project-local-deploy"` + correct dispatch command captured on the mocked `execStream`. Click Rollback on same app → `RollbackConfirmDialog` opens.

### Backend — routes + integration tests (with strict typing)

- [ ] T016 [BE] [US1] Extend `devops-app/server/routes/apps.ts` `POST /api/apps` handler with Zod validation and structured error handling: extend the request schema's `scriptPath` field to `z.union([z.string(), z.null()]).optional()` (STRICT — rejects non-string non-null non-absent values with Zod's standard message, returns 400 `INVALID_PARAMS` with `fieldErrors.scriptPath: ["Expected string, received number"]` or equivalent). On successful parse, call `validateScriptPath(req.body.scriptPath)` (now typed as `string | null | undefined`); return 400 on `!ok` with `fieldErrors.scriptPath: [result.error]`; otherwise insert via Drizzle with `scriptPath: result.value` (parameterized). Audit middleware picks up the field (non-secret, FR-042).
- [ ] T017 [BE] [US1] Extend `devops-app/server/routes/apps.ts` `PATCH /api/apps/:id` handler identically to T016: strict `z.union([z.string(), z.null()]).optional()` schema; normalise via `validateScriptPath`; explicit `null` clears, `""` normalises to null, absent leaves untouched (standard PATCH).
- [ ] T018 [BE] [US1] Write integration test `devops-app/tests/integration/apps-script-path-normalisation.test.ts`: (a) POST with valid string → persists + returned; (b) POST with `""` → persists NULL; (c) POST with `"   "` → persists NULL; (d) POST with `"../evil"` → 400 with `"parent-directory traversal"` message; (e) POST with `"скрипты.sh"` → 400 with `"printable ASCII"` message (**NEW — GPT-P1-6**); (f) POST with `"a".repeat(257)` → 400 with `"≤256 characters"` message; (g) POST with `scriptPath: 123` → 400 with type-error message from Zod's `z.union` (**NEW — GPT-P0-3**); (h) POST with `scriptPath: false` → 400 (**NEW**); (i) POST with `scriptPath: {}` → 400 (**NEW**); (j) POST with `scriptPath: []` → 400 (**NEW**); (k) PATCH with `null` clears a set value; (l) PATCH omitting field leaves value untouched; (m) `audit_entries` captures post-normalisation value; (n) SQL assertion `SELECT COUNT(*) FROM applications WHERE script_path = ''` → 0 after all operations.
- [ ] T019 [BE] [US1] Write integration test `devops-app/tests/integration/scripts-runner-project-local.test.ts` end-to-end against mocked `sshPool` + `postgres`: seed app with `scriptPath = "scripts/devops-deploy.sh"`; invoke `POST /api/apps/:id/deploy`; assert (a) route handler selected the project-local branch (calls `dispatchProjectLocalDeploy`, NOT `scriptsRunner.runScript` directly); (b) wrapper inserted pending row; (c) `resolveDeployOperation` returned `deploy/project-local-deploy`; (d) `sshPool.execStream` called exactly once with `bash '<remotePath>'/'scripts/devops-deploy.sh' --app-dir=... --branch=...`; (e) the bundled-script path was NOT taken (spy on `buildTransportBuffer` NOT called); (f) on exit 0, `script_runs.status = 'success'`, `deployments` row dual-written per FR-031; (g) deploy lock acquired/released per FR-011.

### Frontend — form field + detail visibility + rollback dialog

- [ ] T020 [FE] [US1] Create `devops-app/client/components/apps/ScriptPathField.tsx`: props `value: string | null`, `onChange: (next: string | null) => void`, optional `label`, `placeholder`. Renders input with label "Project Deploy Script", placeholder `"scripts/devops-deploy.sh"`, helper text. On blur runs `validateScriptPath(value)` from `client/lib/validate-script-path.js` and surfaces inline error. `onChange(result.value)` only on valid state so parent sees normalised `null` for empty. Styled per existing Tailwind conventions. TypeScript-typed, no `as any`.
- [ ] T021 [FE] [US1] Modify `devops-app/client/components/apps/AddAppForm.tsx` to mount `<ScriptPathField>`. Wire `scriptPath` state (initial `null`); include in POST body.
- [ ] T022 [FE] [US1] Modify `devops-app/client/components/apps/EditAppForm.tsx` to mount `<ScriptPathField>`. Wire state (initial = current app's `scriptPath`); submit-null explicitly (not `undefined`) to clear.
- [ ] T023 [FE] [US1] Modify `devops-app/client/components/apps/ApplicationDetail.tsx` (or equivalent per FR-002 — grep `ApplicationDetail|AppDetail` in `client/components/` to confirm the exact file) to render a new metadata row: `"Deploy script: <value-or-placeholder>"`. When `scriptPath` is null, render muted text `"builtin (scripts/deploy/server-deploy.sh)"`. When non-null, render in monospace with a `<Badge variant="secondary">project-local</Badge>` prefix matching the Runs page convention (same helper function if T030's `renderScriptIdentity` is already extracted — otherwise inline for now). Resolves the GPT-P1-9 missing-UI-visibility gap.

### Rollback safety UI

- [ ] T024 [FE] [US1] Create `devops-app/client/components/deployments/RollbackConfirmDialog.tsx` per plan.md §Rollback UI: props `scriptPath: string`, `onConfirm: () => void`, `onCancel: () => void`. Uses existing dashboard Dialog primitive. Title, three-paragraph body (with `<code>{scriptPath}</code>`), Cancel + Rollback (`variant="destructive"`) actions. Focus-trap, Escape-to-dismiss per existing primitive a11y.
- [ ] T025 [FE] [US1] Wire `RollbackConfirmDialog` into the Rollback button host. Target file: resolve via `grep -l 'api.rollback\|onRollback' devops-app/client/components/` before starting — likely `components/scripts/RunDetail.tsx` or `components/apps/ApplicationDetail.tsx`. Guard: `const needsConfirm = Boolean(app?.scriptPath);`. When false, existing flow unchanged. When true, open dialog; cancel aborts; confirm proceeds to existing `api.rollback` call.
- [ ] T026 [FE] [US1] Write integration test `devops-app/tests/integration/rollback-confirm-dialog.test.ts` (**NEW — resolves GPT review coverage gap M2**): (a) app with `scriptPath = null` → clicking Rollback proceeds directly to `api.rollback` (no dialog rendered); (b) app with non-null `scriptPath` → clicking Rollback opens dialog, cancelling → `api.rollback` NOT called; confirming → `api.rollback` called once with the expected deployment/commit params; (c) dialog copy includes the actual `scriptPath` value in monospace; (d) keyboard: Escape dismisses dialog and aborts rollback.

**Checkpoint**: US-1 independently testable end-to-end. Operator opts in via Edit, sees the field in detail view, deploy dispatches through wrapper+runner, rollback warns.

---

## Phase 4: User Story 2 — Preserve backward compatibility (Priority: P1)

**Goal**: Null-scriptPath apps deploy unchanged; no existing test regresses; feature 003 scan does not populate the new field (US-2, FR-020, FR-021, FR-025, SC-002).

**Independent Test**: Pre-existing `tests/integration/deploy.test.ts` passes unchanged. Scan creates rows with `scriptPath = null`. Post-migration verification queries return expected values.

> **Note on T027**: the null-passthrough regression for FR-020 is already covered by T010(d)/(e)/(f) in Phase 2 — no dedicated integration task is needed. T027 is intentionally not assigned; the phase begins at T028 to preserve the phase→range mapping.

- [ ] T028 [BE] [US2] Write integration test `devops-app/tests/integration/migration-0006-verification.test.ts`: runs the 4 verification queries from data-model.md §Verification queries post-migration: (1) column exists + nullable + no default; (2) CHECK constraint exists with expected definition; (3) no rows violate invariant; (4) no backfill. Plus rejection smoke-test: `UPDATE ... = ''` / `'   '` / `'\t\n'` throw; `NULL` and valid paths succeed.
- [ ] T029 [BE] [US2] Write integration test `devops-app/tests/integration/scan-leaves-script-path-null.test.ts` per FR-025: fixture repo with every heuristic-tempting filename → scan creates rows → all `scriptPath = null`. Regression guard against future accidental auto-detection heuristics.

**Checkpoint**: US-2 verified. Scan boundary enforced by test.

---

## Phase 5: User Story 3 — Surface dispatched script in logs and history (Priority: P2)

**Goal**: Operators see which script was dispatched in RunDetail + RunsPage (US-3, FR-032, FR-033).

**Independent Test**: Trigger one project-local deploy + one builtin deploy; open each from Runs page → project-local shows badge + path, builtin shows scriptId verbatim.

- [ ] T030 [FE] [US3] Create pure helper `devops-app/client/lib/render-script-identity.tsx` per research.md §R-007, plan.md §Script-identity surface, and the GPT-P2-11 typed-guard fix: exported `function renderScriptIdentity(run: { scriptId: string; params?: unknown }): ReactNode`. Body: inline typed guard `function extractScriptPath(params: unknown): string | undefined { if (params && typeof params === "object" && "scriptPath" in params) { const sp = (params as Record<string, unknown>).scriptPath; return typeof sp === "string" ? sp : undefined; } return undefined; }` (or extracted to a private helper — one `as Record<string, unknown>` coercion is acceptable after the `in` check narrows; JSDoc the justification). If `run.scriptId === "deploy/project-local-deploy"`, return `<span className="font-mono"><Badge variant="secondary">project-local</Badge>{" "}{extractScriptPath(run.params) ?? "<unknown>"}</span>`. Otherwise `<span className="font-mono">{run.scriptId}</span>`. No unchecked `as any` — the narrower coercion after `typeof === "object"` + `"scriptPath" in params` is safe.
- [ ] T031 [FE] [US3] Modify `devops-app/client/components/scripts/RunDetail.tsx` header: replace `{run.scriptId}` with `{renderScriptIdentity(run)}`. Preserve existing metadata lines.
- [ ] T032 [FE] [US3] Modify `devops-app/client/pages/RunsPage.tsx` list rows: replace `{row.scriptId}` cell with `{renderScriptIdentity(row)}`. Same helper as T031.

**Checkpoint**: US-3 visible across RunDetail, RunsPage, AND ApplicationDetail (via T023's convention-matching inline usage).

---

## Phase 6: User Story 4 — Reject unsafe script paths (Priority: P2)

**Goal**: All three layers (form, API, runtime) reject unsafe paths; SC-007 fail-closed invariant holds; forensics trail persists on DB tampering.

**Independent Test**: Client form shows inline errors (T004+T020). API returns 400 (T018). Runtime creates failed `script_runs` row (T033).

- [ ] T033 [BE] [US4] Write integration test `devops-app/tests/integration/scripts-runner-project-local-runtime-validation.test.ts` per SC-007: seed an application with `scriptPath = "scripts/ok.sh"`; simulate DB tampering via direct Drizzle `UPDATE applications SET script_path = '../../etc/passwd'` (bypassing route validator); trigger `POST /api/apps/:id/deploy`. Assert (**all must hold — row existence is a hard requirement per FR-044 lifecycle**): (a) route handler called `dispatchProjectLocalDeploy` (the wrapper); (b) **a `script_runs` row EXISTS** with `scriptId = 'deploy/project-local-deploy'`, `status = 'failed'`, `errorMessage` matches `/scriptPath failed runtime validation.*parent-directory/`, `startedAt` populated, `finishedAt` populated, `deploymentId` linked; (c) `sshPool.execStream` was NOT called; (d) no fallback to `deploy/server-deploy` (spy on `resolveDeployOperation` + bundled-script runner path → none invoked); (e) the wrapper threw `ProjectLocalValidationError` which the route handler converted to 500 (or 400 — match whatever the deploy route does today for unexpected throws from the dispatch path); (f) the row is queryable in a subsequent `GET /api/runs/:id` with the full error detail — forensics trail accessible to the operator.

**Checkpoint**: US-4 verified. Three-layer + DB CHECK defence all end-to-end testable.

---

## Phase 7: User Story 5 — Mid-stream switch without downtime (Priority: P3)

**Goal**: Operator toggles `scriptPath` on live app without intervention (US-5, SC-004).

**Independent Test**: One test walks create → deploy (builtin) → PATCH set → deploy (project-local) → PATCH clear → deploy (builtin).

- [ ] T034 [BE] [US5] Write integration test `devops-app/tests/integration/script-path-mid-stream-switch.test.ts`: (a) create app with `scriptPath: null`, deploy → `script_runs.scriptId = "deploy/server-deploy"`; (b) PATCH set `scriptPath: "scripts/devops-deploy.sh"`, deploy → `script_runs.scriptId = "deploy/project-local-deploy"`; (c) PATCH `scriptPath: null`, deploy → `"deploy/server-deploy"` again (reversibility). No dashboard restart, no cache flush. Validates FR-015 determinism — dispatch is a function of the row state at dispatch time.

**Checkpoint**: US-5 verified. SC-004 operator-velocity claim structurally guaranteed.

---

## Phase 8: Polish & Cross-Cutting Concerns

- [ ] T035 [SEC] Security audit on the three-layer defence + wrapper lifecycle. Verify: (1) `validateScriptPath` is the single source of truth — grep for `scriptPath` across `devops-app/server/` and assert every read/write either calls `validateScriptPath` directly or goes through a layer that did; (2) Zod refine in manifest imports the same validator; (3) DB CHECK present in deployed schema; (4) `shQuote` is the only argv-composition path; (5) no log/audit path leaks the failed-validation value enabling log-injection — specifically verify `errorMessage` contains only the RULE violated, not the raw tampered value; (6) rollback confirmation dialog cannot be bypassed via direct API call (accepted v1 limitation); (7) pre-insert wrapper's `script_runs.params` field contains the raw pre-parse input — verify this is not a secret leakage vector (scriptPath is non-secret per FR-014); (8) non-string input rejection at the route layer — test with `curl -X POST ... -d '{"scriptPath": 123}'` returns 400, not coerced. Produce `specs/007-project-local-deploy/security-review.md` with each check + pass/fail + findings.
- [ ] T036 [BE] Walk through `quickstart.md` manually against a staging deployment (or local integration fixture): commit a project-local script, set `scriptPath` via Edit, deploy, see `project-local` badge in Runs AND in ApplicationDetail, verify rollback dialog. If any step diverges from the quickstart, either fix code OR update `quickstart.md`. File result as a PR comment.

**Checkpoint**: Feature release-ready. Security review filed. Quickstart validated.

---

## Dependency Graph

```
# Phase 1: Setup
T001 → T002

# Phase 2: Foundational
T001 + T002 → T003
T003 → T004
T003 → T005
T004 + T005 → T006
T003 → T007
T007 → T008
T007 → T009
T009 → T010
T003 → T011
T011 → T012
T007 + T009 + T011 → T013
T013 → T014
T014 → T015

# Phase 3: US-1 (P1)
T014 → T016
T014 → T017
T016 + T017 → T018
T014 → T019
T005 → T020
T020 → T021
T020 → T022
T005 → T023
T005 → T024
T024 → T025
T025 → T026

# Phase 4: US-2 (P1) — regression
T002 → T028
T002 → T029

# Phase 5: US-3 (P2)
T014 → T030
T030 → T031
T030 → T032

# Phase 6: US-4 (P2)
T014 → T033

# Phase 7: US-5 (P3)
T016 + T017 + T019 → T034

# Phase 8: Polish
T018 + T019 + T025 + T026 + T028 + T029 + T031 + T032 + T033 + T034 → T035
T035 → T036
```

Notes:
- T027 was elided — FR-020 coverage lives in T010 (unit-test level), so no dedicated integration task. The numbering skips T027 intentionally to preserve the phase→range mapping — Phase 4 begins at T028.
- T030's `renderScriptIdentity` helper is also consumed by T023 (ApplicationDetail). T023 can either inline the same logic temporarily or depend on T030 being extracted first. Treated here as parallel because T023 is cheap to refactor once T030 lands.

### Graph self-validation

- ✅ Every task ID in Dependencies exists in the task list (T001..T036 minus T027)
- ✅ No circular dependencies
- ✅ No orphan IDs
- ✅ Fan-in uses `+` only
- ✅ No chained arrows on one line

---

## Parallel Lanes

| Lane | Agent | Tasks | Start Condition |
|------|-------|-------|-----------------|
| L1 — Schema + migration | [DB] | T001 → T002 | — |
| L2 — Server validator | [BE] | T003 → T004 | T002 |
| L3 — Client validator | [FE] | T005 | T003 |
| L4 — Parity test | [BE] | T006 | T004 + T005 |
| L5 — Manifest entry | [BE] | T007 → T008 | T003 |
| L6 — Dispatch branch | [BE] | T009 → T010 | T007 |
| L7 — Cmd builder | [BE] | T011 → T012 | T003 |
| L8 — Runner dispatch-kind branch | [BE] | T013 | T007 + T009 + T011 |
| L9 — Pre-insert wrapper | [BE] | T014 → T015 | T013 |
| L10 — Apps routes (US-1) | [BE] | T016, T017 (parallel) → T018 | T014 |
| L11 — Runner integration (US-1) | [BE] | T019 | T014 |
| L12 — Form field (US-1) | [FE] | T020 → T021, T022 (parallel after T020) | T005 |
| L13 — ApplicationDetail visibility (US-1) | [FE] | T023 | T005 |
| L14 — Rollback dialog (US-1) | [FE] | T024 → T025 → T026 | T005 |
| L15 — US-2 regression | [BE] | T028, T029 (parallel) | T002 |
| L16 — Script-identity helper (US-3) | [FE] | T030 → T031, T032 (parallel after T030) | T014 |
| L17 — Runtime validation test (US-4) | [BE] | T033 | T014 |
| L18 — Mid-stream switch test (US-5) | [BE] | T034 | T016 + T017 + T019 |
| L19 — Security review | [SEC] | T035 | L10 + L11 + L14 + L15 + L16 + L17 + L18 + L13 |
| L20 — Quickstart walkthrough | [BE] | T036 | T035 |

---

## Agent Summary

| Agent | Tasks | Count | Start Condition |
|-------|-------|-------|-----------------|
| `[SETUP]` | — | 0 | — |
| `[DB]` | T001, T002 | 2 | start |
| `[BE]` | T003, T004, T006, T007, T008, T009, T010, T011, T012, T013, T014, T015, T016, T017, T018, T019, T028, T029, T033, T034, T036 | 21 | per graph |
| `[FE]` | T005, T020, T021, T022, T023, T024, T025, T026, T030, T031, T032 | 11 | per graph |
| `[SEC]` | T035 | 1 | after all impl + test tasks |
| `[OPS]` | — | 0 | — |
| `[E2E]` | — | 0 | — |

Total: **35 tasks** (T027 intentionally skipped per Dependency Graph notes — the number is reserved but unused).

---

## Critical Path

```
T001 → T002 → T003 → T007 → T013 → T014 → T019 → T034 → T035 → T036
```

10 tasks on the critical path. The pre-insert wrapper (T014) adds one node to the chain compared to v1.0; this is the cost of SC-007 compliance and it's non-negotiable after the GPT review finding.

---

## Implementation Strategy

### MVP scope

**Phases 1 + 2 + 3** (T001..T026, 23 tasks) ship:
- Schema + migration
- Three-layer validator (strict typing + ASCII + backslash)
- Manifest entry + dispatcher + cmd builder + runner dispatch-kind branch
- Pre-insert wrapper (FR-044 forensics trail)
- API routes with strict type validation
- Form field + detail-view visibility + rollback dialog + its integration test

After MVP, Phases 4–7 (T028..T034) add the US-2 regression tests, US-3 visibility polish, US-4 runtime test, US-5 switch test. Phase 8 (T035..T036) is security review + quickstart verification — final gate before ship.

### Incremental delivery cut points

- **After T015**: API-level feature works; wrapper + runner dispatch end-to-end via mocked drivers; no UI yet.
- **After T019**: US-1 backend covered; UI still pending.
- **After T026**: US-1 fully shippable — forms, detail view, rollback dialog + its test.
- **After T033**: SC-007 forensics trail proven.
- **After T036**: release-ready.

### Parallel agent strategy

- **Post-T003**: L3 (client validator), L5 (manifest), L7 (cmd builder) fork immediately.
- **Post-T013**: runner dispatch-kind branch merged; lanes L9 (wrapper), L10 (routes), L11 (integration), L16 (identity helper), L17 (runtime test) all viable.
- **Post-T014**: wrapper is the convergence point for US-1/US-3/US-4/US-5 testing. The wrapper is the single most important task in Phase 2; everything else depends on it.
- **FE lanes** (L12, L13, L14, L16) start as soon as their BE dependency is done (T005 for form/detail/dialog, T014 for identity helper). L13 (ApplicationDetail) explicitly depends on T005 (client validator) — the component imports it for the render helper.
- **[SEC] (L19)** is the final gate. Runs after every implementation lane.

### Test-first discipline (TDD-Lite per CLAUDE.md §7)

- Validator tests (T004) land with T003 — SC-006 + GPT edge-case fixtures established first.
- Parity test (T006) lands with T005 — catches drift at commit time.
- Manifest entry test (T008) lands with T007 — three-layer refine contract proven.
- Dispatch tests (T010) lands with T009 — all 6 resolve cases covered.
- Cmd builder test (T012) lands with T011.
- Wrapper test (T015) lands with T014 — SC-007 proof before any downstream integration.
- Route-layer normalisation test (T018) lands with T016/T017 — strict-typing rejection covered.
- Runner integration test (T019) can lag T014 by one PR but should not ship without it.

### Coding-standards alignment

- **Route handlers** (T016, T017): "with Zod `z.union([z.string(), z.null()]).optional()` schema + structured error handling" — strict typing upfront ✅
- **Services** (T003, T009, T011, T013, T014): "with typed inputs/outputs", strict signatures ✅
- **DB touches** (T001, T002, T018, T028, T033): via Drizzle ORM (parameterized queries) + reviewable static .sql migration ✅
- **No `as any`** — the one controlled `as Record<string, unknown>` coercion in T030 is after an `in` narrowing, typed-guard-equivalent ✅
- **No `console.log`** — structured pino `logger` calls everywhere ✅
- **No `dangerouslySetInnerHTML`** — `{variable}` rendering throughout; React auto-escapes ✅
- **No string-interpolated SQL** — Drizzle ORM + one static .sql file ✅
- **Tests via TDD-Lite** — every helper/service task has a co-committed test task ✅

### Summary of changes vs v1.0

| Area | v1.0 | v1.1 |
|------|------|------|
| Validator input type | `unknown` + coerce | `string \| null \| undefined`, no coerce (GPT-P0-3) |
| Length policy | "≤ 256 bytes" (implicit `.length`) | ≤ 256 characters + ASCII-only (GPT-P1-6) |
| Backslash `\` | not addressed | explicitly rejected (GPT-P1-5) |
| `./` prefix | not addressed | explicitly allowed, pass through (GPT-P1-5) |
| Runtime validation failure | assumed `script_runs` row exists | pre-insert wrapper guarantees it (GPT-P0-2, new T014/T015) |
| ApplicationDetail visibility | missing | T023 (GPT-P1-9) |
| Rollback integration test | missing | T026 (GPT review coverage gap) |
| `as any` in identity helper | used (JSDoc'd) | typed guard with narrower coercion (GPT-P2-11) |
| Task count | 32 | 35 (T027 skipped for phase-range preservation) |
| Critical path length | 9 | 10 (adds T014 wrapper node) |
