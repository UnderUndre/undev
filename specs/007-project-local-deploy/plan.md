# Implementation Plan: Project-Local Deploy Script Dispatch

**Branch**: `main` (spec-on-main convention per features 005/006) | **Date**: 2026-04-24 | **Spec**: [spec.md](spec.md)

## Summary

Add one optional column (`applications.scriptPath`) and one new manifest entry (`deploy/project-local-deploy`). When `scriptPath` is set, `resolveDeployOperation` dispatches to the new entry; the runner gains a thin branch that invokes `bash <appDir>/<scriptPath>` over SSH remote-exec (rather than piping a bundled script through stdin). Everything else — lock acquisition, log streaming, history dual-write, timeout, audit — reuses feature 005's primitives unchanged.

The UI gains (a) one input field on Add/Edit Application, (b) one conditional confirmation dialog when Rollback is clicked on an app with `scriptPath` set, (c) a script-identity surface on the log viewer and Runs page that renders `project-local:<scriptPath>` when applicable.

Defence-in-depth validation applies at three layers (form → API → runtime runner) plus a DB-level CHECK constraint for the NULL-only invariant. Feature 003 scan-for-repos is constrained to never populate `scriptPath` — the whole opt-in path is operator-owned via Edit.

## Technical Context

**Existing stack** (inherited from 001–006):

- Express 5 + React 19 / Vite 8 / Tailwind 4, drizzle-orm + `postgres` (porsager) 3.4.x
- `sshPool` (`ssh2` 1.17) with both `execStream(id, cmd)` (remote-exec) AND `executeWithStdin(id, cmd, buf)` (stdin pipe) from feature 005
- `jobManager` for in-memory job lifecycle + WS event fan-out
- Pino logger with redact config
- Feature 004 `deployLock` service for `requiresLock: true` entries
- Feature 005 `scriptsRunner.runScript(scriptId, serverId, params, userId, opts)` + `scripts-manifest.ts` + `shQuote` helper + `resolveDeployOperation` pure function
- Feature 005 `script_runs` table (dual-write with `deployments`)

**New for this feature**:

- One new column — `applications.scriptPath TEXT NULL` with a CHECK constraint disallowing `''` / all-whitespace.
- One new manifest entry — `deploy/project-local-deploy` declaring the Zod schema, `requiresLock: true`, `dangerLevel: "low"`, `timeout: 1_800_000`.
- One new dispatch branch in `resolveDeployOperation` — takes priority over the existing docker/git branches when `app.scriptPath` is non-null.
- One new runner code path — inside `scripts-runner.ts`, when `scriptId === "deploy/project-local-deploy"`, invoke `sshPool.execStream(serverId, <cmd>)` directly without the `common.sh` concat / stdin pipe. The project script runs from its checked-out location on the target, not from the dashboard image.
- One new validation helper — `validateScriptPath(raw) → { ok: true, value } | { ok: false, error }` shared by the form, the API route, and the runtime runner. Also usable as the source of truth for a Zod refinement.
- One new migration — `0006_project_local_deploy.sql` (ADD COLUMN + CHECK constraint).
- New UI — `ScriptPathField.tsx` (reusable input + inline validation), conditional `RollbackConfirmDialog`, script-identity badge/row in `RunDetail.tsx` and `RunsPage.tsx`.

**No new npm dependencies. No new Docker build changes. No new SSH primitives.**

**Unknowns resolved in research.md**:

- R-001: Dispatch transport — remote-exec vs stdin pipe.
- R-002: CLI contract propagation — how the 5 inherited flags are serialised.
- R-003: Where runtime re-validation lives (runner boundary vs route boundary).
- R-004: Null/empty normalisation placement (middleware vs route handler vs Drizzle hook).
- R-005: DB CHECK constraint syntax + migration mechanics.
- R-006: Rollback confirmation dialog placement in the existing component tree.
- R-007: Script-identity surface — where `project-local:<path>` renders in the UI.
- R-008: Feature 003 scan-for-repos boundary — what in the scan code ensures FR-025 holds.

