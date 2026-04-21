# Feature Specification: Database-Backed Deploy Lock

**Version**: 1.0 | **Status**: Draft | **Date**: 2026-04-21

## Problem Statement

The DevOps Dashboard's `DeployLock` service currently uses a filesystem lock on the target server — it creates a directory at `/tmp/deploy.lock` via `mkdir` (atomic), writes the owning `appId` into `/tmp/deploy.lock/owner`, and removes the directory on release. This works in isolation but has three material failure modes that have surfaced in production:

1. **Name collision with imported apps.** Many deploy scripts written by application teams independently pick `/tmp/deploy.lock` as their own lock path. Feature 003 (scan-for-repos) now imports such apps, and when the dashboard creates a *directory* at that path, the app's script fails with `echo $$ > /tmp/deploy.lock: Is a directory`. Namespacing the dashboard's path (currently `/tmp/devops-dashboard-deploy.lock.d`) is a partial mitigation, but every future app scan risks another collision on whatever arbitrary name we pick.
2. **SSH round-trips on every lock operation.** `acquireLock`, `checkLock`, and `releaseLock` each open an SSH channel, run a shell command, and wait for exit. For a dashboard that orchestrates many servers, this adds hundreds of milliseconds per deploy decision — and breaks entirely if the target server is temporarily unreachable (the lock cannot be acquired or released at all).
3. **Orphaned locks survive dashboard restarts.** If the dashboard crashes or is redeployed while a lock is held, the `rm -rf` cleanup never fires. The next deploy attempt sees an "acquired" lock with an unknown owner and either blocks indefinitely or relies on a human to SSH in and wipe the directory.

These failures are all symptoms of the same root cause: **the dashboard is using the target server's filesystem as a coordination primitive for state the dashboard itself owns**. The dashboard already has a dedicated, transactional, crash-safe datastore — PostgreSQL — with first-class lock primitives (`pg_try_advisory_lock`) designed exactly for this purpose.

This feature replaces the filesystem lock with a Postgres advisory lock, keyed on server ID. The on-disk `/tmp/devops-dashboard-deploy.lock.d` path and the SSH round-trips disappear entirely.

## User Scenarios

### US-001: Deploy Acquires the Lock Instantly, No SSH Needed

**Actor**: Dashboard admin
**Precondition**: An application `app-1` on server `srv-1` is ready to deploy. No deploy is currently running on `srv-1`.

1. Admin clicks **Deploy** in the dashboard.
2. The deploy route calls `deployLock.acquireLock("srv-1", "app-1")`.
3. The lock service runs `SELECT pg_try_advisory_lock(...)` against its own Postgres connection.
4. Postgres returns `true` — the lock is held by this dashboard process.
5. The deploy proceeds. Total acquisition latency: < 5 ms, no SSH traffic.

### US-002: Concurrent Deploy on Same Server Is Blocked Cleanly

**Actor**: Two dashboard admins on the same server
**Precondition**: Admin A just clicked Deploy for `app-1` on `srv-1`. Admin B clicks Deploy for `app-2` on the same `srv-1` seconds later.

1. Admin A's deploy acquires the advisory lock.
2. Admin B's deploy calls `acquireLock("srv-1", "app-2")`.
3. The lock service runs `SELECT pg_try_advisory_lock(...)` — Postgres returns `false`.
4. The service returns `false` to the route.
5. The route returns **409 DEPLOYMENT_LOCKED** to Admin B with the current holder's `appId`.
6. Admin B sees: "Another deployment (app-1) is in progress on this server."

### US-003: Different Servers Deploy in Parallel

**Actor**: Two admins
**Precondition**: Admin A deploying to `srv-1`. Admin B deploying to `srv-2`.

1. Both calls hit `pg_try_advisory_lock` with different keys derived from different server IDs.
2. Both succeed — locks are independent per server.
3. Both deploys run concurrently with no interference.

### US-004: Dashboard Restart Releases Locks Automatically

**Actor**: System (automated)
**Precondition**: A deploy is running, holding the lock. The dashboard process is killed (OOM, SIGTERM during redeploy, crash).

1. The dashboard's Postgres connection terminates.
2. Postgres automatically releases all session-scoped advisory locks held by that connection.
3. The next dashboard startup starts a fresh connection with no inherited locks.
4. Admins can deploy immediately after restart — no manual cleanup, no SSH, no stale locks.

