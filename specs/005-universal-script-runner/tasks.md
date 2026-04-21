# Tasks: Universal Script Runner

**Input**: Design documents from `/specs/005-universal-script-runner/`
**Prerequisites**: plan.md (v1.0), spec.md (v1.0), research.md, data-model.md, contracts/api.md, quickstart.md

**Tests**: Yes — unit tests for every extracted helper + integration tests per user story. TDD-Lite: tests land either before or alongside the implementation they cover.

**Organization**: 5 user stories (US-001…US-005). US-005 is a meta-story — satisfied structurally by the manifest architecture rather than by a dedicated code path, so it has no direct tasks. US-001/US-002/US-003 are P1 (core promise of the feature); US-004 is P2 (refactor of existing functionality).

## Format: `[ID] [AGENT] [Story?] Description`

## Agent Tags

| Tag | Agent | Domain |
|-----|-------|--------|
| `[SETUP]` | — (orchestrator) | Shared file edits / build-system moves |
| `[DB]` | database-architect | Drizzle schema + migration |
| `[BE]` | backend-specialist | Service, runner, routes, middleware, tests |
| `[FE]` | frontend-specialist | React components, pages, sidebar |
| `[OPS]` | devops-engineer | Docker image composition + regression |
| `[SEC]` | security-auditor | Code audit of the new runner |

No dedicated `[E2E]` phase — integration tests live inside each user story's [BE] block against mocked `ssh-pool` + `postgres` drivers (no cross-boundary suite).

## Task Statuses

| Status | Meaning |
|--------|---------|
| `- [ ]` | Pending |
| `- [→]` | In progress |
| `- [X]` | Completed |
| `- [!]` | Failed |
| `- [~]` | Blocked |

## Path Conventions

All paths relative to repo root (`undev/`). Server code lives under `devops-app/server/`, client under `devops-app/client/`, tests under `devops-app/tests/`, bundled bash scripts under `scripts/`.

---

## Phase 1: Setup

**Purpose**: Move Docker build context so `scripts/` can be bundled into the image, extract the shared `shQuote` helper, rename the existing SSH executor, and land the Drizzle schema change + migration. Shared-file edits happen here before any BE fork.

- [X] T001 [SETUP] Move `devops-app/Dockerfile` → repo-root `Dockerfile`; create repo-root `.dockerignore` (excludes `node_modules/`, `dist/`, `.git/`, `specs/`, `.claude/`, `.github/`, `.gemini/`, `.remember/`, `tmp/`, `data/`, `devops-app/tests/`, `**/*.log`, root `*.md`); rewrite `Dockerfile` `COPY` paths (`devops-app/package*.json`, `devops-app/` for build stage, `scripts/ → /app/scripts/` in the production stage); update `devops-app/docker-compose.yml` with `build: { context: .., dockerfile: devops-app/Dockerfile }`. Verify local `docker-compose build` succeeds and `/app/scripts/common.sh` exists inside the image (`docker run --rm devops-app_dashboard ls /app/scripts`).
- [X] T002 [SETUP] Extract `shQuote` from `devops-app/server/services/deploy-command.ts` into new module `devops-app/server/lib/sh-quote.ts` (single exported function, JSDoc, no `as any`); replace the inline helper in `deploy-command.ts` with `import { shQuote } from "../lib/sh-quote.js"`; replace the private `escape` helper at `devops-app/server/services/script-runner.ts:33` with the same import. Behaviour identical (pure extraction).
- [X] T003 [SETUP] Rename `devops-app/server/services/script-runner.ts` → `devops-app/server/services/ssh-executor.ts`; rename the exported class `ScriptRunner` → `SshExecutor` and the instance `scriptRunner` → `sshExecutor`; update the sole import site at `devops-app/server/routes/deployments.ts` (both the `import` line and the `scriptRunner.runScript(...)` call sites around lines 139–147 and 283). Behaviour identical (rename only).
- [X] T004 [DB] Extend `devops-app/server/db/schema.ts`: (a) remove the `deployScript: text("deploy_script").notNull(),` field from the `applications` table (~line 42), (b) add `scriptRuns` table per data-model.md §Drizzle with three indexes (`idx_script_runs_server_started`, `idx_script_runs_script_started`, `idx_script_runs_started`). Use Drizzle's typed column helpers — no raw SQL strings in schema.ts.
- [X] T005 [DB] Create migration `devops-app/server/db/migrations/0005_scripts_runner.sql` with the two-statement DDL per data-model.md (DROP COLUMN applications.deploy_script; CREATE TABLE script_runs + three CREATE INDEX). Append journal entry `{ idx: 5, tag: "0005_scripts_runner", when: <epoch-ms>, breakpoints: true }` to `devops-app/server/db/migrations/meta/_journal.json`. Admin applies on release (per CLAUDE.md rule 5 — not triggered by this task).

**Checkpoint**: Docker bundles `scripts/`, shared helpers extracted, schema ready, migration reviewable.

---

## Phase 2: Foundational (Service Primitives + Manifest + Integration Hooks)

**Purpose**: Build the reusable primitives (manifest, concat helper, descriptor extractor, param serialiser, secret masker, logger/audit extensions), assemble the `scripts-runner.ts` service on top of the renamed `ssh-executor`, and wire startup validation + retention prune. Everything in Phase 3+ blocks on this.