## Project Structure

```
undev/
├── scripts/                                 # [unchanged — project-local scripts live on target, not here]
└── devops-app/
    ├── server/
    │   ├── db/
    │   │   ├── schema.ts                    # [MODIFIED — add scriptPath to applications]
    │   │   └── migrations/
    │   │       └── 0006_project_local_deploy.sql  # [NEW — ADD COLUMN + CHECK]
    │   ├── lib/
    │   │   └── validate-script-path.ts      # [NEW — shared validator, FR-003 rules]
    │   ├── services/
    │   │   ├── deploy-dispatch.ts           # [MODIFIED — new branch for scriptPath]
    │   │   ├── scripts-runner.ts            # [MODIFIED — remote-exec branch for project-local]
    │   │   ├── build-project-local-command.ts  # [NEW — pure helper, cmd-string builder]
    │   │   └── project-local-deploy-runner.ts  # [NEW — thin wrapper around scriptsRunner with pre-insert pending row (FR-044 lifecycle)]
    │   ├── scripts-manifest.ts              # [MODIFIED — add deploy/project-local-deploy entry]
    │   └── routes/
    │       ├── apps.ts                      # [MODIFIED — accept/normalise/validate scriptPath]
    │       └── deployments.ts               # [MODIFIED — no dispatch change; client reads scriptPath for rollback UX]
    ├── client/
    │   ├── components/
    │   │   ├── apps/
    │   │   │   ├── ScriptPathField.tsx      # [NEW — shared input + inline validator]
    │   │   │   ├── AddAppForm.tsx           # [MODIFIED — mount ScriptPathField]
    │   │   │   ├── EditAppForm.tsx          # [MODIFIED — mount ScriptPathField]
    │   │   │   └── ApplicationDetail.tsx    # [MODIFIED — show scriptPath in metadata (FR-002 visibility)]
    │   │   ├── deployments/
    │   │   │   └── RollbackConfirmDialog.tsx  # [NEW — conditional dialog for apps with scriptPath]
    │   │   └── scripts/
    │   │       ├── RunDetail.tsx            # [MODIFIED — render project-local:<path> identity]
    │   │       └── RunsPage.tsx             # [MODIFIED — same script-identity rendering in list]
    │   └── lib/
    │       └── validate-script-path.ts      # [NEW — thin copy or shared via workspace symlink for form validation]
    └── tests/
        ├── unit/
        │   ├── validate-script-path.test.ts          # [NEW — 40+ cases covering SC-006 injection suite + non-string + backslash + ./ + ASCII]
        │   ├── validate-script-path-parity.test.ts   # [NEW — server/client copies produce identical results on shared fixture]
        │   ├── build-project-local-command.test.ts   # [NEW — shQuote correctness on adversarial inputs]
        │   ├── resolve-deploy-operation.test.ts      # [MODIFIED — add 4 cases for scriptPath branch + null-passthrough regression]
        │   └── scripts-manifest.test.ts              # [MODIFIED — assert deploy/project-local-deploy valid + refine rejects bad paths]
        └── integration/
            ├── scripts-runner-project-local.test.ts  # [NEW — end-to-end happy path against mocked ssh + postgres]
            ├── scripts-runner-project-local-runtime-validation.test.ts  # [NEW — SC-007 DB-tampering defence + row-exists assertion]
            ├── apps-script-path-normalisation.test.ts  # [NEW — POST/PATCH /api/apps covering "" → NULL, trim, non-string rejection]
            ├── rollback-confirm-dialog.test.ts        # [NEW — UI integration for FR-024]
            ├── migration-0006-verification.test.ts   # [NEW — DB CHECK + post-migration verification queries]
            ├── scan-leaves-script-path-null.test.ts   # [NEW — FR-025 assertion]
            ├── script-path-mid-stream-switch.test.ts # [NEW — US-5 lifecycle]
            └── deploy.test.ts                         # [unchanged — SC-002 no-regression baseline]
```

