# Feature Specification: Project-Local Deploy Script Dispatch

**Version**: 1.0 | **Status**: Draft | **Date**: 2026-04-23

## Clarifications

### Session 2026-04-23 (initial)

- Q: Does the dashboard bundle the project-local script, or does it live on the target? → A: **On the target, inside the checked-out repo**. The project-local script is part of the project's own source tree (e.g. `<app-dir>/scripts/server-deploy-prod.sh`). The dashboard does NOT bundle it, does NOT read it over SSH and pipe it through `bash -s`. The dispatch invokes `bash <app-dir>/<script-path>` directly on the target. Rationale: the script exists to encode project-specific knowledge (ORM migration, cache warmup, asset sync) that the project owns and versions — forcing it into the dashboard's bundled scripts would re-create the exact coupling U-1 is designed to break.
- Q: What argument contract does the project-local script accept? → A: **Same CLI as `scripts/deploy/server-deploy.sh`**: `--app-dir=<path>`, `--branch=<name>`, optional `--commit=<sha>`, `--no-cache`, `--skip-cleanup`. The dashboard passes these regardless of whether the script uses them — the project may ignore any it does not need. This keeps the dispatch signature invariant and lets projects drop-in-replace the builtin deploy.
- Q: Does this feature cover rollback too? → A: **Deploy only, in v1**. Rollback continues to dispatch via the builtin `deploy/server-rollback` manifest entry. Per-app rollback script override is deferred — a project that needs deterministic rollback will ship one in a follow-up feature. The 2026-04-22 incident was a forward-migration gap, not a rollback gap.
- Q: What if the repo has not been cloned yet on the target (first-ever deploy)? → A: **Out of scope for v1**. The admin bootstraps the repo manually (SSH + `git clone`) OR runs the builtin deploy once before switching to project-local. Rationale: first-deploy bootstrap is a separate flow used rarely; adding it here bloats the scope.
- Q: Should an invalid `scriptPath` (non-existent file on target, bad permissions) be surfaced before the deploy starts? → A: **No pre-flight in v1 — rely on exit code**. If the file is missing, `bash <path>` exits with status 127 and stderr contains `No such file or directory`, which the runner already captures, persists, and surfaces in the log viewer. A pre-flight check (SSH + `test -f <path>` before starting the run) is U-4 scope and ships in a separate feature.

### Session 2026-04-24

- Q: How should the dashboard surface the rollback limitation for apps with `scriptPath` set, given that the builtin rollback cannot undo project-specific changes (migrations, cache flushes, asset syncs) applied by the project-local deploy? → A: **Confirmation dialog on Rollback click**. When an operator clicks Rollback on an app with non-null `scriptPath`, the UI shows a dialog explaining that the builtin rollback (`deploy/server-rollback`) performs only `git reset + compose restart` and may not undo project-specific side-effects. The dialog requires explicit click-through to proceed; cancelling aborts. Apps with null `scriptPath` see unchanged rollback UI. Rollback dispatch itself remains builtin — the dialog is the only behavioural change.
- Q: What `dangerLevel` should the new `deploy/project-local-deploy` manifest entry declare, given Feature 005 offers `low`/`medium`/`high` (high = typing-confirm)? → A: **`"low"` — parity with builtin deploy**. Risk surface is identical (bash over SSH as the same user). Path validation (FR-003) and `shQuote` (FR-013) close the injection vector; a typing-confirm dialog does not close any additional attack path. Velocity cost of `medium`/`high` is real (≈10s/deploy) and trains operators to click-past dialogs, degrading the signal of the one entry that genuinely needs `"high"` (`db/restore`). A malicious project-script requires repo-write access — a layer the dashboard does not own.
- Q: How should `scriptPath` normalise between empty string and NULL, given browsers submit `""` for cleared inputs but some API callers send `null` or omit the field entirely? → A: **Server-side normalisation to NULL**. The API layer MUST trim whitespace from every incoming `scriptPath` value and convert the result to NULL when it is empty (or the field is omitted). Only NULL is ever persisted to the `applications` row — empty string and all-whitespace values are never stored. This gives one canonical "no override" state, eliminates the `IS NULL OR = ''` double-check from every downstream query, and defends against clients that bypass the form validator (direct curl, integration tests, future automation).
- Q: Should the deploy runner re-validate `scriptPath` at dispatch time, or trust that the value in the `applications` row was already validated at write time? → A: **Re-validate at every dispatch — syntax only, no filesystem check**. The runner MUST run the read `scriptPath` through the same FR-003 rule set (relative, no `..`, no shell metachars, ≤ 256 bytes) BEFORE constructing the SSH command. On validation failure the deploy is rejected immediately with `status: failed` and a clear error message (e.g. `scriptPath failed runtime validation: contains '..'`) — the runner does NOT fall back to the builtin deploy, because silent fallback would mask a corrupt DB state. No SSH `test -f` existence check (still per the 2026-04-23 clarification — missing files surface via exit 127). This closes the "direct DB write bypassing the API validator" class (ORM bugs, manual SQL, pre-feature rows with stale data) without adding a TOCTOU window.
- Q: When the Feature 003 scan-for-repos flow creates an `applications` row, should it heuristically populate `scriptPath` based on well-known filenames it finds in the target repo (e.g. `scripts/devops-deploy.sh`, `scripts/server-deploy-prod.sh`)? → A: **No — scan leaves `scriptPath` as NULL. Every scan-created app defaults to builtin deploy dispatch; the operator explicitly opts in via Edit Application if they want project-local deploy**. Rationale: heuristic auto-detection creates a class of surprise behaviour ("why did this app start running a different script?"), costs an SSH `test -f` per candidate per repo during scan (measurable budget hit on a multi-app scan), and a false positive is operationally expensive (wrong script dispatched on first deploy). Opt-in via Edit is the explicit, auditable, low-risk path — and matches the general principle that scan creates baseline rows while operators own the specialisation. A richer scan UI that proposes candidate scripts for operator confirmation is a possible follow-up, but out of scope for v1.

