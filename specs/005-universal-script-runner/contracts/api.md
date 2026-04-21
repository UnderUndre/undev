# API Contract: Universal Script Runner

**Version**: 1.0

## Scope

Four new HTTP endpoints plus one internal service API. Existing `/api/apps/:id/deploy` and `/api/apps/:id/rollback` endpoints keep their client-visible contract but internally delegate to the new runner.

---

## New HTTP endpoints

All under `/api`, all require `requireAuth`, all subject to `auditMiddleware`.

### `GET /api/scripts/manifest`

Returns the runnable operations catalogue (presentation descriptor, not the live Zod schema).

**Response 200**:

```json
{
  "scripts": [
    {
      "id": "db/backup",
      "category": "db",
      "description": "Backup a Postgres database",
      "locus": "target",
      "requiresLock": false,
      "timeout": 1800000,
      "dangerLevel": null,
      "outputArtifact": { "type": "file-path", "captureFrom": "stdout-last-line" },
      "fields": [
        { "name": "database-name",    "type": "string", "required": true,  "isSecret": false },
        { "name": "retention-days",   "type": "number", "required": false, "default": 30, "isSecret": false }
      ]
    }
  ]
}
```

Only `locus === "target"` entries are returned. Local / bootstrap entries exist server-side but are not exposed here in v1.

### `POST /api/scripts/*/run`

Execute a script against a server.

**URL param**: the manifest entry id follows `/api/scripts/` and is captured as a wildcard — Express splits path segments on `/` before matching named params, so `POST /api/scripts/db/backup/run` matches with `req.params[0] === "db/backup"` (or `req.params.id` with an Express 5 `:id(.+)` pattern). URL-encoded `%2F` is NOT used — the id is expressed natively in the URL path. Invalid ids (not in manifest) → 404 `SCRIPT_NOT_FOUND`.

**Request body**:

```json
{
  "serverId": "srv-1",
  "params": { "databaseName": "mydb", "retentionDays": 30 }
}
```

**Response 201**:

```json
{
  "runId": "7f3b2c10-…",
  "jobId":  "job-4829",
  "status": "running"
}
```

**Response 400 `INVALID_PARAMS`** — Zod validation failed:

```json
{
  "error": {
    "code": "INVALID_PARAMS",
    "message": "Parameter validation failed",
    "details": {
      "fieldErrors": {
        "databaseName": ["Required"]
      }
    }
  }
}
```

**Response 404 `SCRIPT_NOT_FOUND`** — unknown manifest id.

**Response 409 `DEPLOYMENT_LOCKED`** — only when the manifest entry has `requiresLock: true` AND another lock is held. Identical shape to feature 004's 409.

**Response 503 `SSH_ERROR`** — couldn't establish SSH.

### `GET /api/runs`

List recent runs (paginated).

**Query params**: `limit` (default 50, max 200), `offset` (default 0), `status`, `serverId`, `scriptId`.

**Response 200**:

```json
{
  "runs": [
    {
      "id": "7f3b2c10-…",
      "scriptId": "db/backup",
      "serverId": "srv-1",
      "userId": "admin",
      "status": "success",
      "startedAt": "2026-04-22T12:00:00Z",
      "finishedAt": "2026-04-22T12:00:38Z",
      "duration": 38000,
      "archived": false
    }
  ]
}
```

`archived` is a read-side flag set to `true` when `scriptId` is not present in the current manifest (FR-043).

### `GET /api/runs/:id`

Detailed run view including masked params and artefact.

**Response 200**:

```json
{
  "id": "7f3b2c10-…",
  "scriptId": "db/backup",
  "serverId": "srv-1",
  "deploymentId": null,
  "userId": "admin",
  "params": { "databaseName": "mydb", "retentionDays": 30 },
  "status": "success",
  "startedAt": "2026-04-22T12:00:00Z",
  "finishedAt": "2026-04-22T12:00:38Z",
  "duration": 38000,
  "exitCode": 0,
  "outputArtifact": { "type": "file-path", "value": "/backups/mydb-2026-04-22.sql.gz" },
  "errorMessage": null,
  "logFilePath": "/app/data/logs/job-4829.log",
  "archived": false,
  "reRunnable": true
}
```

`reRunnable` is `false` when `archived === true` (script no longer in manifest per FR-043).

---

## Unchanged HTTP endpoints (internal refactor only)

