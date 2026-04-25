# Research: Project-Local Deploy Script Dispatch

**Phase 0 output** | **Date**: 2026-04-24

---

## R-001: Dispatch transport — remote-exec vs stdin pipe

**Decision**: Use `sshPool.execStream(serverId, cmd)` (remote-exec) to invoke `bash <appDir>/<scriptPath> ...` on the target. The dashboard does NOT read the script's bytes, does NOT pipe anything through `bash -s` stdin, does NOT inject `common.sh` preamble.

**Why the feature-005 stdin pipe doesn't apply here**: feature 005's transport exists to solve a specific problem — scripts bundled in the dashboard image need to reach the target without leaving state there. That invariant depends on the dashboard owning the script bytes. This feature inverts the ownership: the script lives on the target inside the checked-out repo, versioned by the project. Piping dashboard-side would mean:

1. SSH in, `cat <appDir>/<scriptPath>` to read the bytes
2. Read `scripts/common.sh` from the dashboard image
3. Concat preamble + common.sh + script
4. Pipe the concatenated buffer through `bash -s`

Steps 1–3 add an SSH round-trip, a TOCTOU window (file could change between cat and exec), and mix contexts (project's script executing with dashboard's common.sh helpers — the project didn't ask for that). Remote-exec has none of these problems.

**Command shape sent over SSH**:

```bash
bash '<appDir>'/'<scriptPath>' --app-dir='<appDir>' --branch='<branch>' [--commit='<sha>'] [--no-cache] [--skip-cleanup]
```

Each quoted segment passes through `shQuote`. The existing `sshPool.execStream` handles the rest — stdout/stderr flow back through the same WS/job-manager path that feature 005 set up; `script_runs.log_file_path` captures them; `jobManager.onJobEvent(jobId, ...)` still fires on terminal status.

**Rationale**: one fewer round-trip, no file-content exposure to the dashboard, no preamble injection the project didn't consent to. Matches FR-013 / FR-041 exactly.

**Alternatives considered**:

- **SSH cat + stdin pipe**: rejected (above) — extra RTT, TOCTOU, context mixing.
- **Pre-stage script to `/tmp/` on target**: violates the feature 005 invariant "no target-side state"; also pointless since the script already IS on the target inside the repo.
- **Fetch script content from a dashboard-hosted HTTP endpoint inside a wrapper**: over-engineering, adds a network dependency in the deploy path.

---

## R-002: CLI contract propagation

**Decision**: Pass the 5 inherited flags (`--app-dir`, `--branch`, optional `--commit`, `--no-cache`, `--skip-cleanup`) unconditionally — the project script ignores the ones it doesn't understand. The serialisation is identical to feature 005 FR-011: boolean flags are bare presence (`--no-cache` when true, absent when false), string/number flags are `--name=<shQuoted-value>`.

**Argv form chosen**: `--name=<value>` (equals-form). Same as the builtin `scripts/deploy/server-deploy.sh` already accepts (confirmed via its case statement handling both `--name <value>` and `--name=<value>` — see lines 33–52 of the existing script). The equals-form is the safer default because it cannot be confused with a positional arg after a flag without a value.

**`shQuote` as the authoritative defence** (per feature 005 FR-011 / R-004): every non-boolean value is wrapped in POSIX single-quotes with embedded `'` escaped as `'\''`. This is the primary injection defence in the dispatch command; `validateScriptPath` is the secondary defence at the input layer.

**Why pass unconditional flags instead of a project-declared arg contract**:

- The dashboard doesn't know what the project script needs.
- Bash scripts ignore unknown flags gracefully (case statement default `*) shift ;;` is the norm).
- A project-declared contract would need a new manifest subfield (`argContract: ZodSchema`) and per-app form updates — significant scope bloat for dubious gain.
- Documented contract in `quickstart.md` gives projects a fixed baseline they can rely on across dashboard upgrades.

**Rationale**: invariant CLI surface = stable dispatch = zero per-project dashboard plumbing. The project's own CI / tests can validate the script handles the args correctly.

**Alternatives considered**:

- **Per-manifest-entry arg contract**: rejected (scope bloat, per above).
- **Pass no args, let the project script discover everything**: rejected — project would have to guess `appDir`, `branch`, and `commit` from the environment, creating a tighter coupling to SSH session state.
- **Pass args as env vars instead of argv** (per feature 005 FR-016 secret pattern): rejected — secrets need env because argv is world-readable via `ps`, but these values are non-sensitive (branch names, directory paths) and argv is more ergonomic for bash scripts. Argv parity with builtin matters more than transport uniformity.

---

## R-003: Where runtime re-validation lives

**Decision**: Embed `validateScriptPath` as a Zod `.refine` on the `params.scriptPath` field in the manifest entry. The existing `scripts-runner` pipeline already calls `entry.params.parse(params)` at step 2 of `runScript` — the refine fires for free, and on failure throws a ZodError that the runner already catches and converts to `status: failed` with a per-field error message (feature 005 FR-044 test suite already covers this path).

**Why `.refine` instead of an explicit pre-flight check**:

- Zero extra code — the runner's existing `params.parse(...)` call IS the re-validation.
- No new throw paths to reason about — ZodError → existing error handler → `status: failed` with `error_message = 'scriptPath failed runtime validation: <message>'`.
- Single source of truth — the manifest entry's Zod schema is the contract; the refine can't drift from what the form/API do because they import the same `validateScriptPath` helper.
- Composable — if future features add more `scriptPath`-like fields (e.g. per-app env-file path), the same pattern works.

**Fail-closed invariant** (per Q4 / FR-044 / SC-007): on refine failure the runner MUST NOT fall back to `deploy/server-deploy`. The ZodError throws before the dispatch branch is even consulted. `resolveDeployOperation` is called upstream and already chose `deploy/project-local-deploy` based on `app.scriptPath` being non-null — if that path is invalid at runtime, we want a failed deploy, not a silent downgrade.

**Rationale**: the cheapest possible runtime validator is no new validator at all — reuse the Zod schema we're already parsing.

**Alternatives considered**:

- **Explicit pre-flight call at runner entry**: rejected — duplicates the Zod parse's work, adds a new throw path.
- **Validation via a dedicated middleware**: rejected — middlewares are a route-layer concept; the runner can be invoked from other places (cron, worker, tests).
- **Skip runtime re-validation, trust the API**: rejected in clarify Q4 — DB tampering / ORM bugs / manual SQL are real attack surfaces.

---

## R-004: Normalisation placement — server-side only

**Decision**: Normalise in the route handler (`routes/apps.ts`) by calling `validateScriptPath(req.body.scriptPath)` BEFORE the Drizzle `update`. The result's `.value` (`null | string`) goes directly into the `scriptPath` column.

**Why not a Drizzle hook / model-level transform**: Drizzle doesn't have column-transform hooks (postgres-js is raw), and even if it did, putting business logic at the ORM layer hides it from PR reviewers looking at the route. The route-layer placement makes the normalisation visible at the same call site as the validation error response — one reader, one file, one mental model.

**Why not a middleware**: middlewares run before route handlers but don't have access to Zod schemas per-route; they'd have to either duplicate the knowledge of "which fields are script-paths" or become a generic "normalise all string fields" which over-generalises.

**Why server-side and not client-side**:

- Per Q3 clarification: clients that bypass the form (direct curl, integration tests, future automation, worker jobs) must not be able to poison the DB with `''`.
- Server-side normalisation means the form can be naive — it can submit `""` or `null` or omit the field, and the server produces the canonical `NULL`.

**DB CHECK constraint as the final backstop** (per Q3 / Key Entities): even with route-layer normalisation, a `CHECK (scriptPath IS NULL OR LENGTH(TRIM(scriptPath)) > 0)` on the column means a SQL migration, a test seed, or a future direct-db-access script that bypasses the route cannot persist `''`. Three layers: route normalisation → Zod refine → DB CHECK. Matches feature 005's defence-in-depth pattern.

**Rationale**: canonical NULL invariant protected at three layers with minimal code — each layer is independent and short.

**Alternatives considered**:

- **Normalise on the form only**: rejected (Q3 — bypasses).
- **Accept `''` and `NULL` as equivalent throughout**: rejected (Q3 — every query becomes `IS NULL OR = ''`).
- **Separate migration for the CHECK**: rejected — bundle with the ADD COLUMN so the invariant holds from the first moment the column exists.

---

## R-005: DB CHECK constraint mechanics

**Decision**: Single migration `0006_project_local_deploy.sql` containing `ALTER TABLE` + `ADD CONSTRAINT`. Both in a single transaction by default (postgres `BEGIN`/`COMMIT` wrapping is implicit in single-statement migrations when the driver bundles them).

**Syntax**:

```sql
ALTER TABLE "applications" ADD COLUMN "script_path" TEXT;
ALTER TABLE "applications" ADD CONSTRAINT "applications_script_path_non_empty"
  CHECK ("script_path" IS NULL OR LENGTH(TRIM("script_path")) > 0);
```

**Why `TRIM()` inside CHECK**: catches all-whitespace values (e.g. `"   "`) that might slip through if a future codepath bypasses normalisation. Without `TRIM`, `LENGTH("   ") = 3` and the CHECK passes. `LENGTH(TRIM("   ")) = 0` → CHECK fails.

**Why `LENGTH` and not `<> ''`**: Postgres treats `''` as distinct from `NULL` in `<>` comparisons, which is what we want, but `LENGTH` is more intuitive for the "at least one non-whitespace char" intent and its behaviour is identical on empty and NULL inputs (`LENGTH(NULL) = NULL` makes the first OR branch win via short-circuit). Reviewer-friendly.

**Backward compatibility**: the `ADD COLUMN` has no `NOT NULL` and no `DEFAULT`, so existing rows get `NULL` and the CHECK passes (`IS NULL` → true). No backfill needed per FR-021.

**Rollback (DOWN migration)**: `ALTER TABLE "applications" DROP COLUMN "script_path";` — documented in the migration header. The DROP is destructive; this is the same operator-review protocol features 001–006 use (migrations applied under admin oversight per CLAUDE.md rule 5).

**Rationale**: single atomic migration, invariant holds from insert-time, rollback is one-line.

**Alternatives considered**:

- **Add column first, add CHECK in a later migration**: rejected — creates a window where a bad value could be persisted between the two migrations.
- **Enforce via trigger instead of CHECK**: rejected — triggers are opaque, CHECK is declarative and visible in `\d+ applications`.
- **Use a domain type (`CREATE DOMAIN non_empty_text AS TEXT CHECK ...`)**: over-engineering for one column.

---

## R-006: Rollback confirmation dialog — component placement

**Decision**: Add `RollbackConfirmDialog.tsx` as a new component under `client/components/deployments/`. Mount it conditionally from wherever the Rollback button is wired today — in feature 005's component tree this is `RunDetail.tsx` (per-deployment rollback) and potentially `ApplicationDetail` (app-level "rollback to last good commit" flow if it exists).

**Open pattern**: use the existing dashboard dialog primitive (whatever `ConfirmDialog` / modal primitive the rest of the UI uses — `@radix-ui/react-dialog` or similar per the stack). The dialog is a thin wrapper:

```tsx
export function RollbackConfirmDialog({
  scriptPath,
  onConfirm,
  onCancel,
}: Props) {
  return (
    <Dialog>
      <DialogTitle>Rollback uses the builtin rollback script</DialogTitle>
      <DialogBody>
        <p>This app runs a project-local deploy script (<code>{scriptPath}</code>) that may apply database migrations, cache warmups, or other changes that can't be undone by a simple git reset.</p>
        <p>The builtin rollback only reverts the git state and restarts containers. Any migrations or side-effects from the last deploy will remain.</p>
        <p>Continue anyway?</p>
      </DialogBody>
      <DialogActions>
        <Button onClick={onCancel}>Cancel</Button>
        <Button variant="destructive" onClick={onConfirm}>Rollback</Button>
      </DialogActions>
    </Dialog>
  );
}
```

**Why conditional** (per Q1 / FR-024): apps without `scriptPath` retain today's rollback UI unchanged — no regression (FR-024 last sentence).

**Why two action styles**: the `Rollback` button uses `variant="destructive"` to visually match other "proceed despite warning" dashboard UX. Cancel is the default / safe option.

**Accessibility**: per the existing dashboard primitive, the dialog traps focus, restores focus on close, and is dismissable via Escape. No special work for this feature.

**Rationale**: one new component, zero changes to the rollback API contract, zero changes for null-scriptPath apps.

**Alternatives considered**:

- **Block rollback entirely** (Q1 Option C): rejected — too restrictive; operator agency matters.
- **Silent documentation only** (Q1 Option A): rejected — fails SC-005 (incident-class "I didn't know rollback wouldn't undo the migration").
- **Surface the warning inline in the Rollback button tooltip**: rejected — tooltips are not screen-reader-reliable and dismissable-by-accident; a dialog is the load-bearing signal.

---

## R-007: Script identity surface — UI rendering

**Decision**: Add one shared render helper `renderScriptIdentity(run: ScriptRun)` used by both `RunDetail.tsx` header and `RunsPage.tsx` list rows. For `scriptId === "deploy/project-local-deploy"`, render a small `project-local` badge followed by the monospace path string. For all other script ids, render the id verbatim as today.

**Badge colour / variant**: use the existing dashboard's `Badge` component with `variant="secondary"` (or whichever neutral / informational variant matches the design system). NOT `destructive` or `warning` — the badge is informational, not a caution. The dangerLevel decision (Q2) says project-local is parity-with-builtin, so the UI should not imply heightened risk.

**Log viewer header**: `RunDetail.tsx` already renders the script identity at the top of the live-log pane (feature 005's `ScriptNameHeader` or similar). Swap in the new helper.

**Filter behaviour on Runs page**: per FR-033, operators should be able to eyeball project-local runs. The badge is sufficient; no separate filter column is required in v1. If operators later demand a filter, it's a RunsPage.tsx increment — not architectural.

**Rationale**: one helper, two call sites, zero new components beyond the helper itself.

**Alternatives considered**:

- **New `ScriptIdentityBadge` component**: over-engineering for 10 lines of JSX.
- **Separate filter chip row on Runs page**: deferred (FR-033 accepts a visual distinguisher; chip is polish, not contract).
- **Render `<scriptPath>` without a badge, just prefix the string with `project-local:`**: rejected — loses the at-a-glance visual scan.

---

## R-008: Feature 003 scan — regression-prevention test only

**Decision**: No production-code change to the scan flow. Add `tests/integration/scan-leaves-script-path-null.test.ts` that runs the scan against a fixture repo containing a file matching every "obvious heuristic name" (`scripts/devops-deploy.sh`, `scripts/server-deploy-prod.sh`, `deploy.sh`) and asserts every created `applications` row has `scriptPath = null`.

**Why this is sufficient** (per Q5 / FR-025): the current scan code has no scriptPath-probing logic — it simply doesn't read or write the column. The test exists to fail loudly if a future PR adds such logic without updating the spec. The test is cheap (one scan invocation + one DB read).

**Failure mode**: if the test fails, the diff will reveal the new probe/populate logic; the PR author must either:

1. Remove the probe (honour FR-025), OR
2. Amend the spec to change FR-025 (scan-auto-set becomes a feature, not a defect), update this plan, update `quickstart.md`, and re-run `/speckit.clarify`.

**Rationale**: enforce the spec boundary via test, not via code. The scan code doesn't need to know about scriptPath at all.

**Alternatives considered**:

- **No test**: rejected — FR-025 becomes unenforced; future drift possible.
- **Assertion in scan code itself (`assert(scriptPath === undefined)`)**: rejected — assertions on absence of behaviour are anti-patterns; the test is the right place.
- **Block scan PRs that touch `scriptPath`**: can't do this at the repo level without owner/review rules that are orthogonal to the feature.

---

## Summary

All 8 research items resolved. No `[NEEDS CLARIFICATION]` remain. Zero new npm dependencies. Zero new SSH / protocol primitives. Zero new persistence concepts beyond one nullable column.

The surface of this feature is deliberately small: **one column, one manifest entry, one dispatch branch, one transport-kind branch, one UI dialog, one UI helper**. Everything else is reused from features 001–006.

Proceed to Phase 1 (`data-model.md`, `contracts/`, `quickstart.md`).