### Session 2026-04-24 (GPT review pass)

- Q: Feature 005's runner flow is `parse → acquireLock → insert script_runs`. If Zod parse fails, no `script_runs` row is created and the HTTP route returns 400. SC-007 ("script_runs row with status=failed") and contracts/api.md's runtime-failure example therefore describe behaviour the inherited runner does NOT produce. Which side must move? → A: **Runner side, scoped to this feature**. The project-local dispatch path MUST wrap `scriptsRunner.runScript(...)` in a pre-insert guard: insert a `script_runs` row with `status: pending, scriptId: "deploy/project-local-deploy", params: <pre-parse-input>` BEFORE calling the runner; on ZodError from the runner's parse, UPDATE that row to `status: failed` with `error_message` identifying the rule violated; on success, let the runner's own lifecycle update the same row (`pending → running → terminal`). This keeps the forensics trail SC-007 promises AND does not touch feature 005's runner internals. The wrapper lives in `resolveDeployOperation`'s caller site (the deploy route handler) — not inside `scripts-runner.ts`. Non-project-local dispatches retain the existing `parse → 400` HTTP behaviour (no regression, no dual-write of failed parses for built-in deploys).
- Q: `scriptPath`'s type contract. The API-route code reads `req.body.scriptPath` as `unknown` and coerces to string inside `validateScriptPath`, meaning `123 → "123"`, `false → "false"`, `{} → "[object Object]"` would silently become valid strings. The manifest Zod `.refine` uses `z.string()` which rejects non-strings. Which layer defines the type? → A: **Strict at every layer — only `string | null | undefined` is accepted; everything else returns 400 INVALID_PARAMS without coercion**. The API-route Zod schema changes from `z.unknown().optional()` to `z.union([z.string(), z.null()]).optional()` for the `scriptPath` field. `validateScriptPath` keeps its signature but its input is now typed `string | null | undefined` (the `unknown` parameter type is narrowed by the route before the function is called). No string coercion anywhere in the validation path. Error message for non-string input: `"scriptPath must be a string or null"`.
- Q: The 256-byte limit in FR-003. JavaScript's `string.length` returns UTF-16 code-unit count, not byte count — a path with one emoji is 2 code units but 4 UTF-8 bytes. Should we enforce bytes correctly, or simplify the contract? → A: **Simplify: reject non-ASCII entirely**. `scriptPath` matches `/^[\x20-\x7E]+$/` (printable ASCII) after all other rules. Rationale: real project deploy-script paths are always ASCII (`scripts/devops-deploy.sh`, `src/bin/release.sh`, etc.); a path with `скрипты/деплой.sh` is a local naming choice that creates only pain in a cross-platform deploy context. Rejecting non-ASCII (a) eliminates the bytes-vs-chars trap entirely (`string.length` now equals byte count because every char is 1 byte in ASCII), (b) removes a class of encoding-mismatch bugs on file-system lookups, (c) is trivial to test. The Clarifications answer "≤256 bytes" in FR-003 becomes ≤256 characters-which-equal-bytes. Non-ASCII support is explicitly out of scope for v1; if a real project needs it, they rename the script.
- Q: Forward-slash path policy covers `/`-absolute and `..`, but not backslashes or `./` prefixes. What's the contract? → A: **Backslash REJECTED, `./` ALLOWED (no normalisation)**. Rationale for `\`: targets are Linux (SSH), backslash in a path on Linux is legal-but-bizarre and almost always an operator typing a Windows-style path by mistake. Reject with message "Path contains characters that are not allowed" (falls out of the existing metachar regex once `\` is added). Rationale for `./`: bash resolves `/opt/app/./scripts/deploy.sh` identically to `/opt/app/scripts/deploy.sh` — zero-cost, zero-risk, and requiring operators to strip the prefix would be a surprise. Validator accepts; no rewrite; shQuote handles literally. `../` remains rejected (traversal). `.` alone (current dir reference without trailing `/`) is allowed as a valid path component (matches any filename starting with `.`).

### Session 2026-04-25 (Gemini review pass)