- [X] T006 [BE] Create `devops-app/server/scripts-manifest.ts` with typed inputs/outputs: exported `ScriptManifestEntry` interface per data-model.md, plus the initial 10-entry `manifest` array (`deploy/deploy`, `deploy/rollback`, `deploy/deploy-docker`, `deploy/env-setup`, `deploy/logs`, `db/backup`, `db/restore`, `docker/cleanup`, `monitoring/security-audit`, `server-ops/health-check`). Each entry declares a Zod `params` schema per the shapes sketched in data-model.md. `db/restore` has `dangerLevel: "high"`; deploy entries have `requiresLock: true`. Include a code-comment block at the top of the file documenting the category→folder mapping used by startup validation (`deploy → scripts/deploy/`, `db → scripts/db/`, `docker → scripts/docker/`, `monitoring → scripts/monitoring/`, `server-ops → scripts/server/`) — the only non-identity mapping is `server-ops → server`, retained for UX (the UI category name "Server-Ops" reads better than "Server"). Export the mapping as a const `CATEGORY_FOLDER_MAP` so T022 (manifest validation test) and T012 (runner file resolution) can import it instead of hard-coding. No `as any`, no `console.log`.
- [X] T007 [BE] Create `devops-app/server/lib/common-sh-concat.ts` with typed inputs/outputs: `buildTransportBuffer({ commonSh, targetSh, envExports }): string` per research.md §R-003. Builds the three-part buffer: (1) preamble with `export YES=true`, `export CI=true`, one `export SECRET_<NAME>=<shQuoted>` per entry of `envExports`, plus the `source` and `.` shell-function overrides that no-op for any argument matching `*/common.sh`; (2) `commonSh` contents with shebang stripped; (3) `targetSh` contents with shebang stripped, **source line preserved unchanged**. No regex over bash source code anywhere.
- [X] T008 [BE] Create `devops-app/server/lib/zod-descriptor.ts` with typed inputs/outputs: `extractFieldDescriptors(schema: z.ZodObject<z.ZodRawShape>): FieldDescriptor[]` walking `.shape` and returning the descriptor array per research.md §R-005 (`string | number | boolean | enum` types, `isSecret` derived from `_def.description === "secret"`, `required`/`default` from `ZodOptional`/`ZodDefault` wrappers). Wrap the `_def` access in an `isSecretField(field): boolean` helper per research.md §R-011.
- [X] T009 [BE] Create `devops-app/server/lib/serialise-params.ts` with typed inputs/outputs: `serialiseParams(schema, values): { args: string[]; envExports: Record<string, string> }` per research.md §R-004. Uses `shQuote` from `lib/sh-quote.ts`, routes secret-marked fields into `envExports` keyed by `SECRET_<UPPER_SNAKE_NAME>` (consumed by T007's preamble builder — these values go into the **stdin buffer** as `export` lines, NOT into the SSH argv), serialises booleans as flag presence, arrays as repeated `--flag=val`, skips `null`/`undefined`. Field name `envExports` (not `env`) makes the destination explicit: these are script-body exports, not child-process spawn env.
- [X] T010 [BE] Create `devops-app/server/lib/mask-secrets.ts` with typed inputs/outputs: `maskSecrets(schema, values): Record<string, unknown>` that replaces secret-marked keys with `"***"`. Applied before `script_runs.params` DB insert AND before `auditMiddleware` body capture.
- [X] T011 [BE] Extend `devops-app/server/services/ssh-executor.ts` with typed inputs/outputs per FR-017: new method `executeWithStdin(serverId, command, stdinBuffer, jobId, { signal?: AbortSignal })` that calls `sshPool.execStream(serverId, command)`, immediately writes the buffer to the returned channel (`stream.write(stdinBuffer); stream.end()`), wires an `abort` listener on the `AbortSignal` that calls the `kill()` returned from `execStream`, then reuses the existing stdout/stderr/close handlers. Existing `runScript` kept intact for progressive migration. Separately update `devops-app/server/services/ssh-pool.ts`: add `keepaliveInterval: 30_000, keepaliveCountMax: 3` to the ssh2 `ConnectConfig` in the `connectClient` method so silently dropped TCP connections are detected application-layer within 90 seconds (typical failure mode is cloud-provider NAT idle-eviction without TCP FIN).
- [X] T012 [BE] Create `devops-app/server/services/scripts-runner.ts` — the domain runner — with typed inputs/outputs per contracts/api.md §Internal Service API: `validateManifestStrict()` (CI helper, throws on any failure), `validateManifestLenient()` (runtime helper, throws only on duplicate `id`; annotates entries with `valid: false, validationError` for other failures), `getManifestDescriptor()` (returns annotated cache including `valid`/`validationError`), `runScript(scriptId, serverId, params, userId, options?)` (returns `400 INVALID_MANIFEST_ENTRY` if target entry has `valid: false`), `pruneOldRuns()`. Internal flow per plan.md §Key Implementation Notes: parse → (optional) acquire deploy lock → mask secrets → insert `script_runs` row via Drizzle ORM (parameterized queries via drizzle — no raw SQL) → serialise params via T009 (`args` + `envExports`) → build transport buffer via T007 with `{ commonSh, targetSh, envExports }` (secrets go into the stdin buffer as `export` lines per FR-016) → call `sshExecutor.executeWithStdin(serverId, "bash -s -- " + args.join(" "), buffer, jobId)` (SSH command is invariant; secrets NEVER pass as argv or as `env VAR=` prefix) → wire `jobManager.onJobEvent` for terminal-status DB update + lock release. Custom error classes `ScriptNotFoundError`, `DeploymentLockedError` (re-exports feature-004 error). No `as any`, no `console.log` — use `logger` with structured `{ ctx: "scripts-runner", scriptId, serverId, userId, runId, status }`.
- [X] T013 [BE] Create `devops-app/server/services/deploy-dispatch.ts` with typed inputs/outputs: exported pure function `resolveDeployOperation(app, runParams): { scriptId, params }` per research.md §R-007. Dispatches on `source`, `repoUrl.startsWith("docker://")`, `skipInitialClone`. Three output shapes: `deploy/deploy` (classic or scan-git), `deploy/deploy-docker` (scan-docker). Zero side effects.
- [X] T014 [BE] Extend `devops-app/server/lib/logger.ts`: add `"*.params.*"`, `"*.body.params.*"` and `SECRET_*` env-var equivalents to the pino `redact.paths` array. Keep the `remove: true` semantics so redacted fields are dropped entirely from log payloads.
- [X] T015 [BE] Extend `devops-app/server/middleware/audit.ts` to apply `maskSecrets` to the captured request body when the request targets `/api/scripts/:id/run`. Manifest-lookup by `scriptId` to resolve which fields are secret; pass the masked body to the existing `audit_entries.details` write (Drizzle ORM, parameterized).
- [X] T016 [BE] Wire startup hooks in `devops-app/server/index.ts`: after the existing feature-004 deploy-lock pool-check + reconcile, call `scriptsRunner.validateManifestLenient()` per R-009 (populates the annotated cache; only throws on duplicate `id`; duplicate-id case IS fatal → `logger.fatal(...)` + `process.exit(1)`; other per-entry validation errors are logged at `warn` level but startup continues), then `await scriptsRunner.pruneOldRuns().catch((err) => logger.warn({ ctx: "scripts-runner-prune", err }, "Retention prune skipped"))`. Retention controlled by env `SCRIPT_RUNS_RETENTION_DAYS` (default 90) read inside `pruneOldRuns`.

**Checkpoint**: Service primitives in place, runner constructible, startup hooks wired. Phase 3+ lanes can fork from here.

---

## Phase 3: User Story 2 — Run an Ad-Hoc Operation Against a Server (Priority: P1)

**Goal**: The core runner path — a `POST /api/scripts/*/run` call validates params, transports the script via SSH stdin, records a `script_runs` row, streams logs over WS, and returns a terminal status (US-002, SC-001, SC-006).

**Independent Test**: Against mocked `sshPool` + mocked `postgres` client, invoke `scriptsRunner.runScript("db/backup", "srv-A", { databaseName: "mydb", retentionDays: 30 }, "admin")`. Assert: `script_runs` row inserted with `status=pending` then `status=running` then `status=success`; `sshPool.execStream` received the concatenated `common.sh + db/backup.sh` buffer with `--database-name='mydb' --retention-days='30'` argv; `secrets` absent; log events emitted to `jobManager`.

- [X] T017 [BE] [US2] Write unit test in `devops-app/tests/unit/sh-quote.test.ts` (TDD-Lite): covers single quote escape (`O'Hara` → `'O'\''Hara'`), empty string → `''`, string with newlines, shell metachars (`;`, `` ` ``, `$`, `|`, `&&`, redirections), very long strings (≥ 8 KB). Pure function, no mocks.
- [X] T018 [BE] [US2] Write unit test in `devops-app/tests/unit/common-sh-concat.test.ts`: (a) preamble contains the `source` and `.` function overrides that no-op for `*/common.sh`; (b) a mock target script whose first line is each of the 5 source variants (canonical, `.` shorthand, relative, variable-interpolated, `${BASH_SOURCE%/*}` form) produces a buffer that — when executed in a sandboxed bash subprocess — does NOT error on the `common.sh` lookup AND does execute the target's subsequent code; (c) shebangs in both inputs are stripped; (d) per-secret `export SECRET_FOO='<value>'` lines are emitted in the preamble when `envExports` is non-empty; (e) a script that legitimately sources something else (e.g. `source utils.sh`) delegates correctly via `builtin source`. Uses `child_process.spawnSync("bash", ["-c", buffer])` for the execution assertions; no network, no SSH.
- [X] T019 [BE] [US2] Write unit test in `devops-app/tests/unit/zod-descriptor.test.ts`: maps `z.string()` → `{ type: "string", required: true }`, `z.string().optional()` → `{ required: false }`, `z.string().default("x")` → `{ default: "x" }`, `z.number()` → `{ type: "number" }`, `z.boolean()` → `{ type: "boolean" }`, `z.enum(["a","b"])` → `{ type: "enum", enumValues: ["a","b"] }`, `z.string().describe("secret")` → `{ isSecret: true }`.
- [X] T020 [BE] [US2] Write unit test in `devops-app/tests/unit/serialise-params.test.ts`: strings single-quoted via shQuote; numbers stringified + quoted; true boolean → flag present; false boolean → omitted; array → repeated `--flag=val`; null/undefined skipped; secret-marked field → ONLY in `env` result, ABSENT from `args`; env var name kebab→UPPER_SNAKE (`s3SecretAccessKey` → `SECRET_S3_SECRET_ACCESS_KEY`).
- [X] T021 [BE] [US2] Write unit test in `devops-app/tests/unit/mask-secrets.test.ts`: secret-marked field → `"***"`; non-secret passthrough; nested object values untouched (v1 flat schemas); empty schema no-op.
- [X] T022 [BE] [US2] Write unit test in `devops-app/tests/unit/scripts-manifest.test.ts` covering BOTH strict and lenient modes per research.md §R-009: (a) `validateManifestStrict()` (CI-gate helper) — happy path all pass; any per-entry failure (missing file, Zod throw, non-ZodObject params) throws with descriptive error naming the entry; duplicate `id` throws. (b) `validateManifestLenient()` (runtime helper) — happy path all entries get `{ valid: true, validationError: null }`; per-entry failures get `{ valid: false, validationError: "<msg>" }` and the rest stay valid; duplicate `id` is the ONE exception that still throws (ambiguous dispatch). (c) `getManifestDescriptor()` output for an invalid entry includes the `valid: false` flag and `validationError` string so the UI can render it disabled. This unit test is the CI gate — failing it blocks PR merge and prevents a broken manifest from ever reaching runtime.
- [X] T023 [BE] [US2] Write integration test `devops-app/tests/integration/scripts-runner.test.ts` (TDD-Lite — lands with T012): mock `sshPool.execStream` capturing the transported stdin buffer and command; mock `postgres` client per the pattern from feature-004's tests. Assert the happy path end-to-end: Zod validation pass → `script_runs` insert (`status=pending`) → secret masking applied → SSH exec with concatenated buffer + correct argv → jobManager events streamed → on exit 0, `script_runs` update (`status=success`, `exit_code=0`, `finished_at`, `duration`). Assert transported buffer contains `common.sh` contents AND stripped target script AND breadcrumb comment.
- [X] T024 [BE] [US2] Extend `devops-app/tests/integration/scripts-runner.test.ts` with secret-parameter regression: manifest entry has `z.object({ adminKey: z.string().describe("secret"), targetDb: z.string() })`; invoke with plaintext secret; assert (a) `script_runs.params.adminKey === "***"` in the DB insert, (b) **the SSH command passed to `sshPool.execStream` is exactly `bash -s` with no per-invocation env-var prefix** — the secret is NOT in the command string, (c) the **stdin buffer written to the SSH channel** contains an `export SECRET_ADMIN_KEY='<real>'` line inside the preamble (matched via regex against the captured `stream.write` argument), (d) `--admin-key=...` ABSENT from argv within the stdin buffer too, (e) pino log calls made during the run DO NOT contain the real value (spy on `logger.info`), (f) `auditMiddleware` body-capture receives the masked version, (g) regression guard: assert no env-var form like `env SECRET_ADMIN_KEY=` appears in the SSH command string — if it ever does, a future refactor moved secrets back into argv and this test fails loud.
- [X] T025 [BE] [US2] Extend `devops-app/tests/integration/scripts-runner.test.ts` with `requiresLock: true` scenario: `db/restore` manifest entry (which has `requiresLock`) — first invocation acquires the lock via `deployLock.acquireLock` mock, second concurrent invocation sees `false` and throws `DeploymentLockedError`, which the route layer (T029) will surface as 409. Assert lock is released on successful terminal status AND on failed terminal status AND on timeout path.
- [X] T026 [BE] [US2] Extend `devops-app/tests/integration/scripts-runner.test.ts` with TWO timeout scenarios per FR-014 + FR-017: (a) **manifest timeout**: manifest entry `timeout: 100`; `sshPool.execStream` returns a stream that never emits `close`; after 100 ms, runner MUST call the `AbortController.abort()`, which triggers `kill()` on the stream, AND mark `script_runs.status = 'timeout'` AND set `error_message = "Script timed out after 100ms"` AND release the lock if one was acquired. (b) **zombie-stream guard**: `sshPool.execStream` returns a stream where neither `close` nor `error` ever fire (simulates a dropped TCP connection without FIN); assert the runner aborts via the AbortController before `manifest.timeout ?? 30min` — this is the FR-017 property that layered keepalive + AbortSignal catch a zombie stream regardless of which layer fires first. Use `vi.useFakeTimers()` to advance time; assert the sequence: keepalive-missed (mocked by the test) fires `close` first, OR AbortSignal fires first — either way, the run terminates cleanly with `status = 'timeout'` and no hung lock.
- [X] T027 [BE] [US2] Create `devops-app/server/routes/scripts.ts` with Zod validation and structured error handling: `GET /api/scripts/manifest` (returns descriptor array via `scriptsRunner.getManifestDescriptor()`, filtered to `locus === "target"`); `POST /api/scripts/*/run` using an Express 5 wildcard pattern (`router.post("/scripts/:id(.+)/run", ...)` or equivalent splat route) so that script ids containing `/` (e.g. `db/backup`) match natively without URL-encoding — Express splits named params on `/` by default, which would break any `:id` approach on slashed ids. Validates request body `{ serverId: z.string(), params: z.unknown() }`, delegates to `scriptsRunner.runScript`, maps `ScriptNotFoundError → 404`, `ZodError → 400 INVALID_PARAMS with fieldErrors`, `DeploymentLockedError → 409 DEPLOYMENT_LOCKED with details.lockedBy`, generic SSH errors → `503 SSH_ERROR`. Per contracts/api.md.
- [X] T028 [BE] [US2] Wire `scriptsRouter` from `routes/scripts.ts` into `devops-app/server/index.ts` under `/api` (after the existing `auditMiddleware` line, alongside existing `app.use("/api", ...)` routers).

**Checkpoint**: Runner fully exercised against mocked driver + ssh-pool. US-002 independently testable via `POST /api/scripts/*/run`.

---

## Phase 4: User Story 1 — Browse Available Operations for a Server (Priority: P1)

**Goal**: Admin can open a server's Scripts tab and see every runtime operation, grouped by category, each with a Run button (US-001, SC-001).

**Independent Test**: Navigate to `/servers/:id` in the UI, click **Scripts**, assert the tab renders 10 entries grouped into 5 categories, each with a visible description and a Run button. Click Run on any entry → the Run dialog opens with the right form fields derived from the manifest's Zod schema.

- [X] T029 [FE] [US1] Create `devops-app/client/components/scripts/ScriptsTab.tsx`: accepts `serverId` prop; uses React Query to fetch `GET /api/scripts/manifest` once; groups entries by `category`; renders a card per entry with `description` + Run button; empty/loading/error states. Styled with existing Tailwind conventions (match `HealthPanel` / `BackupsPanel` look).
- [X] T030 [FE] [US1] Create `devops-app/client/components/scripts/RunDialog.tsx`: accepts `entry` (manifest descriptor) + `serverId` props; auto-generates form inputs per FR-031 mapping (`string → text`, `string.isSecret → password`, `number → number`, `boolean → checkbox`, `enum → select`, pre-fill `default`); for `dangerLevel: "high"`, requires the admin to type the script id exactly before the Run button enables; on submit calls `POST /api/scripts/*/run`, surfaces `INVALID_PARAMS.fieldErrors` under matching fields or in a top-of-form banner on mismatch; on 201 navigates to the run detail view by `jobId`.
- [X] T031 [FE] [US1] Modify `devops-app/client/pages/ServerPage.tsx`: add `"Scripts"` to the `TABS` const at line 44 between `"Apps"` and `"Health"`; mount `<ScriptsTab serverId={serverId!} />` when `activeTab === "Scripts"`.

**Checkpoint**: US-001 end-to-end — browse → select → dialog → submit → log view.

---

## Phase 5: User Story 3 — Deploy Without Configuring a Script Path (Priority: P1)

**Goal**: Deploy route internally dispatches via manifest; `deploy_script` field gone from DB, forms, and API (US-003, SC-003, SC-004, SC-005).

**Independent Test**: Create a new application via `POST /api/servers/:id/apps` without `deployScript`; response is 201 (no `deploy_script` field required). Click Deploy on that application → deploy completes via the new runner path; `applications` table has no `deploy_script` column; `POST /api/apps/:id` including `deployScript` returns 400 `UNKNOWN_FIELD`.

- [X] T032 [DB] [US3] Create pre-migration audit + backup script `scripts/db/pre-migration-005-audit.sh` (per A-002 + A-005 / research.md §R-007). Two phases: (i) **audit**: `SELECT deploy_script, COUNT(*) FROM applications GROUP BY deploy_script` via `psql "$DATABASE_URL"`; classifies each unique value as "maps to deploy/deploy", "maps to deploy/deploy-docker", or "UNKNOWN"; prints a report; fails non-zero if any UNKNOWN. (ii) **backup**: `pg_dump --table=applications --column-inserts "$DATABASE_URL" > ops/backups/pre-005-applications-$(date +%Y%m%d-%H%M%S).sql`; prints the backup path; required by A-002 rollback procedure (reconstructing `deploy_script` values if rollback is needed post-release). Script exits 0 only when both audit is clean AND backup file written successfully. Admin runs this manually before releasing; CI can gate on the audit pass if the prod DB is reachable from CI.
- [X] T033 [BE] [US3] Write unit test `devops-app/tests/unit/resolve-deploy-operation.test.ts` (TDD-Lite — lands with T013): 4 cases — `(source=manual, repoUrl=git, skipInitialClone=false)` → `deploy/deploy`; `(source=manual, repoUrl=docker://..., skipInitialClone=true)` → `deploy/deploy-docker`; `(source=scan, skipInitialClone=true, repoUrl=git)` → `deploy/deploy` with `skipInitialClone: true` preserved in params; `(source=scan, skipInitialClone=true, repoUrl=docker://)` → `deploy/deploy-docker`. Assert returned `params` shape matches each dispatch's expected schema.
- [X] T034 [BE] [US3] Refactor `devops-app/server/routes/deployments.ts` `POST /api/apps/:appId/deploy` handler with Zod validation and structured error handling: replace the existing `buildDeployCommand` + `scriptRunner.runScript` block (~lines 126–148) with `const { scriptId, params } = resolveDeployOperation(app, { branch, commit }); const { runId, jobId } = await scriptsRunner.runScript(scriptId, server.id, params, userId, { linkDeploymentId: deploymentId })`. Response shape `{ deploymentId, jobId }` UNCHANGED — client contract preserved. 409 `DEPLOYMENT_LOCKED` shape unchanged.
- [X] T035 [BE] [US3] Remove `deployScript: z.string().min(1)` from the apps create schema at `devops-app/server/routes/apps.ts:17`; remove the `deployScript: body.deployScript` assignment at line 65. Add `.strict()` (or `.passthrough: false`-equivalent) to the Zod object so unknown fields return `400 UNKNOWN_FIELD`. Apply the same treatment to the PATCH handler if present. All DB writes via Drizzle ORM — no raw SQL.
- [X] T036 [BE] [US3] Create `scripts/deploy/deploy-docker.sh`: source `common.sh`, parse `--remote-path`, `--branch`, `--commit` flags, `cd "$REMOTE_PATH" && docker compose pull && docker compose up -d --remove-orphans`. Accepts optional flags, idempotent. `set -euo pipefail`.
- [X] T037 [BE] [US3] Audit & update `scripts/deploy/deploy.sh`: ensure it accepts `--skip-initial-clone` flag (matching the current `buildDeployCommand` scan-git branch behaviour). When present, skip the initial `git clone` and instead `git fetch --quiet origin "$BRANCH" && git reset --hard FETCH_HEAD`. Backward-compatible for classic-git callers (flag absent → original clone path unchanged).
- [X] T038 [FE] [US3] Remove the Deploy Script field + its suggestions from `devops-app/client/components/apps/AddAppForm.tsx` (~lines 187–205): delete the `deployScript` property from form state (`types.deployScript`, `deployScriptSuggestions`), remove the `<label>Deploy Script</label>` block, remove the `<datalist id="deploy-script-suggestions">`. Do NOT send `deployScript` in the `POST /api/servers/:id/apps` body.
- [X] T039 [FE] [US3] Clean up the scan-import flow in `devops-app/client/pages/ServerPage.tsx` (line 113 sets `deployScript: c.suggestedDeployScripts[0]`): remove the `deployScript` assignment and the entire `suggestedDeployScripts`-derived state path; the scan flow now imports applications without prompting for a script path.
- [X] T040 [BE] [US3] Write integration test `devops-app/tests/integration/deploy-dispatch.test.ts` (TDD-Lite — lands with T034): against the new runner path, assert four scenarios — (a) classic git app deploy succeeds with the same 201 response; (b) scan-docker app deploy succeeds and dispatches `deploy/deploy-docker`; (c) parallel deploys on different servers both succeed (US-003 + existing US-003 from feature 004 preserved); (d) same-server concurrent deploy returns 409 `DEPLOYMENT_LOCKED` with unchanged body shape. **Dual-write invariant (FR-041)**: after a successful deploy in scenario (a), assert exactly one row exists in `deployments` for the invocation AND exactly one row exists in `script_runs` whose `deployment_id` references it — no orphans on either side. Cover failure path too: a deploy that errors before script launch (SSH fail) produces a `deployments` row in `failed` state AND a linked `script_runs` row in `failed` state, not a dangling deployment with no run record.

**Checkpoint**: Deploy consolidation complete. Old `applications.deploy_script` field unused; removable at migration time (T005).

---

## Phase 6: User Story 4 — One-Click Rollback (Priority: P2)

**Goal**: Rollback dispatches via manifest, drops the `deploy.sh → rollback.sh` string-replace hack (US-004).

**Independent Test**: Click Rollback on a previous deployment row. Response is 201 with same shape as today. Server-side, `scriptsRunner.runScript("deploy/rollback", ...)` is invoked with `--commit=<target>`; the string-replace line at `deployments.ts:281` is gone.

- [X] T041 [BE] [US4] Refactor `devops-app/server/routes/deployments.ts` `POST /api/apps/:appId/rollback` handler: delete the `const rollbackScript = app.deployScript.replace("deploy.sh", "rollback.sh")` line (~281) and the subsequent `scriptRunner.runScript(...)` block. Replace with `const { runId, jobId } = await scriptsRunner.runScript("deploy/rollback", server.id, { remotePath: app.remotePath, commit: rollbackCommit }, userId, { linkDeploymentId: deploymentId })`. 201 response shape UNCHANGED.
- [X] T042 [BE] [US4] Write integration test `devops-app/tests/integration/rollback-dispatch.test.ts`: assert rollback via the new runner path — manifest lookup for `deploy/rollback` + SSH exec + `script_runs` row inserted linked to the `deployments` row via `deployment_id`; lock acquire/release mirrors deploy path (both are `requiresLock: true`).

**Checkpoint**: Rollback cleanup complete; US-004 verified.

---

## Phase 7: Runs History — Polish of US-002 Coverage (Priority: P1)

**Goal**: Admin can list, filter, and drill into any run across all servers — closing SC-006 ("when did we last restore the production DB, who did it, did it succeed?" in under 30 seconds).

**Independent Test**: Click **Runs** in the sidebar → list shows the last 50 runs with filters; click any row → detail view loads with params, status, log tail, artefact. For a row whose `scriptId` is not in the current manifest, assert "Archived" badge + disabled Re-run per FR-043.

- [X] T043 [BE] [US2] Create `devops-app/server/routes/runs.ts` with Zod validation and structured error handling: `GET /api/runs?limit=&offset=&status=&serverId=&scriptId=` (returns `{ runs: Array<...> }` per contracts/api.md §Runs; `limit` clamped to 1–200, default 50); `GET /api/runs/:id` (returns the full detail shape including `archived: boolean` — computed read-side by checking if `scriptId` is in `scriptsRunner.getManifestDescriptor().map(e => e.id)` — and `reRunnable: !archived`). All queries via Drizzle ORM (parameterized). Wire into `server/index.ts`.
- [X] T044 [BE] [US2] Write integration test `devops-app/tests/integration/runs-api.test.ts`: seeded `script_runs` rows; assert pagination (`limit`, `offset`), filtering (status, serverId, scriptId), ordering (most recent first); detail view includes the archived-flag computation (seed one row with a synthetic `script_id = "db/removed-op"` not in manifest, assert `archived: true, reRunnable: false`).
- [X] T045 [FE] [US2] Create `devops-app/client/pages/RunsPage.tsx` and modify `devops-app/client/components/layout/Sidebar.tsx`: sidebar gets a new **Runs** link between **Servers** and **Audit Trail**; page renders a sortable/filterable table (status, server, script id filters; time-descending sort). Each row links to `/runs/:id`. React Query for data fetching with pagination.
- [X] T046 [FE] [US2] Create `devops-app/client/components/scripts/RunDetail.tsx`: accepts `runId` or `jobId` prop (the former post-mortem, latter live); fetches run metadata from `GET /api/runs/:id`; reuses the existing log viewer component for the log tail; shows params (secrets rendered as `•••` per the masked `"***"` DB value — client just displays whatever came back), status badge, artefact block when `outputArtifact` present, error_message block when failed. **409 handling**: when the Re-run button triggers a new run that returns `409 DEPLOYMENT_LOCKED`, the UI MUST surface a user-friendly toast "Another operation is in progress on this server (`<lockedBy>`)" with a link to the currently-holding run, NOT a generic error alert. Same for the Rollback button on the `RunDialog` for deploy/rollback operations — both paths share the `requiresLock: true` semantics and both must decode the 409 body's `details.lockedBy` into a readable message. This is the client-side follow-up to T041 (server-side rollback via runner) — the server's 409 shape is unchanged, but the UI MUST explicitly handle it rather than falling through to a generic 5xx toast.
- [X] T047 [FE] [US2] Implement the archived-script UX per FR-043 inside `RunDetail.tsx` and `RunsPage.tsx`: when `archived === true`, show a muted "Archived" chip next to the script id; the Re-run button is hidden or disabled with tooltip `"Script no longer available in this dashboard version"`. Detail view remains fully functional (params, logs, artefact readable).

**Checkpoint**: Runs history UX complete; SC-006 testable.

---

## Phase 8: Polish & Cross-Cutting Concerns

**Purpose**: Retention prune correctness, Docker image verification, security audit, full regression.

- [X] T048 [BE] Implement `scriptsRunner.pruneOldRuns()` per data-model.md §Q7 + research.md §R-010: single DELETE returning `owned_log_path` (NULL when `deployment_id IS NOT NULL`); runner iterates the result, calls `fs.unlink` only on non-null paths, ignores ENOENT. Register a background timer `setInterval(process.env.SCRIPT_RUNS_PRUNE_INTERVAL_MS ?? 86_400_000, prune).unref()` in the runner's `start()` hook (called from T016); stop the timer in the SIGTERM handler inherited from feature-004 via a `stop()` method. Add unit test `devops-app/tests/unit/scripts-runner-prune.test.ts`: (a) seed N standalone runs (`deployment_id=null`) older than retention, M linked runs (`deployment_id='dep-1'`) also older, K newer runs; mock `fs.unlink`; assert `N+M` rows DELETE'd, **only N** `fs.unlink` calls made (linked logs untouched), K rows intact; (b) ENOENT from unlink does not throw; (c) background timer uses `.unref()` (assert via `timer.hasRef() === false`); (d) `SCRIPT_RUNS_PRUNE_INTERVAL_MS=0` disables the timer while preserving startup prune.
- [X] T049 [SEC] Security audit in `specs/005-universal-script-runner/security-review.md` covering: (a) all DB interaction in `scripts-runner.ts`, `routes/scripts.ts`, `routes/runs.ts` uses Drizzle ORM / parameterized queries — no raw SQL string interpolation; (b) `serialiseParams` defence via `shQuote` is the sole quoting path for non-secret params; no second escape layer ever re-interprets values; (c) secret-handling end-to-end (transport via env, DB `"***"`, pino redact, audit redact) matches FR-016; (d) manifest startup validation fail-loud behaviour; (e) archived-script UX is purely cosmetic — confirm the server-side `POST /api/scripts/*/run` does NOT refuse known-good ids that happen to be flagged archived (it shouldn't — archived is read-side only); (f) dangerLevel UI gate is UX-only — document that server trusts authenticated admin. Produce findings table in the shape of `specs/004-db-deploy-lock/security-review.md`.
- [X] T050 [OPS] Verify Docker image composition: run `docker-compose build` from `devops-app/` with the new context; `docker run --rm devops-app_dashboard ls /app/scripts/common.sh /app/scripts/deploy /app/scripts/db` all succeed; image size delta measured (target per SC-007: ≤ +200 KB compressed, ≤ +3 s build time vs. pre-005). Document measured delta in `specs/005-universal-script-runner/opsverify.md`.
- [X] T051 [OPS] Full regression: run `npx vitest run --root=.` from `devops-app/`; confirm 100% of pre-existing tests (features 001–004 coverage) still pass plus all new tests from this feature (T017–T026, T033, T040, T042, T044, T048). Run `npx tsc --noEmit` to confirm no new type errors. Document any pre-existing failures (known `ENOENT` on `deploy.test.ts` log-file writes from feature 001) as unchanged-by-this-feature.

**Checkpoint**: Feature ready for `/speckit.analyze`, then PR + merge.

---

## Dependency Graph

```
# Phase 1 — Setup
T001 → T050
T002 → T009, T013
T003 → T011
T004 → T005
T005 → T012, T043

# Phase 2 — Foundational
T006 → T012
T007 → T012
T008 → T012
T009 → T012
T010 → T012, T015
T011 → T012
T012 → T016, T017, T023, T027, T034, T041, T043, T049
T013 → T033, T034
T014 → T024
T015 → T024

# Phase 3 — US-002 tests + API
T012 + T017 + T018 + T019 + T020 + T021 + T022 → T023
T023 → T024, T025, T026
T012 + T024 + T025 + T026 → T027
T027 → T028
T016 → T028

# Phase 4 — US-001 FE
T027 → T029
T029 → T030, T031

# Phase 5 — US-003
T013 → T033
T012 + T013 → T034
T034 → T035, T040
T034 → T041
T035 + T038 → T039

# Phase 6 — US-004
T034 → T041
T041 → T042

# Phase 7 — Runs UI
T005 + T012 + T028 → T043
T043 → T044, T045, T046
T046 → T047

# Phase 8 — Polish
T012 → T048
T012 + T027 → T049
T001 → T050
T040 + T042 + T044 + T048 → T051
```

### Self-validation (must pass)

- [X] Every task ID referenced in Dependencies exists in the task list (T001–T051).
- [X] No circular dependencies — DAG topologically ordered from T001.
- [X] No orphan references (all IDs in the graph are defined tasks).
- [X] Fan-in uses `+` only (e.g. `T012 + T027 → T049`), fan-out uses `,` only (e.g. `T023 → T024, T025, T026`).
- [X] No chained arrows on a single line.

---

## Parallel Lanes

Each lane is a sequential chain assignable to one agent. Lanes run in parallel subject to the graph.

| Lane | Agent | Tasks | Starts after |
|---|---|---|---|
| L1 — Docker/Build | [SETUP]/[OPS] | T001 → T050 | — |
| L2 — Shared helpers | [SETUP] | T002, T003 (parallel within lane) | — |
| L3 — Schema & migration | [DB] | T004 → T005 | — |
| L4 — Manifest | [BE] | T006 | — |
| L5 — Concat/descriptor/serialiser/mask | [BE] | T007, T008, T009, T010 (parallel within lane) | T002 for T009 |
| L6 — SSH executor extension | [BE] | T011 | T003 |
| L7 — Runner core | [BE] | T012 | T005 + T006 + T007 + T008 + T009 + T010 + T011 |
| L8 — Deploy dispatch fn | [BE] | T013 | T002 |
| L9 — Logger/audit redact | [BE] | T014 | T010 |
| L10 — Startup wiring | [BE] | T016 | T012 |
| L11 — Audit middleware | [BE] | T015 | T010 |
| L12 — US2 unit tests | [BE] | T017, T018, T019, T020, T021, T022 (all parallel) | T012 |
| L13 — US2 integration | [BE] | T023 → T024, T025, T026 (parallel after T023) | L12 |
| L14 — Scripts route | [BE] | T027 → T028 | T012 + L13 |
| L15 — US1 FE | [FE] | T029 → T030, T031 (parallel after T029) | T027 |
| L16 — Deploy-dispatch tests | [BE] | T033 | T013 |
| L17 — Deploy route refactor | [BE] | T034 → T035, T040 | T012 + T013 |
| L18 — Deploy scripts | [BE] | T036, T037 (parallel) | — |
| L19 — US3 FE | [FE] | T038 → T039 | T035 |
| L20 — Rollback | [BE] | T041 → T042 | T034 |
| L21 — Runs API | [BE] | T043 → T044 | T005 + T012 |
| L22 — Runs FE | [FE] | T045, T046 (parallel) → T047 | T043 |
| L23 — Prune + test | [BE] | T048 | T012 |
| L24 — SEC | [SEC] | T049 | T012 + T027 |
| L25 — OPS regression | [OPS] | T051 | T040 + T042 + T044 + T048 |

---

## Agent Summary

| Agent | Tasks | Start condition |
|---|---|---|
| `[SETUP]` | T001, T002, T003 | — |
| `[DB]` | T004, T005, T032 | T004: —; T005: after T004; T032: — (can run any time, admin invokes pre-release) |
| `[BE]` | T006, T007, T008, T009, T010, T011, T012, T013, T014, T015, T016, T017, T018, T019, T020, T021, T022, T023, T024, T025, T026, T027, T028, T033, T034, T035, T036, T037, T040, T041, T042, T043, T044, T048 | Per graph |
| `[FE]` | T029, T030, T031, T038, T039, T045, T046, T047 | Per graph |
| `[OPS]` | T050, T051 | T050: after T001; T051: after T040+T042+T044+T048 |
| `[SEC]` | T049 | after T012 + T027 |

Total: **51 tasks**.

---

## Critical Path

The longest dependency chain (determines minimum shipping time):

```
T004 → T005 → T012 → T023 → T027 → T034 → T041 → T042 → T051
```

9 tasks on the critical path. Everything else (UI lanes, test lanes, SEC, OPS verify) parallelises around it.

---

## Implementation Strategy

### MVP scope

**Phases 1 + 2 + 3** ship the core runtime promise: the runner works via API, the deploy/rollback paths are unchanged for clients. That's T001 → T005 → T006 → T007 → T008 → T009 → T010 → T011 → T012 → T016 → T017–T023 (unit + happy-path integration) → T027 → T028. At this point `POST /api/scripts/*/run` is live, but no UI exposes it. Subsequent phases add visibility.

Ship order if under time pressure:

1. **Day-1 cut** (MVP): T001–T012 + T016 + T023 + T027–T028. API works; UI not wired.
2. **UX cut**: + Phase 4 (T029–T031). Scripts tab live.
3. **Deploy-consolidation cut**: + Phase 5 (T032–T040). `deploy_script` gone; SC-003 / SC-005 achieved.
4. **Rollback cut**: + Phase 6 (T041–T042). `deployments.ts:281` hack removed.
5. **History-visibility cut**: + Phase 7 (T043–T047). SC-006 achieved.
6. **Release-readiness cut**: + Phase 8 (T048–T051). Security audit + regression.

### Incremental delivery

- **After T028**: `POST /api/scripts/*/run` is live; CI could call it for scheduled ops even without UI.
- **After T031**: Scripts tab visible; admins can trigger any manifest entry on any server.
- **After T034**: Deploy flow runs through the new runner; SC-004 testable via the existing deploy suite (no regressions).
- **After T005 + T034 + T035**: Admin can apply migration 0005; production `applications.deploy_script` column dropped.
- **After T047**: Full runs history UX visible.

### Parallel agent strategy

- **Post-T005**: three lanes fork immediately — L4 (manifest), L5 (helpers), L6 (SSH executor extension). All converge on T012.
- **Post-T012**: six lanes in parallel — L12 (unit tests), L13 (integration tests), L14 (route), L17 (deploy refactor), L21 (runs API), L23 (prune), L24 (SEC). Any [BE] agent can pick them in any order.
- **[FE] lanes (L15, L19, L22)** start as soon as their [BE] dependency is done — they don't block each other.
- **[SEC] (L24)** only needs runner + route to be code-complete; runs parallel to FE lanes.
- **[OPS] final regression (L25)** is the last gate — must wait for all [BE] integration tests + prune to be green.

### Test-first discipline

Per TDD-Lite convention from CLAUDE.md:

- Helpers (T017–T022) have their tests in the same commit as the implementation (T002, T007, T008, T009, T010, T011).
- Runner integration tests (T023–T026) land in the same PR as T012 but may be committed before the route layer (T027).
- Deploy-dispatch unit test (T033) lands with T013.
- Deploy-dispatch integration test (T040) lands with T034.

No task blocks on "write tests first" being a separate multi-hour task — tests are co-committed with production code per house style.
