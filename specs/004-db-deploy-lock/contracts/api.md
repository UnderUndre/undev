# API Contract: Database-Backed Deploy Lock

**Version**: 1.0

## Scope

This feature has **no new HTTP surface**. The contract is the internal `DeployLock` service API consumed by `server/routes/deployments.ts`. The public HTTP endpoints (`POST /api/apps/:appId/deploy`, etc.) stay exactly as they are — same request shape, same 409 response shape on lock conflict.

## Internal Service API — `DeployLock`

```ts
class DeployLock {
  acquireLock(serverId: string, appId: string): Promise<boolean>;
  releaseLock(serverId: string): Promise<void>;
  checkLock(serverId: string): Promise<string | null>;
  reconcileOrphanLocks(): Promise<number>;  // NEW: startup hook
}
```

### `acquireLock(serverId, appId)`

Tries to claim the deploy lock for `serverId`. Persists `appId` as the owner metadata.

**Parameters**:
- `serverId: string` — target server identifier (FK into `servers.id`).
- `appId: string` — application identifier claiming the lock.

**Returns**: `Promise<boolean>` — `true` if the lock was granted and owner metadata persisted; `false` if another dashboard connection currently holds the advisory lock.

**Throws**:
- `Error("lock already held by this instance")` — same process already holds this server's lock. Guards against double-acquire re-entrancy; caller must `releaseLock` first.
- Underlying `postgres` driver errors (connection terminated, pool exhausted, etc.) — propagated as-is. Caller treats as 500.

**Side-effects**:
- On success: reserved connection checked out from pool, `held` map updated, advisory lock held on that connection, `deploy_locks` row upserted.
- On `false` return: no-op, no state change.

### `releaseLock(serverId)`

Releases any lock held for `serverId`. Idempotent — safe to call when no lock is held.

**Parameters**:
- `serverId: string`

**Returns**: `Promise<void>` — never throws on "already released" or "never held"; logs and swallows errors during release.

**Side-effects**:
- If lock was held by this instance: `deploy_locks` row deleted, advisory lock released via `pg_advisory_unlock`, reserved connection returned to pool, `held` entry removed.
- If not held by this instance: no-op.

### `checkLock(serverId)`

Returns the `appId` currently listed as owner in `deploy_locks`, or `null` if no row exists.

**Parameters**:
- `serverId: string`

**Returns**: `Promise<string | null>`

**Guarantees**:
- **Read-only.** Does not mutate `deploy_locks`, does not touch advisory locks, does not open reserved connections.
- May return the `appId` of an orphaned row (backend dead, advisory lock already released) if startup reconciliation hasn't run yet. The next `acquireLock` on the same `serverId` will overwrite the orphan.
- Guaranteed to return `null` after a successful `releaseLock` on the same server.

### `reconcileOrphanLocks()`  (NEW)

One-shot cleanup intended for dashboard startup (invoked from `server/index.ts` after `migrate`).

**Returns**: `Promise<number>` — count of orphan rows deleted. Zero on a clean startup.

**Side-effects**:
- Deletes all rows from `deploy_locks` whose `dashboard_pid` is not in `pg_stat_activity.pid`.
- Does NOT touch rows whose PID is live — those belong to a still-running dashboard instance (if we ever deploy multi-instance — out of scope for v1 but the query is safe in that topology).

**Errors**:
- On SQL error (e.g. Postgres unreachable): logs and resolves with `0`. Startup MUST NOT be blocked on reconciliation — the app can still serve traffic; next acquire will overwrite orphans anyway.

## HTTP Contract (unchanged, documented for completeness)

### `POST /api/apps/:appId/deploy` — 409 response

When `acquireLock` returns `false`:

```http
HTTP/1.1 409 Conflict
Content-Type: application/json

{
  "error": {
    "code": "DEPLOYMENT_LOCKED",
    "message": "Another deployment is in progress on this server",
    "details": {
      "lockedBy": "<appId-returned-by-checkLock>"
    }
  }
}
```

Identical to today's response (see `server/routes/deployments.ts:93-104`). No consumer changes needed.

## Error Codes Introduced by This Feature

| Code | HTTP | Meaning |
|---|---|---|
| `LOCK_ACQUIRE_ERROR` | 500 | `acquireLock` threw due to DB error (not a 409-style conflict). Surfaced only when the underlying DB is unreachable or out of connections. |

The existing `DEPLOYMENT_LOCKED` (409) code is preserved; the new error code is for the case where the acquire operation itself fails catastrophically, distinguishing "locked" from "couldn't even check".

## Compatibility Matrix

| Caller | Before feature 004 | After feature 004 | Change |
|---|---|---|---|
| `routes/deployments.ts` POST /deploy | `acquireLock` → `checkLock` (on failure) → 409 | Same | None |
| `routes/deployments.ts` POST /deploy | `releaseLock` in job completion callback | Same | None |
| `routes/deployments.ts` POST /deploy | `releaseLock` in error handler | Same | None |
| Startup | No lock cleanup | Calls `reconcileOrphanLocks` after migrate | Additive — new step |
| Shutdown | No explicit lock cleanup | SIGTERM handler calls `releaseLock` per held | Additive — new behaviour |
| Target server SSH | `mkdir /tmp/devops-dashboard-deploy.lock.d` on every acquire | None | Removed |