## Key Implementation Notes

### Shared validator — `lib/validate-script-path.ts`

Single source of truth for FR-003. Returns a discriminated union so callers can distinguish "normalized to null" from "validation error" from "non-empty valid string":

```ts
type ValidateResult =
  | { ok: true; value: null }            // after normalisation → null (was "", whitespace, null, or undefined)
  | { ok: true; value: string }          // non-empty validated string
  | { ok: false; error: string };

export function validateScriptPath(raw: string | null | undefined): ValidateResult;
```

**Input type is strict** (`string | null | undefined`) per Clarifications Session 2026-04-24 (GPT review) — the route handler's Zod schema rejects non-strings BEFORE calling this function. No coercion inside the validator. Callers that receive raw JSON values must narrow the type first (`z.union([z.string(), z.null()]).optional()` in the route schema).

Rules (per FR-003):

1. **Normalise**: if `raw` is `null` / `undefined`, return `{ ok: true, value: null }`. Else `trim()`. If trimmed is `""`, return `{ ok: true, value: null }`.
2. Reject if length > 256 → `"Path must be ≤256 characters"`. (Byte-equivalent because rule 3 ensures every character is 1 byte.)
3. Reject if NOT matching `/^[\x20-\x7E]+$/` → `"Path must be printable ASCII"`. Non-ASCII paths rejected; `\t`/`\n`/`\0` and other control chars rejected by this rule before the metachar rule even fires.
4. Reject if starts with `/` → `"Must be a relative path inside the repo"`.
5. Reject if any segment (after splitting on `/`) equals `..` → `"Path cannot contain parent-directory traversal"`. Note: `.` alone as a segment is ALLOWED (so `./scripts/deploy.sh` passes — rule 4 blocks leading `/`, rule 5 only blocks `..`, and `.` passes through).
6. Reject if contains any character from this set: ` ` (space), `\`, `;`, `|`, `&`, `$`, backtick, `<`, `>`, `"`, `'` → `"Path contains characters that are not allowed"`. (Newline / tab / null already rejected by rule 3.)
7. Otherwise return `{ ok: true, value: trimmedPath }` (unmodified — `./` prefix passes through).

Order matters: rule 3 (ASCII) before rule 6 (metachars) means non-ASCII chars always fail with the ASCII message, giving a clearer operator signal than a metachar complaint about high-byte UTF-8 code units.

Both the server (`server/lib/validate-script-path.ts`) and the client (`client/lib/validate-script-path.ts`) need this logic. Two options per R-004: duplicate (10 lines each, trivial to keep in sync) or share via a `shared/` workspace. Plan chooses **duplicate** — the function is 30 lines, the test suite enforces parity with a contract test that runs the same fixture array against both modules. Avoids introducing workspaces for one helper.

### `scripts-manifest.ts` addition

Append to the existing `manifest` array:

```ts
{
  id: "deploy/project-local-deploy",
  category: "deploy",
  description: "Deploy via a project-local script (overrides builtin)",
  locus: "target",
  requiresLock: true,
  timeout: 1_800_000,
  dangerLevel: "low",                       // parity with deploy/server-deploy (FR-011, Q2)
  params: z.object({
    appDir: z.string(),
    scriptPath: z.string().refine(
      (s) => validateScriptPath(s).ok,
      "Invalid scriptPath"
    ),
    branch: z.string().regex(BRANCH_REGEX),
    commit: z.string().regex(SHA_REGEX).optional(),
    noCache: z.boolean().default(false),
    skipCleanup: z.boolean().default(false),
  }),
}
```

The `.refine()` is what makes FR-044 (runtime re-validation) free: `params` is already parsed by the runner via the Zod schema, so the validator fires automatically. No separate re-check code path.