### US-005: Target Server Is Unreachable, Lock Still Usable

**Actor**: Dashboard admin
**Precondition**: `srv-1` is temporarily unreachable (network issue). A previous deploy hung and the dashboard's lock state is unknown.

1. Admin wants to cancel the stuck deploy or force a new one.
2. Today: dashboard tries `rm -rf /tmp/devops-dashboard-deploy.lock.d` over SSH, times out — lock is "stuck" until the server comes back.
3. With DB lock: the Node process holding the lock can be restarted from the dashboard side. On restart, the lock is released by Postgres automatically. The admin can then re-run the deploy.

## Functional Requirements

### Lock Primitive

- **FR-001**: The lock MUST use `pg_try_advisory_lock(key)` / `pg_advisory_unlock(key)` against the existing dashboard Postgres instance. No new database, no new table, no new extension.
- **FR-002**: The key MUST be derived deterministically from `serverId` via a stable hash: `hashtext(serverId)`. Collision probability for realistic fleet sizes (<10,000 servers) is negligible for a 64-bit keyspace, but the implementation MUST use the two-argument form `pg_try_advisory_lock(int4, int4)` with a feature-specific namespace in the first argument (`DEPLOY_LOCK_NAMESPACE = 1`) to eliminate cross-feature collisions with any future use of advisory locks.
- **FR-003**: Lock scope MUST be **session-level** (`pg_try_advisory_lock`), not transaction-level. The lock is acquired in one request and released in a later request — transaction scope is wrong. Session scope auto-releases on connection close (FR-006).
- **FR-004**: The lock service MUST use a **dedicated Postgres connection** per active lock, not a pooled shared connection. Rationale: advisory locks are tied to the connection's session; if lock+unlock happen on different pooled connections, the unlock does nothing. Implementation uses a single long-lived connection checked out from the pool for the lock's lifetime, or a side-channel connection reserved for the lock service.

### API Surface (backward-compatible)

- **FR-010**: The `DeployLock` class MUST keep the same public API: `acquireLock(serverId, appId): Promise<boolean>`, `checkLock(serverId): Promise<string | null>`, `releaseLock(serverId): Promise<void>`. No changes needed in `server/routes/deployments.ts`.
- **FR-011**: The lock MUST store the `appId` of the current owner somewhere Postgres-accessible (for `checkLock`). A small table `deploy_locks(server_id PK, app_id, acquired_at, dashboard_pid)` is the cleanest place — upserted on acquire, deleted on release. The acquire statement MUST combine `SELECT pg_try_advisory_lock` + `INSERT … ON CONFLICT (server_id) DO UPDATE` in a single transaction, so (a) the owner row is guaranteed to exist whenever the advisory lock is held, and (b) an orphan row from a prior crash is silently overwritten with the new owner's data (safe, because the advisory lock grant itself is proof the prior connection is dead).
- **FR-012**: `checkLock(serverId)` MUST be **read-only**: return `deploy_locks.app_id` if a row exists for `serverId`, else `null`. No mutations, no advisory lock probing. Orphan rows (row exists but the owning backend is dead) are reconciled by (a) startup cleanup per FR-022, or (b) the next `acquireLock` call on the same server which overwrites via ON CONFLICT DO UPDATE. This keeps `checkLock` race-free — it never accidentally acquires or releases locks as a side-effect of a read.

### Crash Safety

- **FR-020**: If the dashboard process dies while holding the lock, Postgres MUST release the advisory lock automatically on connection termination. No user action required.
- **FR-021**: The `deploy_locks` table row MAY outlive the advisory lock (if the dashboard died mid-operation between `SELECT pg_try_advisory_lock` and `INSERT`). `checkLock` MUST NOT be fooled by such stale rows — see FR-012 reconciliation logic.
- **FR-022**: A dashboard startup routine MUST scan `deploy_locks` and clean up any rows whose owning Postgres backend is no longer live. Reconciliation SQL: `DELETE FROM deploy_locks WHERE dashboard_pid NOT IN (SELECT pid FROM pg_stat_activity)`. This is authoritative — a missing backend PID means the connection that held the advisory lock has died and Postgres has already released the lock. Bounds stale-row accumulation to one cleanup per restart.

### Migration

