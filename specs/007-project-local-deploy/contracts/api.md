# API Contract: Project-Local Deploy Script Dispatch

**Version**: 1.0 | **Date**: 2026-04-24

## Scope

Three existing endpoints gain a new field (`scriptPath`) in their request/response shapes. One manifest descriptor entry is added to the response of `GET /api/scripts/manifest`. No new endpoints. No new error codes beyond the reuse of `INVALID_PARAMS` with a new field path.

All endpoints continue to require `requireAuth` and continue to be captured by `auditMiddleware` — `scriptPath` is included in `audit_entries.details` as a non-secret field (no redaction).

---

## Modified endpoints

### `POST /api/apps` (Create Application)

**Request body — new field**:

```jsonc
{
  "name": "ai-digital-twins",
  "serverId": "srv-1",
  "remotePath": "/opt/ai-digital-twins",
  "repoUrl": "git@github.com:example/ai-digital-twins.git",
  "branch": "main",
  "source": "manual",
  "skipInitialClone": false,
  "scriptPath": "scripts/devops-deploy.sh"    // ← NEW — optional
}
```

**Field rules** (enforced by `validateScriptPath` server-side):

- Type: `string | null | undefined` (all three normalise to the same DB state).
- `null`, `undefined`, `""`, all-whitespace → persisted as `NULL`.
- Non-empty: must be relative, no `..`, no shell metacharacters, ≤ 256 bytes.

**Response 201**: same shape as before, with `scriptPath: string | null` added.

**Response 400 `INVALID_PARAMS`** — `scriptPath` failed validation:

```json
{
  "error": {
    "code": "INVALID_PARAMS",
    "message": "Parameter validation failed",
    "details": {
      "fieldErrors": {
        "scriptPath": ["Path cannot contain parent-directory traversal"]
      }
    }
  }
}
```

Error message comes verbatim from `validateScriptPath`'s `.error` value. Clients should render the exact string — it's translated/localised at the source if needed (out of scope for v1).

### `PATCH /api/apps/:id` (Edit Application)

**Request body — new field**:

Same as `POST`. Omitted field = "don't touch" (standard PATCH semantics). Explicit `null` = "clear the override, fall back to builtin".

```jsonc
// Enable project-local deploy
{ "scriptPath": "scripts/server-deploy-prod.sh" }

// Disable project-local deploy (fall back to builtin)
{ "scriptPath": null }

// Also accepted — normalised to null server-side:
{ "scriptPath": "" }
{ "scriptPath": "   " }
```

**Response 200**: full updated application row including `scriptPath: string | null`.

**Response 400 `INVALID_PARAMS`**: same shape as POST.

### `GET /api/apps/:id` (Read Application)

**Response 200 — new field**:

```jsonc
{
  "id": "app-123",
  "name": "ai-digital-twins",
  // ... existing fields ...
  "scriptPath": "scripts/devops-deploy.sh"    // ← NEW — null when no override
}
```

`scriptPath` is always present in the response (not omitted when null) — clients can branch on `scriptPath === null` unambiguously.

### `GET /api/apps` (List Applications)

Same — `scriptPath` is always in each row of the response array.

### `GET /api/scripts/manifest` (Feature 005 Manifest Descriptor)

**Response 200 — new entry appended to the `scripts` array**:

```jsonc
{
  "scripts": [
    // ... existing entries ...
    {
      "id": "deploy/project-local-deploy",
      "category": "deploy",
      "description": "Deploy via a project-local script (overrides builtin)",
      "locus": "target",
      "requiresLock": true,
      "timeout": 1800000,
      "dangerLevel": "low",
      "outputArtifact": null,
      "fields": [
        { "name": "app-dir",      "type": "string",  "required": true,  "isSecret": false },
        { "name": "script-path",  "type": "string",  "required": true,  "isSecret": false },
        { "name": "branch",       "type": "string",  "required": true,  "isSecret": false },
        { "name": "commit",       "type": "string",  "required": false, "isSecret": false },
        { "name": "no-cache",     "type": "boolean", "required": false, "default": false, "isSecret": false },
        { "name": "skip-cleanup", "type": "boolean", "required": false, "default": false, "isSecret": false }
      ]
    }
  ]
}
```

**UI consumption**: the dashboard's Scripts tab on each server page will automatically surface this entry (since feature 005 renders every `locus: "target"` manifest entry). Operators who want to run the operation manually — outside the app-level Deploy button — can use the generic Run dialog. The required `scriptPath` field in this generic form is a safety valve; day-to-day the app-level Deploy button fills it automatically from the `applications` row.

---

## Unchanged endpoints (behaviour changes, contract stable)

### `POST /api/apps/:id/deploy`

Client contract unchanged — same URL, same request body, same 201 response shape. Internally:

- Reads `applications.scriptPath`.
- Calls `resolveDeployOperation(app, runParams)` which returns one of three `scriptId` values now (was two): `deploy/server-deploy`, `deploy/deploy-docker`, or the new `deploy/project-local-deploy`.
- Rest of the flow is identical to feature 005.

The dispatched `scriptId` is visible in the response's `runId` → `GET /api/runs/:id.scriptId` for clients that want to know.

### `POST /api/apps/:id/rollback`

Client contract unchanged — same URL, same request body, same 201 response shape. Internally unchanged — always dispatches `deploy/server-rollback` regardless of `scriptPath`.

**New client-side concern (not a contract change)**: the dashboard UI MUST read `application.scriptPath` before calling this endpoint and MUST show the `RollbackConfirmDialog` when non-null (FR-024). Third-party API callers are not obligated to show a dialog — they get the same "rollback may not undo project-specific changes" information via the application row's `scriptPath` field and can warn their own users however they choose.

### `GET /api/runs/:id` and `GET /api/runs`

No contract change. The response's existing `scriptId` and `params` fields carry the new dispatch identity for project-local deploys — UI branches on `run.scriptId === "deploy/project-local-deploy"` per R-007.

---

## Failure modes

### Write-time validation failure (400)

| Input | Field Error |
|-------|-------------|
| `"/etc/passwd"` | `"Must be a relative path inside the repo"` |
| `"../../bin/rm"` | `"Path cannot contain parent-directory traversal"` |
| `"scripts/foo;rm -rf /"` | `"Path contains characters that are not allowed"` |
| `"scripts/$(id)"` | `"Path contains characters that are not allowed"` |
| `"scripts/foo\nbar"` | `"Path contains characters that are not allowed"` |
| `"aaaa..."` (> 256 bytes) | `"Path must be ≤256 bytes"` |
| `""` | *normalised to null, accepted* |
| `"   "` | *normalised to null, accepted* |

All surface as `400 INVALID_PARAMS` with `details.fieldErrors.scriptPath` populated.

### Runtime validation failure at dispatch (script_runs row with status=failed)

If `applications.script_path` was poisoned after the API write (direct SQL, ORM bug, migration drift), the next deploy fails at Zod refine time inside the runner:

```jsonc
// GET /api/runs/<failed-run-id>
{
  "id": "run-789",
  "scriptId": "deploy/project-local-deploy",
  "serverId": "srv-1",
  "status": "failed",
  "errorMessage": "scriptPath failed runtime validation: contains parent-directory traversal",
  "params": {
    "appDir": "/opt/ai-digital-twins",
    "scriptPath": "../../evil",       // ← the tampered value is preserved for forensics
    "branch": "main",
    "noCache": false,
    "skipCleanup": false
  },
  "startedAt": "2026-04-24T...",
  "finishedAt": "2026-04-24T..."   // same timestamp; rejection is synchronous
}
```

The runner does NOT establish SSH, does NOT invoke `bash`, does NOT fall back to `deploy/server-deploy`. Per Q4 / FR-044 / SC-007 fail-closed contract.

### Deploy dispatches while `scriptPath` points to a non-existent file on target

Runner builds the command, SSHs in, executes `bash <appDir>/<scriptPath> ...`. Bash exits 127 with stderr `bash: ...: No such file or directory`. Standard failure path:

```jsonc
// GET /api/runs/<failed-run-id>
{
  "status": "failed",
  "exitCode": 127,
  "errorMessage": "bash: /opt/ai-digital-twins/scripts/devops-deploy.sh: No such file or directory",
  // ...
}
```

Per clarification 2026-04-23 "No pre-flight in v1 — rely on exit code".

---

## Wire format (camelCase / snake_case mapping)

All API fields use **camelCase**. The DB column is `script_path` (snake_case) per existing convention. The route handler performs the conversion in both directions; the client never sees `script_path`.

| Layer | Name |
|-------|------|
| DB column | `script_path` |
| Drizzle schema field | `scriptPath` |
| API request/response JSON key | `scriptPath` |
| Client form input `name` attribute | `scriptPath` |
| Manifest descriptor `fields[].name` | `script-path` (kebab-case per feature 005's descriptor convention) |

The kebab-case in the manifest descriptor is because feature 005's generic Run dialog renders form field names as `--<kebab>` flags — it's not a bug, it's the argv contract.

---

## Summary

- **3 endpoints** modified (POST /api/apps, PATCH /api/apps/:id, GET /api/apps /:id — plus list) — new optional `scriptPath` field, normalised + validated server-side.
- **1 endpoint** gains a new entry in its response (GET /api/scripts/manifest).
- **2 endpoints** unchanged at the contract level but with new internal dispatch branch (deploy) and new client-side confirmation dialog (rollback).
- **0 new endpoints**.
- **0 new error codes** (reuse `INVALID_PARAMS`).
- **Three-layer validation** (route normalisation + Zod refine + DB CHECK) — any bypass at one layer caught at the next.

Proceed to `quickstart.md`.