### `resolveDeployOperation` new branch

Top of the function, before the existing docker-check:

```ts
export function resolveDeployOperation(app, runParams) {
  if (app.scriptPath) {
    const branch = runParams.branch ?? app.branch;
    const params: Record<string, unknown> = {
      appDir: app.remotePath,
      scriptPath: app.scriptPath,
      branch,
      noCache: runParams.noCache ?? false,
      skipCleanup: runParams.skipCleanup ?? false,
    };
    if (runParams.commit) params.commit = runParams.commit;
    return { scriptId: "deploy/project-local-deploy", params };
  }
  // ... existing docker / git branches unchanged ...
}
```

Pure function, fully unit-testable. Adds 4 test cases to `tests/unit/resolve-deploy-operation.test.ts`: scriptPath-set + manual+git, scriptPath-set + scan+git, scriptPath-set + scan+docker, scriptPath-null passthrough (regression).

### Pre-insert wrapper — `project-local-deploy-runner.ts`

Per spec FR-044 Failure lifecycle + Clarifications Session 2026-04-24 (GPT review) + 2026-04-25 (Gemini review): feature 005's runner flow is `parse → acquireLock → insert script_runs`. A ZodError on parse — OR any earlier exception (lock contention, DB error, network failure, OOM) — throws BEFORE the row is written, so the inherited runner alone cannot satisfy SC-007's "row MUST exist with status=failed" contract. The fix is a thin wrapper — invoked from the deploy route handler whenever `resolveDeployOperation` returns `deploy/project-local-deploy` — that allocates a `script_runs` row UUID, inserts a pending row BEFORE calling the runner, and updates it to `failed` on ANY caught exception using a **conditional UPDATE** (`WHERE status = 'pending'`) so the runner's own terminal-status writes are never overwritten.

```ts
// server/services/project-local-deploy-runner.ts
export async function dispatchProjectLocalDeploy({
  scriptId, serverId, params, userId, deploymentId,
}: {
  scriptId: "deploy/project-local-deploy";
  serverId: string;
  params: Record<string, unknown>;
  userId: string;
  deploymentId: string;
}): Promise<{ runId: string; jobId: string }> {
  const runId = randomUUID();
  const startedAt = new Date().toISOString();

  // Pre-insert pending row so SC-007's forensics trail exists for every failure mode.
  await db.insert(scriptRuns).values({
    id: runId,
    scriptId, serverId, userId, deploymentId,
    params: params,                    // raw pre-parse input; NOT secret-masked because project-local carries no secrets (FR-014)
    status: "pending",
    startedAt,
    logFilePath: makeLogPath(runId),
  });

  try {
    // Pass the pre-allocated runId so the runner updates (not inserts) the same row.
    return await scriptsRunner.runScript(scriptId, serverId, params, userId, {
      linkDeploymentId: deploymentId,
      reuseRunId: runId,               // NEW option on the feature-005 runner (see note below)
    });
  } catch (err) {
    // Reap zombie: best-effort transition of the row to `failed`, covering ANY
    // exception path — ZodError (runtime validation), DeploymentLockedError
    // (lock contention), postgres errors, SSH pool errors, OOM-style process
    // issues. The conditional WHERE clause ensures we only write when the
    // runner hasn't already transitioned the row (e.g. if the runner went
    // `pending → running` and THEN threw, its own terminal-status handler owns
    // the update — our conditional update becomes a no-op).
    const isZod = err instanceof ZodError;
    const msg = isZod
      ? `scriptPath failed runtime validation: ${err.issues[0].message}`
      : `Deploy dispatch failed: ${err instanceof Error ? err.message : String(err)}`;

    await db.update(scriptRuns)
      .set({
        status: "failed",
        errorMessage: msg,
        finishedAt: new Date().toISOString(),
      })
      .where(and(
        eq(scriptRuns.id, runId),
        eq(scriptRuns.status, "pending"),   // ← conditional: only if runner hasn't touched it
      ));

    // Classify for the HTTP layer: ZodError → ProjectLocalValidationError (400-ish);
    // everything else re-thrown unchanged so feature-005's existing route-level
    // handlers (DeploymentLockedError → 409, SSH errors → 503, etc.) still work.
    if (isZod) throw new ProjectLocalValidationError(msg, { runId });
    throw err;
  }
}
```

