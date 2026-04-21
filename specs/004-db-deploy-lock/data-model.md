# Data Model: Database-Backed Deploy Lock

**Phase 1 output** | **Date**: 2026-04-21

---

## New Entity: `deploy_locks`

One row per currently-held deploy lock, plus possibly orphaned rows from crashed dashboard instances (cleaned up at startup per FR-022).

```ts
interface DeployLock {
  serverId: string;      // PK, FK → servers.id, ON DELETE CASCADE
  appId: string;         // current owner of the lock
  acquiredAt: string;    // ISO 8601 timestamp — purely informational (not used for timeout)
  dashboardPid: number;  // pg_backend_pid() of the connection holding the advisory lock
}
```

**Lifecycle**:

```
(empty)
  ─── acquireLock() ─→ row inserted (or ON CONFLICT updated)
                       advisory lock held on backend <dashboardPid>
   │
   ├── normal release ─→ releaseLock() deletes row + pg_advisory_unlock
   │                     (row gone, lock gone, connection returned to pool)
   │
   ├── dashboard crash ─→ backend terminates
   │                     Postgres auto-releases advisory lock
   │                     row remains (orphan) until reconciliation
   │                     ─── reconcileOrphanLocks() on next startup ─→ row deleted
   │
   └── same-server re-acquire ─→ ON CONFLICT DO UPDATE overwrites the orphan row
                                  with the new owner's (appId, acquiredAt, dashboardPid)
                                  (safe because the advisory-lock grant proves the prior
                                   backend is dead)
```

**Invariants**:

1. **Row exists ⇒ someone claims to hold the lock.** May not actually hold it if the claiming backend is dead (orphan). `checkLock` surfaces the claim read-only; correctness of "is the lock really held?" is enforced by `pg_try_advisory_lock` in `acquireLock`.
2. **Advisory lock held ⇒ row exists.** Guaranteed by acquire transaction combining `pg_try_advisory_lock` + `INSERT ... ON CONFLICT DO UPDATE` atomically.
3. **`dashboard_pid` ∈ `pg_stat_activity.pid`** while the row is live. When this breaks (backend dies), we're in the orphan state until reconciliation.

## DDL (migration 0004)

```sql
-- 0004_deploy_locks.sql
CREATE TABLE "deploy_locks" (
  "server_id" TEXT PRIMARY KEY REFERENCES "servers"("id") ON DELETE CASCADE,
  "app_id" TEXT NOT NULL,
  "acquired_at" TEXT NOT NULL,
  "dashboard_pid" INTEGER NOT NULL
);
```

**Notes**:
- PK on `server_id` — one lock per server maximum (matches FR-001 scope: "one deploy per server at a time").
- FK with `ON DELETE CASCADE` — if an admin deletes the server, any stuck lock row auto-cleans.
- No index beyond PK — table stays small (row count equals number of servers with active deploys, typically 0–3).
- No `created_at` column on the row itself — `acquired_at` is the analogue.

## Drizzle schema fragment

Added to `server/db/schema.ts`:

```ts
export const deployLocks = pgTable("deploy_locks", {
  serverId: text("server_id")
    .primaryKey()
    .references(() => servers.id, { onDelete: "cascade" }),
  appId: text("app_id").notNull(),
  acquiredAt: text("acquired_at").notNull(),
  dashboardPid: integer("dashboard_pid").notNull(),
});
```

No Drizzle relations defined — the service queries this table with raw SQL through the `postgres` tagged-template for the advisory-lock function calls anyway.

## Removed / deprecated entities

**`/tmp/devops-dashboard-deploy.lock.d` directory on target server** — no longer created, no longer read. One-time cleanup is out of scope (FR-041); existing directories are benign.

## Transient Runtime State (not persisted)

### `DeployLock.held: Map<string, ReservedSql>`

Module-scoped in-memory map, one entry per currently-held lock, keyed by `serverId`. Value is the `postgres` driver's reserved-connection handle.

- **Set**: inside `acquireLock` just before returning `true`.
- **Read**: inside `releaseLock` to find the connection to unlock on.
- **Delete**: inside `releaseLock` after `pg_advisory_unlock` + `reserved.release()`.
- **Iterate**: inside the SIGTERM handler (R-005) to release all held locks on shutdown.

This is **per-process** state. Multi-instance HA deployments would need to coordinate through the DB alone — out of scope for v1. The table `deploy_locks` already contains the durable state; the map is just a pointer back to the live connection from this process.

## Query Catalogue

All queries the service issues, for easy review:

### 1. Acquire (inside transaction on reserved connection)

```sql
-- Step 1: probe the lock
SELECT pg_try_advisory_lock(1, hashtext($1::text)) AS got;
-- $1 = serverId

-- Step 2 (only if got=true): persist owner metadata
INSERT INTO deploy_locks (server_id, app_id, acquired_at, dashboard_pid)
VALUES ($1, $2, $3, pg_backend_pid())
ON CONFLICT (server_id) DO UPDATE
  SET app_id = EXCLUDED.app_id,
      acquired_at = EXCLUDED.acquired_at,
      dashboard_pid = EXCLUDED.dashboard_pid;
-- $1 = serverId, $2 = appId, $3 = ISO timestamp
```

### 2. Release (on the same reserved connection)

```sql
DELETE FROM deploy_locks WHERE server_id = $1;
SELECT pg_advisory_unlock(1, hashtext($1::text));
-- $1 = serverId
```

### 3. Check (main pool, read-only, orphan-filtered)

```sql
SELECT app_id FROM deploy_locks
WHERE server_id = $1
  AND dashboard_pid IN (SELECT pid FROM pg_stat_activity)
LIMIT 1;
-- $1 = serverId
```

The `pg_stat_activity` subquery is the FR-012 orphan filter — rows whose owning backend is gone are implicitly excluded even before reconciliation DELETEs them. This closes the "rolling-deploy ghost lock" gap where `deploy_locks` has a stale row but the advisory lock has been released by backend termination.

### 4. Startup reconciliation (main pool)

```sql
DELETE FROM deploy_locks
WHERE dashboard_pid NOT IN (SELECT pid FROM pg_stat_activity)
RETURNING server_id;
```

All parameters are bound via the driver's tagged-template (`sql`…`${value}`…), eliminating injection risk even though `server_id` is admin-controlled.
