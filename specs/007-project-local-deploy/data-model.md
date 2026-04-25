# Data Model: Project-Local Deploy Script Dispatch

**Phase 1 output** | **Date**: 2026-04-24

---

## Modified entity: `applications` (one new column)

| Column | Type | Constraint | Source |
|--------|------|-----------|--------|
| `script_path` | `TEXT` | `NULL` allowed, default `NULL`, CHECK `IS NULL OR LENGTH(TRIM(...)) > 0` | FR-001, FR-003, Q3 |

All other columns are unchanged. The new column is additive; no existing column is dropped, renamed, or retyped.

### Semantics

- `script_path IS NULL` → "use builtin deploy dispatch" (`deploy/server-deploy` or `deploy/deploy-docker` depending on app metadata per feature 005 `resolveDeployOperation`).
- `script_path IS NOT NULL` → "dispatch to `deploy/project-local-deploy`". The string is a relative path from `remotePath` on the target to the project's own deploy script (e.g. `scripts/server-deploy-prod.sh`).

### Invariants

1. **Canonical NULL**: the column never stores `''` or all-whitespace. Enforced at three layers — route normalisation, Zod `.refine`, DB CHECK. Any codepath violating this is a bug.
2. **Validation**: non-NULL values pass `validateScriptPath` — relative, no `..`, no shell metacharacters, ≤ 256 bytes. Same rules at write-time and runtime (FR-003, FR-044).
3. **No backfill**: migration 0006 adds the column with NULL default; existing rows stay NULL. Operators explicitly opt in via Edit Application per FR-021 / FR-025.
4. **Audit captured**: every create/update of an application captures `script_path` in the feature 005 audit middleware (FR-042). Non-secret — no redaction.

### Drizzle schema fragment (added to `devops-app/server/db/schema.ts`)

```ts
// in the applications table definition:
scriptPath: text("script_path"),   // nullable by default; CHECK enforced via migration
```

Drizzle's TypeScript type will be `string | null`, matching the server-side `ValidateResult['value']` union.

---

## New manifest entry: `deploy/project-local-deploy`

Added to `devops-app/server/scripts-manifest.ts` (not a DB table, but listed here because it's the other side of the dispatch contract).

```ts
{
  id: "deploy/project-local-deploy",
  category: "deploy",
  description: "Deploy via a project-local script (overrides builtin)",
  locus: "target",
  requiresLock: true,                             // FR-011 — same lock pool as builtin deploy
  timeout: 1_800_000,                             // 30 min, parity with builtin
  dangerLevel: "low",                             // FR-011, Q2 — parity with builtin
  params: z.object({
    appDir: z.string(),
    scriptPath: z.string().refine(
      (s) => validateScriptPath(s).ok && validateScriptPath(s).value !== null,
      "Invalid scriptPath"
    ),
    branch: z.string().regex(BRANCH_REGEX),       // reuses BRANCH_REGEX from feature 005
    commit: z.string().regex(SHA_REGEX).optional(),
    noCache: z.boolean().default(false),
    skipCleanup: z.boolean().default(false),
  }),
}
```

The `validateScriptPath` refinement IS the runtime re-validation (FR-044). It's called by `scripts-runner.runScript` when it parses the dispatch params; failure throws a ZodError which the runner's existing handler converts to `status: failed` with a clear error message.

---

## Unchanged entity: `script_runs` (dual-writes, no schema change)

Every project-local deploy writes a `script_runs` row with:

- `script_id = "deploy/project-local-deploy"`
- `params` = the dispatch params (appDir, scriptPath, branch, commit?, noCache, skipCleanup) — none are secret, no masking needed
- `deployment_id` = non-null (project-local IS a deploy; same dual-write as builtin per FR-031)
- All other fields identical to builtin deploy semantics

**No schema change to `script_runs`**. Feature 005's FR-040 explicitly designed `script_id` as plain text (not an FK) so new manifest entries don't require table changes.

---

## Migration: `0006_project_local_deploy.sql`

```sql
-- ─────────────────────────────────────────────────────────────────────────────
-- Feature 007: project-local deploy script dispatch
--
-- Adds applications.script_path (nullable TEXT) with a CHECK constraint that
-- rejects empty strings and all-whitespace values at the database layer.
-- This is the innermost ring of three-layer defence (route normalisation +
-- Zod .refine + CHECK). Any codepath that bypasses the first two still cannot
-- persist a non-canonical "no override" value.
--
-- Non-destructive: ADD COLUMN with NULL default. All existing rows stay NULL.
-- No backfill; operators opt in via Edit Application per FR-021 / FR-025.
--
-- DOWN migration (destructive — review before applying):
--   ALTER TABLE "applications" DROP COLUMN "script_path";
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE "applications"
  ADD COLUMN "script_path" TEXT;

ALTER TABLE "applications"
  ADD CONSTRAINT "applications_script_path_non_empty"
  CHECK ("script_path" IS NULL OR LENGTH(TRIM("script_path")) > 0);
```

### Verification queries (run post-migration as part of release verification)

```sql
-- 1. Column exists, nullable, no default
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_name = 'applications' AND column_name = 'script_path';
-- Expected: script_path | text | YES | NULL

-- 2. CHECK constraint exists
SELECT conname, pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conrelid = 'applications'::regclass
  AND conname = 'applications_script_path_non_empty';
-- Expected: one row with definition = CHECK ((script_path IS NULL) OR (length(btrim(script_path)) > 0))

-- 3. No existing row violates the invariant (should be 0)
SELECT COUNT(*)
FROM applications
WHERE script_path IS NOT NULL AND LENGTH(TRIM(script_path)) = 0;
-- Expected: 0

-- 4. No existing row has a pre-set value (sanity — confirms no backfill happened)
SELECT COUNT(*)
FROM applications
WHERE script_path IS NOT NULL;
-- Expected: 0 immediately post-migration; grows as operators opt in
```

### Rejection smoke-test (post-migration, before release)

```sql
-- Each of these should error with "new row violates check constraint"
UPDATE applications SET script_path = '' WHERE id = (SELECT id FROM applications LIMIT 1);
UPDATE applications SET script_path = '   ' WHERE id = (SELECT id FROM applications LIMIT 1);
UPDATE applications SET script_path = E'\t\n' WHERE id = (SELECT id FROM applications LIMIT 1);

-- These should succeed (setting NULL is allowed)
UPDATE applications SET script_path = NULL WHERE id = (SELECT id FROM applications LIMIT 1);
UPDATE applications SET script_path = 'scripts/devops-deploy.sh' WHERE id = (SELECT id FROM applications LIMIT 1);
-- Then revert:
UPDATE applications SET script_path = NULL WHERE id = (SELECT id FROM applications LIMIT 1);
```

Put this in the release runbook, not in the migration file — we don't want the verification UPDATEs to run in production as part of the migration.

---

## Query catalogue

Every downstream query on `applications.script_path` uses the two-state contract (`NULL` vs present). No query should contain `WHERE script_path = ''` — the CHECK constraint makes that value unreachable, but the query pattern is forbidden as a readability discipline (Key Entities note in spec).

### `resolveDeployOperation` dispatch check

```ts
// NOT a SQL query — a JS predicate over the already-loaded application row.
if (app.scriptPath) {
  return { scriptId: "deploy/project-local-deploy", params: { ..., scriptPath: app.scriptPath } };
}
// ... existing branches ...
```

`app.scriptPath` is `string | null`; truthy iff non-null. JS's type coercion aligns with the DB invariant — `""` is impossible, so no `&& app.scriptPath.length > 0` check needed.

### Applications list / detail fetch

No SELECT changes — existing `SELECT * FROM applications WHERE ...` already returns `script_path` once the column exists. The API response includes `scriptPath: string | null` after the route handler's snake-case → camelCase conversion (feature 001's convention).