**Backstop layer**: feature 005's existing `reapZombieScriptRuns` on dashboard startup (commit `07386c9`) catches any row the wrapper couldn't reach (e.g. container kill between insert and catch). Zombie rows are therefore bounded to **at most one dashboard uptime cycle** — not "forever". No additional code required for this backstop; it's pure inheritance from 005.

**Concurrency invariant**: the conditional `WHERE status = 'pending'` clause makes the wrapper's UPDATE idempotent vs. the runner's own lifecycle writes. Specifically:

| Runner state when wrapper `catch` fires | Wrapper UPDATE behaviour |
|------|------|
| Never started (lock error, DB error, early throw) | Row still `pending` → WHERE matches → transitions to `failed` |
| `pending → running` then threw | Runner already set `status='running'` → WHERE mismatches → wrapper's UPDATE is a no-op → runner's own terminal handler owns the row |
| Already terminal (`success`/`failed`) | Same as above — WHERE mismatches → no-op |

No CAS race, no lost-update, no double-write. The invariant: exactly one writer transitions any given row out of `pending`.

Two feature-005 touch-points required (they're additive, not breaking):

1. `scriptsRunner.runScript` accepts an optional `reuseRunId` in its options — if set, the runner UPDATEs the existing row rather than INSERTing a new one. Non-project-local callers continue to omit this option and get the current behaviour.
2. `scripts-runner.ts` does NOT catch its own ZodError — it propagates as today. The wrapper is responsible for the status update; the runner's existing role (parse → lock → run → finalize) is unchanged for every other dispatch.

Route-handler integration: in `deployments.ts`'s deploy handler, after `resolveDeployOperation(app, runParams)` returns, branch on scriptId:

```ts
const { scriptId, params } = resolveDeployOperation(app, runParams);
let runResult;
if (scriptId === "deploy/project-local-deploy") {
  runResult = await dispatchProjectLocalDeploy({ scriptId, serverId, params, userId, deploymentId });
} else {
  runResult = await scriptsRunner.runScript(scriptId, serverId, params, userId, { linkDeploymentId: deploymentId });
}
```

The client-visible response shape (`{ deploymentId, jobId }`) is identical in both branches.

### `scripts-runner.ts` dispatch branch

The existing `runScript(scriptId, ...)` path handles bundled scripts via the common.sh-concat → `bash -s` stdin pipe. For project-local, replace that transport step with remote-exec:

```ts
async runScript(scriptId, serverId, params, userId, opts) {
  const entry = this.manifest.findById(scriptId);
  if (!entry) throw new ScriptNotFoundError(scriptId);
  const parsedParams = entry.params.parse(params);  // ← FR-044 runtime validation fires here via .refine()

  if (entry.requiresLock) await deployLock.acquireLock(serverId, runId);
  // ... insert script_runs row, set up job, etc. (unchanged) ...

  if (scriptId === "deploy/project-local-deploy") {
    // Build the shell command — NO stdin pipe, NO common.sh concat
    const cmd = buildProjectLocalCommand(parsedParams);  // see next section
    await sshPool.execStream(serverId, cmd, runId);
  } else {
    // Existing bundled-script path (unchanged)
    await this.dispatchBundledScript(entry, parsedParams, serverId, runId);
  }
  return { runId, jobId };
}
```

### `buildProjectLocalCommand(params)` helper

Produces the SSH-transported command string per FR-013. Every value single-quoted via `shQuote`. Env-var prefix is always emitted per Clarifications Session 2026-04-25 (Gemini review) to signal non-interactive mode to tools that honour the informal convention:

```ts
function buildProjectLocalCommand(p: ProjectLocalParams): string {
  const parts = [
    // Non-interactive env prefix (FR-013 + 2026-04-25 clarification):
    //   NON_INTERACTIVE  — informal convention; many CLIs check this
    //   DEBIAN_FRONTEND  — apt / debconf; suppresses `dpkg --configure` prompts
    //   CI               — widely honoured by drizzle-kit, prisma, npm, etc.
    // These three constants are unconditional and not configurable in v1.
    // Scripts that don't read them are unaffected; scripts that hang on
    // prompts will now exit cleanly instead of burning the 30-min timeout.
    "NON_INTERACTIVE=1",
    "DEBIAN_FRONTEND=noninteractive",
    "CI=true",
    "bash",
    `${shQuote(p.appDir)}/${shQuote(p.scriptPath)}`,    // note: no literal ., no double-quoting
    `--app-dir=${shQuote(p.appDir)}`,
    `--branch=${shQuote(p.branch)}`,
  ];
  if (p.commit) parts.push(`--commit=${shQuote(p.commit)}`);
  if (p.noCache) parts.push(`--no-cache`);
  if (p.skipCleanup) parts.push(`--skip-cleanup`);
  return parts.join(" ");
}
```

Path concatenation uses `${shQuote(appDir)}/${shQuote(scriptPath)}` — each quoted segment is its own `'...'` token, the slash is a literal shell separator. Both tokens are safe because `shQuote` escapes embedded `'` properly.

Env-var prefix rationale:
- **`NON_INTERACTIVE=1`** — recognised by many modern CLIs (docker buildx, some CI-aware npm packages). Zero downside if unrecognised.
- **`DEBIAN_FRONTEND=noninteractive`** — critical for any script that ends up calling `apt-get install` / `apt-get upgrade` without `-y`. Without this, debconf prompts and the script hangs for 30 min waiting on stdin.
- **`CI=true`** — respected by a broad set of tools including drizzle-kit (feature 007's target use case), prisma, npm (`npm ci` behaviour), vite, jest, and many more. Signals "automated environment, don't prompt".

Unit test: `tests/unit/build-project-local-command.test.ts` — ≥20 cases including the SC-006 injection suite + explicit assertion that every generated command starts with the exact env-prefix string `NON_INTERACTIVE=1 DEBIAN_FRONTEND=noninteractive CI=true bash` (regression guard against future refactors that might drop one of the three).

### Migration `0006_project_local_deploy.sql`

```sql
-- Feature 007: project-local deploy script dispatch
ALTER TABLE "applications" ADD COLUMN "script_path" TEXT;

-- NULL-only invariant (FR-001, FR-003, Q3): the column never stores '' or all-whitespace.
-- Any INSERT/UPDATE that would persist such a value is rejected at the DB level.
ALTER TABLE "applications" ADD CONSTRAINT "applications_script_path_non_empty"
  CHECK ("script_path" IS NULL OR LENGTH(TRIM("script_path")) > 0);

-- No backfill; every existing row stays NULL (FR-021).
-- No default; new rows that omit scriptPath get NULL naturally.
```

The CHECK is the defence-of-last-resort against any codepath that bypasses the API normalisation — ORM bugs, manual SQL, future migrations, test fixtures. Per Q3 / Notes in the checklist.

### Route changes — `routes/apps.ts`

Two endpoints touch the field: `POST /api/apps` and `PATCH /api/apps/:id`.

Normalisation-first flow:

```ts
const normalised = validateScriptPath(req.body.scriptPath);
if (!normalised.ok) {
  return res.status(400).json({
    error: { code: "INVALID_PARAMS", message: "Invalid scriptPath", details: { fieldErrors: { scriptPath: [normalised.error] } } }
  });
}
const scriptPathValue = normalised.value;   // null or validated string
await db.update(applications).set({ ..., scriptPath: scriptPathValue }).where(...);
```

Audit middleware (feature 005 R-004) automatically captures the new field in `audit_entries.details`. No special casing needed — `scriptPath` is a plain string, not a secret.

### Rollback UI — `RollbackConfirmDialog.tsx` (new)

Mounted from whatever component currently hosts the Rollback button — in feature 005's code this is `RunDetail.tsx` for the per-deployment rollback and `ApplicationDetail` for the app-level rollback. The dialog is conditional:

```tsx
const { data: app } = useApplication(appId);
const needsConfirm = Boolean(app?.scriptPath);

async function handleRollback() {
  if (needsConfirm) {
    const ok = await openDialog(<RollbackConfirmDialog scriptPath={app.scriptPath} />);
    if (!ok) return;
  }
  await api.rollback(...);   // unchanged call
}
```

Dialog copy (plain language, per FR-024):

> **Rollback uses the builtin rollback script**
>
> This app runs a project-local deploy script (`scripts/server-deploy-prod.sh`) that may apply database migrations, cache warmups, or other changes that can't be undone by a simple `git reset`.
>
> The builtin rollback only reverts the git state and restarts containers. Any migrations or side-effects from the last deploy will remain.
>
> Continue anyway?  [Cancel] [Rollback]

The dialog does NOT block — per clarification Q1 Option B, operator agency is preserved. Cancelling aborts the rollback without dispatch.

### Script-identity surface — `RunDetail.tsx` and `RunsPage.tsx`

Render logic (per FR-032, FR-033):

```tsx
function renderScriptIdentity(run: ScriptRun) {
  if (run.scriptId === "deploy/project-local-deploy") {
    const path = run.params?.scriptPath ?? "<unknown>";
    return (
      <span className="font-mono">
        <Badge variant="secondary">project-local</Badge>
        {" "}{path}
      </span>
    );
  }
  return <span className="font-mono">{run.scriptId}</span>;
}
```

Same helper used in the list row and the detail header. The badge is the visual distinguisher for FR-033's filter/eyeball requirement.

### Feature 003 scan — no code change, one test (FR-025)

Scan-for-repos already does NOT set any deploy-script field (feature 005 dropped `deploy_script`). The spec's FR-025 is effectively a regression-prevention: add `tests/integration/scan-leaves-script-path-null.test.ts` that runs the scan flow against a fixture repo containing `scripts/devops-deploy.sh` and asserts every created `applications` row has `scriptPath = null`. If a future change ever decides to probe for candidate scripts, the test fails and the change author must update this spec.

## Constitution Check

No `.specify/memory/constitution.md` in this repository. Applying CLAUDE.md Standing Orders (same mapping as feature 005):

| Principle | Status | Note |
|---|---|---|
| No commits/pushes without request | ✅ | Plan only |
| No new packages without approval | ✅ | Zero new deps |
| No `--force` / bypass flags | ✅ | N/A |
| No secrets in code/logs | ✅ | `scriptPath` is non-secret; audit + log paths already redact feature-005 secret fields |
| No direct DB migrations | ✅ | `0006_project_local_deploy.sql` generated for admin review |
| No destructive ops without consent | ✅ | `ADD COLUMN` with `NULL` default is non-destructive; CHECK constraint rejects bad writes rather than mutating existing data |
| Plan-first if >3 files changed | ✅ | 14 files listed in Project Structure |
| Check context7 before unfamiliar API | ✅ | No new APIs — all primitives (`shQuote`, `sshPool.execStream`, `scriptsRunner`, Zod `.refine`) are already in the codebase |

**Destructive-ops assessment**: this migration is additive only — no `DROP`, no `UPDATE`, no `ALTER COLUMN`. The rollback (DOWN migration) is `ALTER TABLE applications DROP COLUMN script_path;` which IS destructive but only fires on a deliberate operator downgrade. Documented in the migration header.

## Complexity Tracking

| Addition | Why Needed | Simpler Alternative Rejected |
|---|---|---|
| Shared `validateScriptPath` duplicated server + client | FR-003 — identical rules on both sides, single test fixture array ensures parity | Workspaces / monorepo package for one helper — overkill; creates build-graph weight without proportional benefit |
| DB CHECK constraint | Q3 clarification — defence-of-last-resort against API bypass | Trust app-layer normalisation alone — one ORM bug / manual SQL / seed script can poison `WHERE scriptPath = ''` queries forever |
| Remote-exec transport (no stdin pipe) | Clarification 2026-04-23 — the project-local script OWNS itself; piping dashboard-side would recreate the coupling U-1 eliminates | Read script from target, pipe via `bash -s` — requires SSH cat + context mixing, breaks "project owns versioning" promise |
| New manifest entry (vs param on existing `deploy/server-deploy`) | Clean separation of concerns — manifest entry identity = dispatch identity; script_runs.script_id becomes a reliable filter key | Reuse `deploy/server-deploy` with optional `scriptPath` — conflates two semantically different operations in one entry, complicates FR-032/33 identity surface |
| Conditional Rollback dialog | Q1 clarification — surfaces a real gap without blocking operator velocity | Silently document / block entirely — either under-warns or over-restricts |
| Integration test for scan boundary (FR-025) | Future-proof against an unrelated PR quietly adding scan heuristics | No test — change could land without any spec author review |

## Out of Plan

Explicit non-goals (mirror spec § Out of Scope):

- U-2 dry-run preview
- U-3 failure-state UI banner
- U-4 pre-flight "wrong compose file" detector (and by extension any pre-flight `test -f <scriptPath>` check)
- U-5 migrations dashboard tab
- Rollback override field (`rollbackScriptPath`)
- First-deploy bootstrap (auto-clone)
- Non-bash project scripts (Python / Node / compiled entry points)
- Secret-parameter passthrough to project scripts
- Script signing / hash verification
- Scan-import heuristic to auto-populate `scriptPath`
- Richer Runs-page filter for project-local entries beyond the FR-033 badge

## Agent Context Update

No new technology is introduced. The feature reuses `zod`, `drizzle-orm`, `postgres`, `ssh2`, `express`, `react`, `@tanstack/react-query` — all already in CLAUDE.md's implicit stack. No `update-agent-context.ps1` invocation is required; no rows to add to the stack table.

If a future reader runs `find . -name update-agent-context.ps1`, they will find nothing — this repo does not use the `.specify/` script harness. The equivalent check was done manually during plan review: `git grep 'new-package-name'` → no hits for anything outside the existing stack.

## Post-design Constitution Re-check

| Principle | Re-check | Note |
|---|---|---|
| No commits/pushes without request | ✅ | Still plan-only |
| No new packages | ✅ | Design uses only existing `zod`, `postgres`, `drizzle-orm`, `ssh2`, `pino`, `express`, `react`, `@tanstack/react-query` |
| No secrets in code/logs | ✅ | `scriptPath` is non-secret; the FR-016 secret-mask pipeline is untouched |
| Plan-first >3 files | ✅ | 14 files listed |
| No destructive ops without consent | ✅ | ADD COLUMN additive; DOWN migration documented and operator-gated |
| No raw string interpolation in SQL | ✅ | Drizzle for app queries; migration is a single static `.sql` file |
| No `any`, no `console.log` | ✅ | `validateScriptPath` returns typed union; logger calls use pino signature |
| Three-layer validation parity | ✅ | Form, API route, and Zod `.refine` all share `validateScriptPath` — contract test asserts parity |

Proceed to `/speckit.tasks`.