- Q: FR-044's pre-insert wrapper catches only `ZodError`; any other exception thrown from `scriptsRunner.runScript` BEFORE the runner gets a chance to update the row (e.g. `DeploymentLockedError`, postgres connection error, SSH pool failure, Node OOM) leaves `script_runs` in `status: pending` with no terminal transition — a "zombie run" visible in the UI as perpetually spinning. How do we close this? → A: **Two-layer defence.** Layer 1 — the wrapper's `catch` block MUST update the row to `status: failed` for ANY caught exception (not only ZodError), using a **conditional UPDATE keyed on `WHERE id = :runId AND status = 'pending'`**. This is best-effort: if the runner already transitioned the row through `pending → running` before throwing, the WHERE clause misses and the runner's own terminal-status handler owns the row (no double-write). If the wrapper caught the error before the runner's first update, the WHERE clause matches and the row transitions to `failed`. Layer 2 — feature 005's existing startup reaper (`reapZombieScriptRuns` — landed in commit `07386c9`) already sweeps long-stuck `pending`/`running` rows on dashboard restart as a backstop. Between the wrapper's best-effort reap and the reaper's catch-all, zombie rows are bounded to "until the wrapper's catch fires" (usually milliseconds) or at worst "until next dashboard restart". Error message on non-Zod paths: `"Deploy dispatch failed: " + err.message` — preserves the raw cause for forensics without leaking stack traces.
- Q: `bash <path>` ignores the script's shebang line — only the kernel's `execve` path honours shebangs, and we deliberately don't use `execve` (exec-bit gets lost on cross-platform git-clone). A project script with `#!/usr/bin/env python3` will be parsed as bash, producing nonsense errors. How do operators know this? → A: **Document in two surfaces.** (a) `ScriptPathField.tsx` helper text explicitly says `"Relative path to a bash script. Shebang is ignored — the script is invoked as 'bash <path>'. Non-bash scripts (Python, Node) must be wrapped in a bash entrypoint."`. (b) `quickstart.md` §Common pitfalls gains a new subsection `"My script is Python/Node"` with a two-line bash wrapper example. Neither is a FR change — they are documentation artefacts of the shebang-ignored behaviour inherited from `bash <path>` semantics.
- Q: The 30-minute timeout catches hung scripts, but it burns an SSH connection + a slot in the deploy-lock pool for the full duration. Common cause of hangs: scripts that prompt for confirmation (`apt-get install` without `-y`, `prisma migrate` without `--accept-data-loss`). Can we proactively signal non-interactive mode? → A: **Yes, cheaply, via env prefix in the dispatch command.** The `buildProjectLocalCommand` helper prepends `NON_INTERACTIVE=1 DEBIAN_FRONTEND=noninteractive CI=true` (industry-convention env vars) BEFORE `bash <path>`. These names are respected by: apt + debconf (DEBIAN_FRONTEND), many CI-aware tools including drizzle-kit / prisma / npm (CI), most modern CLIs that follow the [NO_COLOR + NON_INTERACTIVE informal standard]. Scripts that don't check the vars are unaffected. Cost: 3 words in the command string; benefit: closes one real class of 30-min-timeout hangs. No spec FR addition — this is a contract-extension of FR-013 (command shape).

## Problem Statement

On 2026-04-22 the ai-digital-twins production app crashed within seconds of a dashboard-triggered deploy. The error was `column "knowledge_mode" does not exist` — a schema change had landed in the code without a matching database migration on production. The mechanism of the failure:

1. The project historically used its own `scripts/server-deploy-prod.sh` invoked via SSH, which included `drizzle-kit push` between `git pull` and `docker compose up -d`.
2. When the team switched to the devops-app dashboard for deploy orchestration, the dashboard called its own builtin `scripts/deploy/server-deploy.sh`, which does `git pull` + `docker compose up -d` and **nothing in between**.
3. The `drizzle-kit push` step was silently dropped — not because anyone removed it, but because the migration step was never in the builtin script in the first place. The project's own script was bypassed.
4. The deploy "succeeded" from the dashboard's perspective (containers up, exit 0). The app crashed on first request when it tried to read the new column.

This is not specific to Drizzle, ai-digital-twins, or ORMs in general. It is the generic gap between a **one-size-fits-all deploy orchestrator** (this repo) and the **project-specific pre/post steps** that each consumer legitimately needs: migrations (any ORM), cache warmup (Redis flush, CDN purge), asset sync (S3 upload, static file rebuild), secrets rotation, dependent-service restart. Every such step is a cost the project already paid — designed, tested, documented in their own deploy script. The dashboard today silently drops all of it.

The U-1 slice of the source handoff asks for the minimum structural change that closes this gap: let a project point the dashboard at its own deploy script, so the dashboard's dispatch becomes a thin envelope around the project's existing investment rather than a replacement for it. The dashboard does not learn about Drizzle, Prisma, or any ORM — it learns about a **path**. Everything else (what the script does, when it runs migrations, what it touches) stays inside the project's repo where it belongs.

## User Scenarios & Testing

### User Story 1 — Replace a broken builtin deploy with the project's own script (Priority: P1)

As a project maintainer whose repo has its own tested deploy script, I want to tell the dashboard "use THAT script, not your builtin one" so deploys stop silently skipping project-specific steps like database migrations, cache warmup, and asset sync.

**Acceptance**:

- The Add/Edit Application form has an optional text input labelled "Project Deploy Script" with a placeholder `scripts/devops-deploy.sh` and help text explaining it is a relative path inside the repo, overriding the builtin deploy.
- Leaving the field empty keeps the existing behaviour (builtin `scripts/deploy/server-deploy.sh` dispatch).
- Filling the field with a valid relative path (e.g. `scripts/server-deploy-prod.sh`) causes subsequent deploys to invoke THAT script on the target, with the same `--app-dir`/`--branch`/`--commit`/`--no-cache`/`--skip-cleanup` CLI flags the builtin would receive.
- The Deploy button, deploy log viewer, and deploy-history row all work identically regardless of which script was dispatched.

### User Story 2 — Preserve backward compatibility for apps without a project script (Priority: P1)

As a dashboard admin managing many apps, I want apps that do NOT set a project-local script path to continue using the builtin deploy unchanged, so this feature does not force a migration effort on every existing app.

**Acceptance**:

- Every existing application row after this feature ships has a null/empty project-local script field — no automatic backfill, no migration, no default.
- Null-field apps dispatch to the existing `deploy/server-deploy` (git-backed) or `deploy/deploy-docker` (docker-only scan) manifest entries exactly as today.
- The deploy success rate, log shape, Telegram notifications, and deploy-history view for null-field apps are indistinguishable from the pre-feature behaviour.
- Integration tests covering the builtin deploy path (e.g. `tests/integration/deploy*.test.ts`) continue to pass without modification.

### User Story 3 — Surface which script ran in deploy history and logs (Priority: P2)

As a dashboard admin diagnosing a failed deploy, I want the log viewer and deploy-history row to clearly show whether the builtin or a project-local script was dispatched, so I can tell at a glance whether a failure is a dashboard bug or a project-script bug.

**Acceptance**:

- The deploy log's header line (or equivalent surface in the run detail UI) includes the dispatched script identity: either the builtin script id (`deploy/server-deploy`) or the project-local path (`project-local:scripts/server-deploy-prod.sh`).
- The `script_runs` row persists enough detail to answer the same question after the fact (script_id and params JSON).
- A support engineer viewing a broken deploy from the Runs page can, without leaving the UI, tell which script was invoked and with what argument values (except secrets, which remain redacted per feature 005 FR-016).

### User Story 4 — Reject unsafe script paths before they are persisted (Priority: P2)

As a dashboard admin protecting the operator fleet from typos and malicious imports, I want the form to reject script paths that could escape the project repo, so scan-imported or hand-typed paths cannot point the dispatcher at `/etc/passwd`, `../../../../../bin/rm`, or shell-injection payloads.

**Acceptance**:

- The form rejects values starting with `/` (absolute paths) with an inline error "Must be a relative path inside the repo".
- The form rejects values containing `..` segments with an inline error "Path cannot contain parent-directory traversal".
- The form rejects values containing shell metacharacters (spaces, `;`, `|`, `&`, `$`, backticks, `<`, `>`, newlines, quotes) with an inline error "Path contains characters that are not allowed".
- The form rejects values longer than 256 bytes.
- The server-side API enforces the same rules (defence-in-depth) and returns 400 on violation.
- A project path that passes validation but points to a non-existent file on target results in a failed deploy with a captured `bash: <path>: No such file or directory` exit 127 — not a pre-flight rejection (per Clarifications).

### User Story 5 — Switch an app from builtin to project-local deploy without downtime (Priority: P3)

As an operator adopting this feature mid-stream on a live app, I want to switch an app from the builtin to a project-local deploy via a single form edit, so I do not need a maintenance window or a script-import ceremony.

**Acceptance**:

- Editing the application row to set the project-local script path takes effect for the NEXT deploy — no deploy-time restart, no background worker reload, no cache invalidation visible to the operator.
- The currently running deploy (if any) continues on whichever script it started with; switchover is not retroactive.
- Reverting the field to empty falls back to the builtin deploy without any other operator action.

## Edge Cases

- **Path points at a non-.sh file** (e.g. `scripts/deploy.py`): the dispatch invokes `bash <path>`, which will either execute if the file has a valid shebang or fail with a parse error. The dashboard captures the exit code and stderr unchanged — the operator is responsible for using bash-compatible scripts. Not a new safety concern (same as every other SSH-invoked script today).
- **Path contains spaces or quotes** (`scripts/my deploy.sh`): rejected by the validator per US-4. Projects must pick paths without shell metacharacters.
- **Symlinks on target** (`scripts/deploy.sh` → `../../../bin/rm`): out of scope. The dashboard trusts the repo contents; anyone with write access to the project's `scripts/` tree already has a larger attack surface than this path field.
- **Script file exists but is not executable** (missing exec bit): irrelevant — dispatch is `bash <path>`, which reads and interprets regardless of exec bit. Matches feature 005 FR-011's rationale.
- **Script modifies or deletes itself mid-deploy**: the SSH session is already running; the invocation is cached in memory. The next deploy re-reads the (new) file from disk. Same as today's builtin path.
- **Manifest entry for the project-local dispatch becomes invalid** (e.g. Zod schema bug in the feature code): per feature 005 FR-003, the entry is marked `valid:false` and the UI greys out the Deploy button. No deploy is executed silently.
- **Deploy lock held by a concurrent operation** (feature 004): project-local deploy MUST acquire the same lock. An in-flight builtin deploy blocks a project-local deploy on the same app and vice versa — there is no separate lock pool.
- **Telegram notifier payload**: the "Deploy Started/Succeeded/Failed" messages remain accurate. Including the dispatched script identity in the payload is nice-to-have but not required for v1 (the UI already shows it per US-3).
- **Log file size**: project-local scripts may emit more output than the builtin (e.g. migration tool chatter). The existing log-retention policy (feature 005 FR-042, 90-day default for `script_runs`) already accommodates this.
- **First deploy with `skipInitialClone: false`**: the dashboard's builtin flow clones the repo if it is absent. Project-local dispatch requires the repo to already exist on target because the script lives inside it. If the path does not resolve, the deploy fails with exit 127 — the operator's signal to bootstrap manually.
- **Rollback after a project-local deploy applied forward-only changes**: the builtin rollback performs `git reset + compose restart` — it cannot undo database migrations, cache flushes, or other non-git side-effects the project-local script introduced. The UI warns operators at click-time per FR-024; the operator decides whether to proceed or perform manual remediation (e.g. restore a DB dump). Projects that need a deterministic reversible deploy ship a matching rollback script in a follow-up feature (explicitly out of v1 scope).

## Functional Requirements

### Configuration