### Runs page query (for FR-033 identity surface)

Unchanged — `script_runs.script_id` is already in the SELECT. The UI does the render-branch on the client side per R-007.

```sql
-- Existing feature 005 query, no changes:
SELECT id, script_id, server_id, deployment_id, user_id,
       status, started_at, finished_at, duration,
       params, error_message
FROM script_runs
ORDER BY started_at DESC
LIMIT 50 OFFSET $1;
```

---

## Entity lifecycle

The `applications.script_path` field has the simplest possible lifecycle:

```
(application created)
  script_path = NULL
     │
     ├── Admin edits app and sets non-empty scriptPath
     │     └── script_path = '<validated-path>'
     │           │
     │           ├── Admin clears the field (submits "" or NULL)
     │           │     └── script_path = NULL  (back to builtin dispatch)
     │           │
     │           └── Admin changes to a different path
     │                 └── script_path = '<new-validated-path>'
     │
     └── Application deleted → row removed (no special handling for script_path)
```

No state machine, no transition events, no history table. The column IS the state.

---

## Scale / volume

- One new column per `applications` row. Size impact: ≤ 256 bytes × ~100 apps ≈ 25 KB. Negligible.
- Zero new indexes. Dispatch check is `WHERE id = $1` which hits the existing PK; `scriptPath` is only read, never filtered on.
- No new table, no retention concern.

---

## Summary

- **One new column** (`applications.script_path`) with a CHECK constraint.
- **No new table**.
- **No new index**.
- **No schema change to `script_runs`** — new dispatch kind reuses the existing `script_id` plain-text design.
- **One new manifest entry** (in TypeScript, not SQL) — `deploy/project-local-deploy`.
- **Migration `0006_project_local_deploy.sql`** — additive, reviewable, ≤ 15 lines + header comment.

All FR references:

| FR | Data-model impact |
|---|---|
| FR-001 | `applications.script_path` column exists, nullable |
| FR-003 | CHECK constraint + Zod refine + route normalisation |
| FR-011 | Manifest entry has `requiresLock: true`, `timeout: 1_800_000`, `dangerLevel: "low"` |
| FR-012 | Zod schema in manifest entry matches the documented params |
| FR-021 | Migration adds no backfill; existing rows stay NULL |
| FR-030 | `script_runs.script_id = "deploy/project-local-deploy"` on every dispatch |
| FR-031 | Dual-write with `deployments` reuses feature 005's pattern (no schema change) |
| FR-042 | Audit middleware captures `script_path` on create/update (non-secret field, no redaction) |
| FR-044 / SC-007 | Zod refine fires on every dispatch; ZodError → `status: failed` |

Proceed to `contracts/api.md`.