- **FR-030**: A new migration `0004_deploy_locks.sql` MUST create the `deploy_locks` table:
  ```sql
  CREATE TABLE deploy_locks (
    server_id TEXT PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,
    app_id    TEXT NOT NULL,
    acquired_at TEXT NOT NULL,
    dashboard_pid INT NOT NULL  -- pg_backend_pid() of the connection holding the advisory lock
  );
  ```
  `dashboard_pid` MUST be populated from `pg_backend_pid()` in the same statement that acquires the advisory lock. Do NOT use `process.pid` from Node — that value is opaque to Postgres and makes reconciliation (FR-022) impossible without extra protocol.
- **FR-031**: The migration MUST NOT backfill any rows — existing on-disk `/tmp/devops-dashboard-deploy.lock.d` lock directories are transient and will be cleaned up naturally as deploys finish.
- **FR-032**: On the first dashboard startup after migration, the startup routine (FR-022) MUST reconcile any `deploy_locks` rows that exist from test data (none expected in prod).

### Deprecation of Filesystem Lock

- **FR-040**: After migration, `DeployLock.acquireLock` MUST NOT execute any `mkdir` or SSH commands. The filesystem path `/tmp/devops-dashboard-deploy.lock.d` is never touched again.
- **FR-041**: A one-time cleanup task MAY remove existing `/tmp/devops-dashboard-deploy.lock.d` directories on registered servers. Not required — they're harmless if left behind and will be garbage-collected at the next `/tmp` sweep.

## Success Criteria

- **SC-001**: Lock acquisition latency drops from ~200–500 ms (SSH round-trip) to < 10 ms (one local Postgres query) on a registered server. Measured by instrumenting `acquireLock` and comparing before/after.
- **SC-002**: Deploying to an SSH-unreachable server still correctly returns 409 `DEPLOYMENT_LOCKED` if a lock is genuinely held — i.e., the lock state is independent of SSH reachability.
- **SC-003**: Dashboard restart (`docker compose restart dashboard`) releases all held locks within 5 seconds, verified by a test that holds a lock, restarts the process, and attempts re-acquisition.
- **SC-004**: No deploy script running on target servers sees `Is a directory` or any filesystem-lock-related error from the dashboard. Zero path collisions possible.
- **SC-005**: Two concurrent deploys on different servers succeed in parallel; two on the same server return 409 exactly once (no race window).

## Out of Scope (v1)

- Replacing the imported apps' own lock mechanisms (e.g., ai-digital-twins's `/tmp/deploy.lock` in `server-deploy-prod.sh`). Those belong to the app owners — the dashboard stays out.
- Lock timeouts / automatic takeover. A held lock is held until explicitly released or the connection dies. Admins who want to force-unlock a zombie lock restart the dashboard.
- Multi-instance dashboard HA. The feature assumes one dashboard process per database. A multi-instance setup would share the same Postgres advisory lock namespace automatically — but the `deploy_locks` row's `dashboard_pid` would stop being meaningful and the startup cleanup (FR-022) would need to coordinate. Deferred.
- Per-app locks instead of per-server locks. Current behaviour is server-scoped ("one deploy at a time per machine") and we preserve that — scope change is a product decision, not an infrastructure one.

## Key Entities

### DeployLock (extended)

Existing class, logic rewritten. No API surface changes.

- `acquireLock(serverId, appId)`: opens/checks out a dedicated Postgres connection, runs `SELECT pg_try_advisory_lock(DEPLOY_LOCK_NAMESPACE, hashtext(serverId))` + `INSERT INTO deploy_locks ...` in one transaction. Returns `true` iff the advisory lock was granted. Stores the dedicated connection handle in an in-memory `Map<serverId, Connection>`.
- `releaseLock(serverId)`: runs `DELETE FROM deploy_locks WHERE server_id = $1` + `SELECT pg_advisory_unlock(...)` on the stored connection, then releases the connection back to the pool. Idempotent.
- `checkLock(serverId)`: reads `deploy_locks.app_id` for the server. Reconciles stale rows via FR-012 logic.

### deploy_locks (new table)

See FR-030. Acts as the human-readable index of who owns which server's lock.

## Dependencies

- DevOps Dashboard's Postgres connection (existing, driven by `postgres` / Drizzle).
- The `servers` table (existing, from 001-devops-app) — `deploy_locks.server_id` FKs into it.
- No new npm packages required. `pg_try_advisory_lock` is a built-in Postgres function.