- **FR-001**: An `applications` row MUST support an optional `scriptPath` field: a relative path from the application's remote directory (e.g. `scripts/server-deploy-prod.sh`). Only two persisted states exist: NULL (no override — use builtin deploy dispatch) or a non-empty validated string. Empty strings and all-whitespace strings MUST be normalised to NULL before persistence (see FR-003) — the column never stores `""`.
- **FR-002**: The field MUST be writable via the Add Application and Edit Application forms and via the corresponding REST endpoints (create/update). It MUST be readable in the applications list, detail view, and API responses.
- **FR-003**: The field MUST be validated at input time (form) AND at the server-side endpoint layer with identical rules. Type checking runs BEFORE normalisation; normalisation runs BEFORE rule validation:
  - **Type check**: the incoming value MUST be `string`, `null`, or `undefined` (or absent). Every other JSON type (number, boolean, object, array) returns 400 `INVALID_PARAMS` with message `"scriptPath must be a string or null"`. No coercion — `123 → "123"` is explicitly NOT allowed.
  - **Normalisation**: if `null`/`undefined`/absent, treat as NULL. Else trim leading and trailing whitespace. If the trimmed result is the empty string, replace with NULL.
  - **NULL** (after normalisation): accepted — persisted as NULL ("no override").
  - **Non-NULL rule validation**, all of:
    - MUST be ≤ 256 characters (equivalently ≤ 256 bytes, because all characters must be printable ASCII per the next rule).
    - MUST match `/^[\x20-\x7E]+$/` (printable ASCII only — space through `~`). Non-ASCII paths are rejected; if a project has non-ASCII filenames, they rename the script.
    - MUST NOT start with `/` (no absolute paths).
    - MUST NOT contain any segment equal to `..` (after splitting on `/`). `.` alone is allowed as a segment; `./` prefix is allowed and passes through unchanged (bash handles the redundancy).
    - MUST NOT contain any of these characters: whitespace (already covered by the ASCII-printable regex when whitespace isn't a literal space, but literal space IS rejected via this rule), `\`, `;`, `|`, `&`, `$`, `(`, `)`, backtick, `<`, `>`, `"`, `'`, newline, null byte. Note that printable-ASCII space (`\x20`) IS on the banned list — paths with spaces are rejected. Parens are rejected for threat-model consistency — `$(...)` subshells are already closed via `$`, but standalone `(` / `)` in paths are pathological-enough signals to reject at intake rather than relying on `shQuote` downstream (defence-in-depth; Gemini-review 2026-04-25).
  - **Validation rejection** returns 400 with a per-field error message (server) or inline form error (UI). Messages are human-readable and name the specific rule violated (e.g. `"Path cannot contain parent-directory traversal"`, `"Path contains characters that are not allowed"`, `"Path must be printable ASCII"`).
  - **DB CHECK constraint** enforces the empty-string invariant only (`scriptPath IS NULL OR LENGTH(TRIM(scriptPath)) > 0`). The DB does NOT validate traversal / metachar / ASCII rules — those are application-layer-only. The CHECK is the last-line defence against a codepath that bypasses normalisation, not a full-rule enforcer.
- **FR-004**: The field value MUST NOT be combined with any other field to form a different path. The dashboard does not prepend `/opt/<app>/`, does not append arguments, does not resolve relative segments. The value is passed through to the dispatcher as a trusted-after-validation string.

### Dispatch

- **FR-010**: When deploying an application with a non-empty `scriptPath`, the deploy dispatcher MUST route to a project-local manifest entry (working name `deploy/project-local-deploy`) instead of `deploy/server-deploy` or `deploy/deploy-docker`.
- **FR-011**: The new manifest entry MUST have: `category: "deploy"`, `locus: "target"`, `requiresLock: true` (same lock semantics as builtin deploy), `timeout: 1_800_000` ms (same 30-minute ceiling as builtin deploy), `dangerLevel: "low"` (parity with `deploy/server-deploy` — no typing-confirm dialog). The Deploy button and deploy-confirmation UX for project-local dispatches MUST be visually and interactionally indistinguishable from builtin deploys, except for the script-identity surface required by FR-032.
- **FR-012**: The new manifest entry's `params` Zod schema MUST accept: `appDir: string` (remote repo root), `scriptPath: string` (relative path validated per FR-003), `branch: string` (same regex as builtin), `commit?: string` (same regex as builtin), `noCache?: boolean` (default false), `skipCleanup?: boolean` (default false).
- **FR-013**: When dispatching, the runner MUST invoke the project script via SSH remote-exec using the existing ssh-pool, with the command shape:

  ```
  NON_INTERACTIVE=1 DEBIAN_FRONTEND=noninteractive CI=true bash <appDir>/<scriptPath> --app-dir=<appDir> --branch=<branch> [--commit=<commit>] [--no-cache] [--skip-cleanup]
  ```

  Every argument MUST be single-quoted via `shQuote` (same defence-in-depth as feature 005 FR-011). The env-var prefix is ALWAYS emitted (per Clarifications 2026-04-25) — it signals non-interactive mode to tools that honour it (apt via `DEBIAN_FRONTEND`; CI-aware CLIs via `CI`; informal non-interactive convention via `NON_INTERACTIVE`). Scripts that don't check these variables are unaffected. The env-var names are NOT configurable in v1 — they are industry-convention constants emitted unconditionally to close one class of 30-minute-timeout hangs. The script file is NOT piped through `bash -s` stdin — the file on the target is the source of truth, the dashboard does not re-transport it.
- **FR-014**: The feature-005 runner's secret-parameter transport (FR-016) is NOT reused by this dispatch. Secrets are not a v1 capability for project-local scripts — if the project needs them, the script reads them from the target's `.env` file or from its own secret store. A future feature may extend secret plumbing across the project-local boundary; v1 does not.
- **FR-015**: The resolved dispatch decision MUST be made by a pure function (extending the existing `resolveDeployOperation`) keyed solely off the application row's fields. No global flag, no env var, no feature toggle — every app's dispatch is deterministic from its own state.

### Fallback & Backward Compatibility

- **FR-020**: An application row with null/empty `scriptPath` MUST dispatch identically to the pre-feature behaviour:
  - Git-backed non-docker apps → `deploy/server-deploy`.
  - Docker-only scan-imported apps (`repoUrl` starts with `docker://`, `skipInitialClone: true`) → `deploy/deploy-docker`.
- **FR-021**: The database migration that adds the column MUST default to NULL for all existing rows. No in-place backfill, no inference from `remotePath` contents, no scan of the target's filesystem.
- **FR-022**: Existing integration tests for builtin deploys MUST continue to pass with no behavioural changes. New integration tests cover the project-local path as a separate suite.
- **FR-023**: Rollback dispatch is NOT affected by this feature. An application with `scriptPath` set still rolls back via `deploy/server-rollback`. (Adding a matching rollback override is out of scope — see Out of Scope.)
- **FR-024**: When an operator initiates a rollback on an application with non-null `scriptPath`, the UI MUST display a confirmation dialog before dispatching. The dialog MUST explain in plain language that the builtin rollback performs only `git reset + compose restart` and does NOT undo project-specific side-effects (database migrations, cache flushes, asset syncs, etc.) that the project-local deploy script may have applied. The dialog MUST require explicit operator acknowledgement (a button click) to proceed; dismissing or cancelling the dialog MUST abort the rollback without dispatch. Applications with null `scriptPath` retain whatever rollback confirmation UI exists today — no regression.
- **FR-025**: The Feature 003 scan-for-repos flow MUST NOT populate `scriptPath` on scan-created `applications` rows. Every row created by scan MUST persist with `scriptPath = NULL`. The scan flow MUST NOT perform any SSH probe for candidate deploy-script filenames (`devops-deploy.sh`, `server-deploy-prod.sh`, etc.) — such probes are explicitly out of scope. Operators who want project-local deploy on a scan-imported app MUST set `scriptPath` via the Edit Application form after scan completes.

### History & Observability

- **FR-030**: Every project-local deploy MUST record a `script_runs` row with `script_id = "deploy/project-local-deploy"` and `params` capturing the full dispatch (including `scriptPath`). History survives dashboard upgrades and script removals per feature 005 FR-040 / FR-043.
- **FR-031**: Every project-local deploy MUST also record a `deployments` row (same dual-write as builtin deploys per feature 005 FR-041), linked back to `script_runs` via the existing `script_runs.deployment_id` FK.
- **FR-032**: The deploy log viewer (live + post-mortem) MUST display the dispatched script identity: either the builtin script id or the string `project-local:<scriptPath>`. Rendering MAY be in the header, a badge, or an explicit log line — any surface that makes the identity visible at a glance.
- **FR-033**: The Runs page list MUST show the project-local entries with a distinguishing visual (badge, icon, or differentiated script id column) so operators can filter or eyeball them without opening each run.

### Security

- **FR-040**: The `scriptPath` field is user-supplied data. Validation per FR-003 is the primary defence. `shQuote` in the dispatch command per FR-013 is the secondary defence. The combination covers injection attacks even if either layer had a bug.
- **FR-041**: The dashboard MUST NOT read the script file's contents from the target before dispatch. No `cat <scriptPath>` pre-check, no content-based validation, no hash comparison. The file on target is trusted-after-path-validation; anything else creates a TOCTOU window.
- **FR-042**: The existing audit middleware (feature 005 R-004) MUST capture `scriptPath` in the audit log entry for the application-create and application-update operations.
- **FR-043**: The runner's existing SSH user constraint (feature 005 FR-031) applies unchanged: project-local scripts run as the same non-root SSH user as builtin deploys.
- **FR-044**: The deploy dispatcher MUST re-validate `scriptPath` against the FR-003 rule set at dispatch time, immediately before constructing the SSH command and independent of write-time validation. The re-validation MUST apply to every dispatch (not cached, not skipped based on any flag). On failure the dispatcher MUST reject the run and MUST NOT fall back to the builtin `deploy/server-deploy` or `deploy/deploy-docker` entries — silent fallback is forbidden because it would mask a corrupt DB state from the operator.
  - **Failure lifecycle (persisted forensics, per Clarifications Q-2026-04-24-01 + Q-2026-04-25-01)**: because feature 005's runner flow is `parse → acquireLock → insert script_runs` — meaning a Zod parse failure (or any earlier exception: lock contention, DB error, network failure, OOM) would throw BEFORE any row is written — the project-local dispatch path MUST implement a pre-insert guard around the runner call. Specifically, the deploy route handler (or a thin wrapper it calls) MUST:
    - **(a) Pre-insert pending row**: insert a `script_runs` row with `status: pending, scriptId: "deploy/project-local-deploy", params: <pre-parse-input>, serverId, userId, deploymentId, startedAt: now` BEFORE invoking `scriptsRunner.runScript(...)`. Row UUID is allocated once and reused — passed to the runner via its `reuseRunId` option so the runner UPDATEs the same row rather than inserting a duplicate.
    - **(b) Catch ALL exceptions, not only ZodError**: the wrapper's `catch` block MUST update the row to `status: failed` for every caught exception. For ZodError specifically, `errorMessage = "scriptPath failed runtime validation: <rule violated>"`. For all other errors, `errorMessage = "Deploy dispatch failed: " + err.message` (raw cause preserved, no stack traces). Any error is then re-thrown (ZodError wrapped as `ProjectLocalValidationError` for route-handler classification; other errors propagate unchanged).
    - **(c) Conditional UPDATE** on the failed-status write: the UPDATE MUST key on `WHERE id = :runId AND status = 'pending'`. This prevents the wrapper from overwriting the runner's terminal status when the runner threw AFTER successfully transitioning `pending → running → {success | failed}`. The wrapper only "wins" the update when the row is still in `pending` — i.e. the error fired before the runner touched the row. No CAS race, no lost-update anomaly.
    - **(d) Startup reaper backstop**: feature 005's existing `reapZombieScriptRuns` on dashboard startup (commit `07386c9`) sweeps any row that was left stuck in `pending` / `running` past a threshold, transitioning it to `failed` with `errorMessage = "dashboard restart — zombie run reaped"`. This is the last-line defence: if the wrapper's process itself dies (container kill, OOM) between insert and catch, the row gets cleaned up at next start. The guarantee is therefore: zombie rows bounded to **at most one dashboard uptime cycle**, not "forever". No additional code in this feature — pure inheritance from 005.
    - Non-project-local dispatches retain the existing `parse → 400` HTTP behaviour. No regression, no dual-write of failed parses for built-in deploys.
  - **No SSH check**: the re-validation MUST NOT perform any SSH-side `test -f` — missing files surface via script exit 127 as established in the 2026-04-23 clarification.

## Success Criteria

- **SC-001**: An app configured with a project-local deploy script that runs `drizzle-kit push && docker compose up -d` SHIPS a schema change and the updated application code in one deploy, without operator intervention, in 100% of manual test runs across 5 consecutive deploys.
- **SC-002**: An app with null `scriptPath` deploys with identical log output, exit code, timing (±5%), and Telegram notification payload compared to the pre-feature baseline, measured on the same target server with the same repo.
- **SC-003**: A project-local deploy that fails (non-zero exit) surfaces in the dashboard Runs page as `status: failed` with the last ≥ 30 lines of stderr visible in the log viewer, in < 10 seconds from the script's exit.
- **SC-004**: An operator can switch an existing app from builtin to project-local deploy via the Edit Application form alone — no SSH, no server-side config, no migration script — in < 2 minutes including verification of the next deploy's success.
- **SC-005**: The incident class "dashboard deploy succeeded, app crashed on first request due to missing migration / missing pre-step" has zero occurrences for apps using `scriptPath` in the 30 days following feature rollout, across the fleet managed by this dashboard.
- **SC-006**: Validation rejects 100% of a representative injection test suite: path traversal (`../foo`, `foo/../bar`), absolute paths (`/etc/passwd`), shell metacharacters (`foo;rm -rf /`, `$(echo pwn)`, `` `id` ``), newlines, null bytes, and excessively long paths (> 256 bytes).
- **SC-007**: A `scriptPath` value inserted directly into the `applications` row via SQL (bypassing the API validator) that violates FR-003 rules, OR any non-Zod exception thrown by the runner (lock contention, postgres connection error, SSH pool failure), MUST cause the deploy attempt to fail with a persisted `script_runs` row — no silent fallback to builtin dispatch, no zombie "pending" row. Verified by integration tests covering both paths:
  - **Zod path**: direct `UPDATE applications SET script_path = '../../etc/passwd'` followed by Deploy click → (a) `script_runs` row EXISTS with `scriptId = 'deploy/project-local-deploy'`, `status = 'failed'`, `errorMessage` matches `"scriptPath failed runtime validation: contains parent-directory segment '..'"`, `startedAt` + `finishedAt` populated, `deploymentId` linked; (b) `sshPool.execStream` NOT called; (c) no fallback dispatch to `deploy/server-deploy`.
  - **Non-Zod path**: mock `deployLock.acquireLock` to throw `DeploymentLockedError`; click Deploy → (a) `script_runs` row EXISTS with `status = 'failed'`, `errorMessage` begins with `"Deploy dispatch failed: "` and contains the underlying error message, `finishedAt` populated; (b) the `DeploymentLockedError` propagates to the HTTP layer and produces the expected 409 response (contract-matched with feature 005's existing lock-error handling).
  - **Concurrency-safety**: when the runner successfully transitions `pending → running` and THEN throws (simulated via mocked `sshPool.execStream` failing mid-stream), the runner's own terminal-status handler owns the row update — the wrapper's conditional UPDATE (`WHERE status = 'pending'`) is a no-op. Verified by spying on both code paths and asserting the row was updated exactly once with the runner's error message, not double-written.
  - Row existence is a hard requirement in every failure mode — the forensics trail is the operator's only signal that something went wrong, and zombie "pending" rows are disallowed at the contract level.

## Key Entities

### `applications` (modified — one new column)

- `scriptPath TEXT NULL` — relative path from `remotePath` on target to the project's own deploy script. Only two valid persisted states: NULL (use builtin deploy dispatch) or a non-empty validated string. Empty string `''` and all-whitespace values are normalised to NULL before persistence and MUST be prevented by a CHECK constraint (`scriptPath IS NULL OR LENGTH(TRIM(scriptPath)) > 0`). Validated per FR-003 at write time.

The column is nullable with no default. Existing rows are null-backfilled by the column-add migration. No server-side or client-side code path may emit `WHERE scriptPath = ''` — the column is a two-state field (NULL vs present) by contract.

### `scripts-manifest.ts` (modified — one new entry)

Working name `deploy/project-local-deploy`. Shape:

```ts
{
  id: "deploy/project-local-deploy",
  category: "deploy",
  description: "Deploy via a project-local script (overrides builtin)",
  locus: "target",
  requiresLock: true,
  timeout: 1_800_000,
  dangerLevel: "low",             // parity with builtin deploy/server-deploy
  params: z.object({
    appDir: z.string(),
    scriptPath: z.string(),       // validated relative, no traversal, no metachars
    branch: z.string().regex(BRANCH_REGEX),
    commit: z.string().regex(SHA_REGEX).optional(),
    noCache: z.boolean().default(false),
    skipCleanup: z.boolean().default(false),
  }),
}
```

The entry is dispatched by `resolveDeployOperation` when and only when the application row's `scriptPath` is non-null.

### `resolveDeployOperation` (modified — one new branch)

Adds a branch at the top of the existing dispatch:

```text
if (app.scriptPath) → { scriptId: "deploy/project-local-deploy",
                        params: { appDir, scriptPath, branch, commit, noCache, skipCleanup } }
```

Below this branch, the existing docker/git dispatch is unchanged. Pure function, no side effects — same contract as today.

### `script_runs` / `deployments` (unchanged schema)

No new columns. The new dispatch reuses the existing tables: `script_runs.script_id = "deploy/project-local-deploy"`, `script_runs.params` carries the full dispatch, `deployments` is dual-written exactly as for builtin deploys.

## Assumptions

- **A-001**: The project's repo is already cloned on the target at `remotePath` before any project-local deploy is attempted. Bootstrap is manual (operator SSH + `git clone`) or happens via an earlier builtin deploy. First-deploy auto-clone is out of scope.
- **A-002**: The project's deploy script is bash-compatible — interpretable by `bash <path>` with or without a shebang. Non-bash scripts (Python, Node, compiled binaries) are not supported in v1; projects wanting them can write a thin bash wrapper.
- **A-003**: The project script accepts the builtin `--app-dir`/`--branch`/`--commit`/`--no-cache`/`--skip-cleanup` CLI flags, or ignores unknown flags gracefully. The dashboard passes all of them regardless — the contract is defined by the builtin `scripts/deploy/server-deploy.sh` and documented for consumers.
- **A-004**: The existing feature-004 deploy lock is sufficient for mutual exclusion between builtin and project-local deploys on the same app. No per-dispatch lock partitioning.
- **A-005**: Operators who set `scriptPath` on an app implicitly trust the repo's contents — the dashboard does not enforce a separate review or signing step on the script file. Threat model: a committer with write access to the project's `scripts/` tree already has deploy-equivalent control; adding a signature check at the dashboard layer does not close any real gap.
- **A-006**: Telegram notification ownership has **two independent emitters**, neither coordinated with the other:
  - **Dashboard-side notifier** (feature 005 notifier service): fires on every `script_runs` terminal-status transition — `success`, `failed`, `cancelled`, `timeout` — regardless of dispatch kind. A project-local deploy that succeeds will fire exactly one dashboard-side "Deployed!" Telegram message; one that fails will fire exactly one "Deploy Failed!" message. This behaviour is inherited unchanged from feature 005; feature 007 does NOT add, remove, or modify it.
  - **Project-side script** (when the project-local `scriptPath` points at a bash script that itself sends Telegram messages, like the builtin `scripts/deploy/server-deploy.sh` does via its `send_telegram()` function): fires zero or more messages according to the script's own logic.
  - **Net effect**: operators receive 1 message from the dashboard PLUS whatever the project script sent (0..N). Projects wanting the legacy "deploy started / deploy succeeded" Telegram pattern — which the builtin script emits — must replicate it in their project-local script. Projects that prefer quieter deploys can omit their own Telegram emissions; the dashboard's single terminal-status message remains.
  - **Double-notification concern**: the dashboard's terminal-status message is fire-and-forget via the existing `notifier` service — it does NOT de-duplicate with whatever the project script sent. Operators who find this noisy can mute the app via the feature-006 `alertsMuted` flag; the dashboard will skip its Telegram emission, and only the project-script's messages remain.

## Dependencies

- **Feature 001** (deploy history): `deployments` table and deploy flow — the project-local dispatch dual-writes here per FR-031.
- **Feature 003** (scan-for-repos): scan flow is constrained to NOT touch `scriptPath` per FR-025 — baseline rows always default to builtin dispatch, specialisation is operator-owned.
- **Feature 004** (deploy lock): `deployLocks` row — project-local dispatch acquires this before SSH via `requiresLock: true`.
- **Feature 005** (universal script runner): manifest, `scriptsRunner.runScript`, `shQuote`, ssh-pool, log-stream — the dispatch reuses every piece; no new primitive is introduced for this feature.

## Out of Scope

- **U-2** (dry-run deploy preview): separate spec. This feature does not add any pre-execution simulation.
- **U-3** (failure-state UI banner / sticky alert on the dashboard homepage): separate spec. Telegram + Runs-page status are the only surfaces for failure in v1.
- **U-4** (generic pre-flight "wrong compose file" detector, and by extension any pre-flight `test -f <scriptPath>` check): separate spec. v1 relies on the script's own exit code to surface missing files.
- **U-5** (migrations dashboard tab that visualises ORM migration state across apps): separate spec. The dashboard does not learn about any ORM in v1.
- **Rollback override**: a sibling `rollbackScriptPath` field is not introduced. Rollback continues to dispatch `deploy/server-rollback`. A project that needs deterministic rollback ships it as a follow-up feature.
- **First-deploy bootstrap**: auto-cloning the repo on the target when `scriptPath` is set but the remote path does not exist is not implemented. Operator responsibility in v1.
- **Non-bash project scripts**: invocation is `bash <path>`. Python/Node/binary entry points are out of scope; project wraps them in bash if needed.
- **Per-script-path secret passthrough**: feature-005 secret parameters (FR-016) are NOT extended to the project-local dispatch. Projects read secrets from target-side `.env` or their own stores.
- **Script signing / hash verification**: the dashboard does not verify the script's integrity. Trust is inherited from the project's version control.
- **UI polish on the Runs page**: a separate filter for project-local entries beyond the FR-033 visual distinguishing is not required in v1.
- **Scan-import heuristic for `scriptPath`**: scan does NOT probe for candidate deploy-script filenames and does NOT populate `scriptPath` — every scan-created row defaults to NULL (builtin dispatch). A future richer scan UI that proposes candidate scripts with operator confirmation is a possible follow-up feature but is explicitly out of v1.

## Related

- Source handoff: `ai-digital-twins/specs/133-prod-migration-workflow/undev-handoff.md` — the originating request and the full U-1..U-5 breakdown.
- Incident 2026-04-22-ai-twins-broken-deploy: the failure scenario that motivated U-1.
- Feature 005 (`specs/005-universal-script-runner/spec.md`): the manifest + runner this feature extends.
- Feature 004 (`specs/004-db-deploy-lock/spec.md`): deploy-lock semantics inherited by the new manifest entry.
- Feature 006 (`specs/006-app-health-monitoring/spec.md`): the `waitForHealthy` post-deploy gate (FR-024..FR-028) composes with this feature — a project-local deploy script can be wrapped by the same health-gate if the manifest entry opts in. Composition is implicit; no coordination required.