### `POST /api/apps/:appId/deploy`

Request shape unchanged. Response shape unchanged (`201 { deploymentId, jobId }`). 409 conflict shape unchanged. Internally:

```ts
const { scriptId, params } = resolveDeployOperation(app, { commit, branch });
const { runId, jobId } = await scriptsRunner.runScript(scriptId, serverId, params, userId, {
  linkDeploymentId: deploymentId,
});
```

No `deployScript` read or write. No string-replace.

### `POST /api/apps/:appId/rollback`

Same treatment. Internal dispatch is now `scriptsRunner.runScript("deploy/rollback", serverId, { remotePath, commit }, ...)`. The `deploy.sh → rollback.sh` string-replace at `server/routes/deployments.ts:281` is deleted.

### `POST /api/servers/:id/apps` (app creation)

- Request body: field `deployScript` removed from the Zod validator.
- Response unchanged.
- Server rejects with `400 UNKNOWN_FIELD` if a client sends `deployScript` or `deploy_script` (strict schema).

### `PATCH /api/apps/:appId` (app edit)

- Same treatment as creation: `deployScript` rejected.

---

## Internal Service API — `ScriptsRunner`

```ts
interface RunScriptOptions {
  /** When set, links the resulting script_runs row to an existing deployment row. */
  linkDeploymentId?: string;
}

interface ScriptsRunner {
  /** Look up manifest, validate params, persist script_runs row, dispatch SSH exec. */
  runScript(
    scriptId: string,
    serverId: string,
    params: Record<string, unknown>,
    userId: string,
    options?: RunScriptOptions,
  ): Promise<{ runId: string; jobId: string }>;

  /** Read the manifest descriptor for the HTTP endpoint. */
  getManifestDescriptor(): ManifestDescriptor[];

  /** Startup retention cleanup (FR-042 / R-010). */
  pruneOldRuns(): Promise<{ deletedRows: number; deletedLogFiles: number }>;

  /** Startup validation (FR-003 / R-009). Throws on any invalid entry. */
  validateManifest(): void;
}
```

**Errors**:

- `ScriptNotFoundError` → surfaced as `404 SCRIPT_NOT_FOUND`.
- `ZodError` from param parsing → `400 INVALID_PARAMS`.
- Feature-004 `DeployLockedError` → `409 DEPLOYMENT_LOCKED`.
- SSH-layer errors → propagated to `jobManager.failJob`, run ends with `status: failed`, `errorMessage` populated.

---

## WebSocket log streaming

Unchanged. Existing `/ws` handler streams `jobManager` events. Script runs emit the same event shapes (`log`, `progress`, `result`, `status`). The new script-detail UI consumes the same WS protocol as the deploy UI.

---

## Error code catalogue (feature 005 additions)

| Code | HTTP | Meaning |
|---|---|---|
| `SCRIPT_NOT_FOUND` | 404 | `:id` not in manifest |
| `INVALID_PARAMS` | 400 | Zod schema rejection; `details.fieldErrors` populated |
| `INVALID_MANIFEST_ENTRY` | 400 | Target entry exists but was flagged `valid: false` at startup (missing script file, broken Zod schema, etc.); `details.validationError` populated |
| `UNKNOWN_FIELD` | 400 | Strict schema rejected unknown body field (post-`deploy_script` removal) |
| `LOCK_ACQUIRE_ERROR` | 500 | Feature-004 lock service threw on `requiresLock: true` entry |

Existing `DEPLOYMENT_LOCKED` (409) keeps its shape; now applies to any `requiresLock: true` script, not just `/deploy`.

---

## Compatibility matrix

| Caller | Before 005 | After 005 | Change |
|---|---|---|---|
| `POST /api/apps/:id/deploy` client | `{ deploymentId, jobId }` 201 | Same | None visible |
| `POST /api/apps/:id/rollback` client | `{ deploymentId, jobId }` 201 | Same | None visible |
| `POST /api/servers/:id/apps` client sending `deployScript` | Accepted | **400 UNKNOWN_FIELD** | Client MUST stop sending the field |
| `GET /api/apps/:id` response | Includes `deployScript` | No such field | Client MUST NOT rely on it |
| `/api/scripts/*` endpoints | Did not exist | New | Purely additive |
| `/api/runs/*` endpoints | Did not exist | New | Purely additive |