## Assumptions

- The dashboard runs against a single logical Postgres instance (one primary, optional read replicas). Advisory locks are not replicated to read replicas, so all lock operations run against the primary. In current 001-devops-app topology this is satisfied — there's only one Postgres container.
- Connection pool can spare 1–N connections for lock-holding. Default pool size (10) comfortably supports the expected fleet size (~5 servers) with room to spare.
- `hashtext` is a 32-bit hash (int4 keyspace ≈ 4.3 × 10⁹). The birthday-paradox probability of **any** pair of server IDs colliding grows as n²/2M, giving:
  - **Realistic fleet (< 100 servers)**: ≈ 1 in 860 000 — acceptable for this risk profile.
  - **Heavy fleet (1 000 servers)**: ≈ 1 in 8 600 — still tolerable; a single collision blocks one server pair from deploying concurrently, admin-visible via 409 with wrong `lockedBy`.
  - **Extreme fleet (10 000 servers)**: ≈ 1.16 % — **not negligible**. If this feature ever targets a fleet this large, switch to single-argument `pg_try_advisory_lock(bigint)` with a 64-bit hash (e.g. `(abs(hashtext(id))::bigint << 32) | hashtextextended(id, SEED)::bigint`). The two-argument form's first argument (`DEPLOY_LOCK_NAMESPACE = 1`) isolates this feature from OTHER advisory-lock users but does NOT widen the per-server keyspace.

  The current DevOps Dashboard targets <100 servers, so the 32-bit form is safe. Upgrade path to 64-bit is a single-line SQL change if needed later.

## Clarifications

No open questions. The mechanism is a direct one-for-one replacement of the existing `DeployLock` implementation; the contract to `deployments.ts` stays identical.

### Session 2026-04-21 — root-cause analysis of existing bug

- Q: Why did `/tmp/deploy.lock` collisions surface only after feature 003? → A: feature 003 (scan-for-repos) first enabled importing third-party deploy scripts into the dashboard. Pre-003, admins writing dashboard-targeted scripts knew the path was owned by the dashboard. Post-003, arbitrary scripts enter the dashboard's deploy pipeline.
- Q: Why not just keep namespacing the path? → A: Namespacing is a mitigation, not a fix. Every future app scan risks hitting another app-chosen name. The only fix that eliminates the class of bug is moving off the filesystem entirely.
- Q: Why Postgres advisory locks rather than a `SELECT FOR UPDATE` on a row? → A: Advisory locks are designed for exactly this use case — long-lived non-row-level coordination. `SELECT FOR UPDATE` would hold an actual row lock for the entire deploy duration, blocking normal reads/writes to that row and polluting long-running-transaction metrics. Advisory locks sit outside the MVCC layer with near-zero overhead.
- Q: What semantics for `deploy_locks.dashboard_pid`? → A: Postgres backend PID via `pg_backend_pid()`. Directly tied to the connection holding the advisory lock; startup reconciliation joins against `pg_stat_activity.pid` to detect orphans authoritatively, without Node-side assumptions.
- Q: How to handle the race where `pg_try_advisory_lock` grants but `INSERT INTO deploy_locks` hits a PK conflict (orphan row from prior crash not yet reconciled)? → A: `INSERT ... ON CONFLICT (server_id) DO UPDATE SET app_id = EXCLUDED.app_id, acquired_at = EXCLUDED.acquired_at, dashboard_pid = EXCLUDED.dashboard_pid`. Rationale: advisory lock grant is proof that the previous PID's connection is dead; we are the legitimate owner and can safely overwrite the orphan metadata in one atomic statement. No separate pre-cleanup round-trip required.
- Q: Should `checkLock` reconcile orphan rows (DELETE + return null) or stay read-only? → A: **Read-only.** `checkLock(serverId)` returns `deploy_locks.app_id` if the row exists, else null. No DELETE, no throwaway `pg_try_advisory_lock`. Orphan cleanup is owned by two other paths: (a) startup reconciliation (FR-022) catches rows from prior dashboard crashes; (b) the next `acquireLock` on the same server naturally overwrites via ON CONFLICT DO UPDATE. Keeping `checkLock` side-effect-free eliminates race windows where a legitimate release happens mid-probe and `checkLock` accidentally "steals" the lock.
