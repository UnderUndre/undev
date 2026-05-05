# Data Model: Operational Maturity

**Date**: 2026-05-05 | **Branch**: `010-operational-maturity` | **Plan**: [plan.md](plan.md)

Canonical reference for schema additions introduced by feature 010.
Every column / constraint / audit-event-type here MUST appear in
`devops-app/server/db/migrations/0011_operational_maturity.sql` and
`devops-app/server/db/schema.ts`. Drift = test failure.

---

## Modified entities

### `applications` — 4 new hook columns

| Column | Type | Null | Default | FR | Notes |
|---|---|---|---|---|---|
| `pre_deploy_script_path` | TEXT | yes | NULL | FR-006, FR-007 | Relative path inside repo, validated by feature 007 regex pattern. Invoked AFTER git fetch+reset, BEFORE compose-up. Non-zero exit aborts deploy. |
| `post_deploy_script_path` | TEXT | yes | NULL | FR-006, FR-008 | Invoked AFTER successful compose-up. Non-zero exit marks deploy `failed` but does NOT roll back compose state. |
| `on_fail_script_path` | TEXT | yes | NULL | FR-006, FR-009 | Invoked when any earlier deploy step fails. Hook failure logged at warn, never propagated up. |
| `pre_destroy_script_path` | TEXT | yes | NULL | FR-006, FR-010 | Invoked BEFORE hard-delete (compose-down + rm). Failure ABORTS the hard-delete. |

**Validation per column** (FR-013 + feature 007 FR-003 pattern):

- Regex: `^(?!\/)(?!.*\.\.)(?!.*[;|&$()<>{}[\]\\]).*\.sh$` (no leading
  `/`, no `..`, no shell metachars, must end `.sh`)
- Length: ≤ 256 characters
- NULL normalisation: empty string `""` from form input MUST be coerced
  to NULL at all three layers (form / route / runner)

### `applications` — extended `created_via` enum

```sql
-- Before (feature 009):
CHECK (created_via IN ('manual', 'scan', 'bootstrap'))

-- After (this feature):
CHECK (created_via IN ('manual', 'scan', 'bootstrap', 'migrate'))
```

| Value | Origin | Notes |
|---|---|---|
| `manual` | Add Application form | Operator typed everything |
| `scan` | Feature 003 scan-for-repos auto-discovery | Stub row, may be PATCH-promoted to fuller state via US6 |
| `bootstrap` | Feature 009 BootstrapWizard | Fresh app from GitHub repo |
| `migrate` | This feature's Migration Toolkit (US6) | Existing manually-configured app adopted via wizard |

`migrate` only set on INSERT path of `migration-toolkit.ts:adopt`. The
PATCH-promote path on a `created_via='scan'` row preserves the original
`created_via='scan'` value (per Session 2026-05-05 clarification +
FR-033a) — origin metadata kept for forensics.

---

## New constraint: mutual exclusion (FR-013a layer 4)

```sql
ALTER TABLE "applications" ADD CONSTRAINT "applications_script_path_hooks_mutex"
  CHECK (
    "script_path" IS NULL
    OR (
      "pre_deploy_script_path" IS NULL
      AND "post_deploy_script_path" IS NULL
      AND "on_fail_script_path" IS NULL
      AND "pre_destroy_script_path" IS NULL
    )
  );
```

**Semantics**:

- `script_path = NULL`: any combination of hooks valid (zero or more).
- `script_path != NULL`: ALL four hook columns MUST be NULL.

**Rationale**: defence-in-depth layer 4. Layers 1-3 (Zod at form / route /
runner) catch the 99.9% case. The CHECK catches the 0.1% — direct
`psql` writes during data migration / disaster recovery / debug session.

**Cost**: zero on existing data. The four hook columns don't exist
before this migration, so every row has them NULL. The constraint adds
without scanning data.

---

## Modified entity: `audit_entries` — new event types

Existing schema unchanged. The `auditMiddleware` catalogue gains four
new action strings:

| Action | Payload shape |
|---|---|
| `app.hooks_changed` | `{ appId, addedHooks: string[], removedHooks: string[], changedHooks: string[] }` (paths only — paths are not secret, but no values, no scripts) |
| `app.migrated_from_scan` | `{ appId, originServerId, originRemotePath, addedFields: string[] }` (PATCH-promote of scan row) |
| `app.migrated` | `{ appId, serverId, remotePath, repoUrl?, composePath? }` (new INSERT via migration toolkit) |
| `app.cross_server_domain_confirmed` | `{ appId, domain, conflicts: Array<{ otherAppId, otherServerId, otherServerLabel, otherCertStatus }> }` (operator typed-confirm proceeded despite cross-server conflict) |
| `app.hard_deleted_force_bypass` | `{ appId, skippedHookPath, skipReason: "operator_force_bypass", exitCode?: number, sshStderr?: string }` (operator chose `?force=true` after `pre_destroy` hook failed; emitted SEPARATELY from regular `app.hard_deleted` for forensic distinction per Session 2026-05-05 review GE-2 + R-008a) |

**Cross-feature note**: feature 011 introduces 9 new audit event types.
When both branches merge to main, the catalogue contains all 13
(9 from 011 + 4 from this).

---

## In-memory state shapes (no DB)

### Hook dispatch state (inside `scripts-runner.ts`)

Not persisted. Each deploy run holds a transient sequence:

```ts
interface DeployHookContext {
  preDeploy?: { path: string; exitCode: number; durationMs: number };
  composeUp: { exitCode: number; durationMs: number };
  postDeploy?: { path: string; exitCode: number; durationMs: number };
  onFail?: { path: string; exitCode: number; durationMs: number };
}
```

This context is included in the existing `script_runs.params` JSONB for
forensic visibility (NEVER includes hook script CONTENTS, only paths
+ outcomes).

### `FailureAction` discriminated union

Lives in `client/components/failure/FailureCard.tsx` AND mirrored as a
Zod schema in `server/lib/failure-state-mapper.ts` for state-token
validation (the runtime parses backend-supplied state strings and maps
them to action arrays).

```ts
export type FailureAction =
  | { kind: "Retry"; href?: string; onClick?: () => void }
  | { kind: "RetryFromFailedStep"; fromStep: string; href?: string; onClick?: () => void }
  | { kind: "EditConfig"; href: string }
  | { kind: "ViewLog"; href: string }
  | { kind: "HardDelete"; onClick: () => void }
  | { kind: "ForceRenew"; onClick: () => void }
  | { kind: "Revoke"; onClick: () => void }
  | { kind: "Custom"; label: string; href?: string; onClick?: () => void };
```

The `kind` discriminator is the single source of UX vocabulary
(SC-003). `Custom` carries a `label: string` for one-off context-specific
actions only.

---

## Cross-feature interactions

### Feature 001 — auditMiddleware

`audit_entries` schema unchanged; this feature adds 4 entries to the
allowed-actions catalogue. The existing redact policy (no decrypted
secrets in `details` JSON) applies to all new event types.

### Feature 003 — scan-for-repos

Migration toolkit (US6) calls scan output for path autocomplete on the
wizard. PATCH-promote path (FR-033a) preserves
`created_via='scan'` on rows that were originally created by scan.

### Feature 005 — scripts_runner

The single integration point for all 4 hook dispatch points. No new
manifest entries — hooks are bash invocations of operator-supplied
relative paths, dispatched via the existing `executeWithStdin` +
`shQuote` secret-transport convention.

### Feature 007 — script_path

Hook column validation regex AND NULL normalisation reuse feature 007's
`script_path` pattern. The mutual-exclusion CHECK (FR-013a) is the new
constraint added on top.

### Feature 008 — hard-delete-app

`hard-delete-with-hooks.ts` decorator wraps `feature008/hard-delete-app.ts`.
Original service unchanged. Routes that adopt `pre_destroy` semantics
switch the import to the wrapper.

### Feature 009 — BootstrapWizard + bootstrap-hard-delete

US1 mounts feature 009's wizard component into `AppsTab.tsx`.
`hard-delete-with-hooks.ts` decorator also wraps
`feature009/bootstrap-hard-delete.ts` for apps with `created_via='bootstrap'`.
Compose parser from feature 009 reused by Migration Toolkit (US6).

---

## Index strategy

No new indexes for this feature. Existing indexes cover the access
patterns:

- `audit_entries (occurred_at DESC)` from feature 001 — sufficient for
  faceted query time-range scan up to ~100k rows.
- `applications (server_id, remote_path)` UNIQUE from features 001/008
  — sufficient for migration-toolkit collision detection.

If audit query latency becomes problematic at 1M+ rows (post-rollout
metric), v2 may add a `(actor, occurred_at DESC)` partial index.

---

## Validation rules summary

| FR | Rule | Enforced by |
|---|---|---|
| FR-006 | Hook path matches feature 007 regex + length cap | Zod refinement in `script-hook-validator.ts` (form + route layers) |
| FR-007 | `pre_deploy` runs after git, before compose | `scripts-runner.ts` linear sequence |
| FR-008 | `post_deploy` runs after compose-up; failure marks deploy failed but no rollback | `scripts-runner.ts` exit-code branch |
| FR-009 | `on_fail` runs only when earlier step failed; warn-only failure | `scripts-runner.ts` conditional + log level |
| FR-010 | `pre_destroy` runs before hard-delete; failure aborts | `hard-delete-with-hooks.ts` decorator |
| FR-011 | All hooks receive same env exports as builtin deploy | `scripts-runner.ts` shared env builder |
| FR-013 | Hook validation at form / route / runner | `script-hook-validator.ts` reused at 3 layers |
| FR-013a | Mutual exclusion script_path ↔ hooks at 4 layers | Zod ×3 + DB CHECK constraint |
| FR-014 | FailureCard typed prop contract | TypeScript discriminated union |
| FR-019 | Cross-server domain conflict query | `cross-server-domain-check.ts` parameterised query |
| FR-021 | Typed-confirm via domain name string | Frontend dialog state validation + server-side re-check on submit |
| FR-025 | Audit query page cap 100, total cap 10000 | `audit-query.ts` hard limits |
| FR-027 | Export CSV streams (no full-buffer) | `audit-query.ts:streamCsv` + `res.write` chunks |
| FR-032 | `created_via='migrate'` enum extension | Migration `0011_operational_maturity.sql` |
| FR-033 | Migration emits audit entry with full snapshot | `migration-toolkit.ts:adopt` audit emit |
| FR-033a | Scan-row PATCH-promote preserves `created_via='scan'` | `migration-toolkit.ts:augmentExisting` skips `created_via` UPDATE |

---

## Migration test fixtures

`tests/fixtures/applications-pre-0011.ts` — pre-migration row shapes
asserting backward-compat:

```ts
export const APP_ROW_PRE_0011 = {
  id: "app_legacy",
  // ... existing columns ...
  scriptPath: null,
  createdVia: "manual",
  // (no hook columns yet)
};

export const APP_ROW_POST_MIGRATE = {
  // After ALTER TABLE 0011, new columns present:
  preDeployScriptPath: null,
  postDeployScriptPath: null,
  onFailScriptPath: null,
  preDestroyScriptPath: null,
  // mutex CHECK satisfied (script_path NULL OR all hooks NULL — all NULL holds both)
};

export const APP_ROW_POST_FIRST_HOOK_EDIT = {
  // After PATCH /apps/:id with { preDeployScriptPath: "scripts/migrate-db.sh" }:
  scriptPath: null,
  preDeployScriptPath: "scripts/migrate-db.sh",
  postDeployScriptPath: null,
  onFailScriptPath: null,
  preDestroyScriptPath: null,
};

export const APP_ROW_FORBIDDEN = {
  // Constraint violation — should never persist:
  scriptPath: "scripts/full-deploy.sh",
  preDeployScriptPath: "scripts/migrate-db.sh",  // ← VIOLATES mutex CHECK
  // ... rest NULL ...
};
```

Same pattern applied to assertion of `created_via='migrate'` enum
acceptance after migration.
