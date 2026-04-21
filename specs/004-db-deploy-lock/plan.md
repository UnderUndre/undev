# Implementation Plan: Database-Backed Deploy Lock

**Branch**: `004-db-deploy-lock` | **Date**: 2026-04-21 | **Spec**: [spec.md](spec.md)

## Summary

Replace the filesystem-based `DeployLock` (mkdir under `/tmp/devops-dashboard-deploy.lock.d` on target server via SSH) with a Postgres advisory lock scoped per server. The public API of `DeployLock` stays identical (`acquireLock` / `checkLock` / `releaseLock`); the only caller (`server/routes/deployments.ts`) is untouched. A new `deploy_locks` table stores human-readable owner metadata (`app_id`, `acquired_at`, `dashboard_pid = pg_backend_pid()`) with upsert-on-conflict semantics. Crash safety comes from Postgres auto-releasing session-level advisory locks on connection close, plus a startup reconciliation query that wipes orphaned rows whose backend PID no longer appears in `pg_stat_activity`.

## Technical Context

**Existing stack** (from 001-devops-app):
- **DB driver**: `postgres` (porsager/postgres) 3.4.x with `drizzle-orm/postgres-js` 0.45.x
- **Pool**: `postgres(connectionString)` in `server/db/index.ts` — default max 10 connections, exposed as both `client` (raw tagged-template) and `db` (Drizzle)
- **Migrations**: drizzle-kit generate / migrate — existing journal through `0003_scan`
- **Connection reservation primitive**: `sql.reserve()` → returns a `ReservedSql` handle that holds one dedicated connection until `release()` is called
- **Backend PID exposure**: `SELECT pg_backend_pid()` — returns the int4 OS PID of the current Postgres server-side process

**New for this feature**:
- New table `deploy_locks` (one row per held lock)
- Module-scoped `Map<serverId, ReservedSql>` in `DeployLock` to keep the dedicated connection pinned for the lock's lifetime
- Advisory-lock key scheme: `pg_try_advisory_lock(DEPLOY_LOCK_NAMESPACE=1, hashtext(serverId))` — two-arg form reserves a 32-bit namespace for future features
- Startup reconciliation hook in `server/index.ts` (alongside the existing migrate call on line 89)

**No new npm dependencies.** `postgres`, Drizzle, and built-in Postgres functions cover everything.

**Unknowns resolved in research.md**:
- R-001: Why `pg_try_advisory_lock` vs `pg_advisory_lock` (non-blocking) — answered in spec Clarifications already but captured for design record.
- R-002: How `postgres` driver handles reserved connections across async boundaries — must verify `sql.reserve()` survives await-chains within one acquire-to-release span.
- R-003: Startup reconciliation SQL — exact query shape + expected cost on small tables.
- R-004: Error handling for the `acquireLock` transaction when the reserved connection itself dies mid-transaction.
- R-005: Graceful shutdown — whether to explicitly `DELETE` + `pg_advisory_unlock_all` on SIGTERM or rely on connection close.

## Project Structure (new/modified files)

```
devops-app/
├── server/
│   ├── db/
│   │   ├── schema.ts              # MODIFIED: add deployLocks table definition
│   │   └── migrations/
│   │       └── 0004_deploy_locks.sql  # NEW
│   ├── services/
│   │   └── deploy-lock.ts         # REWRITTEN: Postgres-backed, same public API
│   └── index.ts                   # MODIFIED: call reconcileOrphanLocks() on startup
└── tests/
    ├── unit/
    │   └── deploy-lock-key.test.ts    # NEW: hashtext key derivation, namespace const
    └── integration/
        └── deploy-lock.test.ts        # REWRITTEN: tests against real Postgres via
                                         # existing test harness (or mocked sql.reserve)
```

Existing `tests/integration/deploy.test.ts` currently tests the SSH-based lock — it will be rewritten to cover the new DB-based lock, dropping the `sshPool.exec` expectations entirely.

## Key Implementation Notes

**`acquireLock(serverId, appId): Promise<boolean>`**:
1. If `serverId` already in module-scoped `held` map → throw `Error("lock already held by this instance")`. This guards the same-process re-entrancy case (distinct from another dashboard instance, which is handled by the DB).
2. `const reserved = await sql.reserve()` — checks out a dedicated connection.
3. `await reserved.begin(async (tx) => { ... })` — opens transaction on that connection.
4. Inside tx:
   ```sql
   SELECT pg_try_advisory_lock(1, hashtext(${serverId})) AS got
   ```
   If `got === false` → ROLLBACK, `reserved.release()`, return `false`.
   If `got === true`:
   ```sql
   INSERT INTO deploy_locks (server_id, app_id, acquired_at, dashboard_pid)
   VALUES (${serverId}, ${appId}, ${now}, pg_backend_pid())
   ON CONFLICT (server_id) DO UPDATE
     SET app_id = EXCLUDED.app_id,
         acquired_at = EXCLUDED.acquired_at,
         dashboard_pid = EXCLUDED.dashboard_pid
   ```
5. Store `held.set(serverId, reserved)`. Return `true`.

**`releaseLock(serverId): Promise<void>`** — idempotent:
1. Look up `reserved = held.get(serverId)`. If missing → no-op return.
2. On the same reserved connection:
   ```sql
   DELETE FROM deploy_locks WHERE server_id = ${serverId};
   SELECT pg_advisory_unlock(1, hashtext(${serverId}));
   ```
3. `reserved.release()` → connection returns to pool.
4. `held.delete(serverId)`.
5. Errors during release are caught + logged (same pattern as current `deploy-lock.ts:22`) but do not throw — caller has already committed to completing the deploy.

**`checkLock(serverId): Promise<string | null>`** — read-only (FR-012):
```sql
SELECT app_id FROM deploy_locks WHERE server_id = ${serverId} LIMIT 1
```
Runs on the main pool (not a reserved connection — no session-level state needed). Returns `app_id` or null. No side-effects.

**`reconcileOrphanLocks(): Promise<number>`** — called once on startup:
```sql
DELETE FROM deploy_locks
WHERE dashboard_pid NOT IN (SELECT pid FROM pg_stat_activity)
RETURNING server_id
```
Returns count of deleted rows for logging. Runs against the main pool. Because the advisory locks owned by dead connections have already been released by Postgres at connection close, this DELETE is pure metadata cleanup — there's no lock to release.

**Graceful shutdown** (resolved in R-005): register a SIGTERM handler that iterates `held`, calls `releaseLock(serverId)` for each. Bounded by `Promise.all` + 2s timeout; if shutdown races ahead, connection close will release the advisory locks anyway — explicit release just makes the `deploy_locks` table consistent faster.

**Deploy route integration**: zero changes to `server/routes/deployments.ts`. The existing call sites (`deployLock.acquireLock`, `deployLock.checkLock`, `deployLock.releaseLock`) get the new implementation transparently.

## Constitution Check

No `.specify/memory/constitution.md` in this repository (same as 002 / 003). Applying CLAUDE.md Standing Orders:

| Principle | Status | Note |
|---|---|---|
| No commits/pushes without request | ✅ | Plan only |
| No new packages without approval | ✅ | Zero new deps — `postgres` + Drizzle already in use |
| No `--force` / bypass flags | ✅ | N/A |
| No secrets in code/logs | ✅ | Logger redacts via existing pino config; server_id / app_id are not secret |
| No direct DB migrations | ✅ | `0004_deploy_locks.sql` generated for admin review; applied by app on startup same as previous migrations |
| No destructive ops without consent | ✅ | Startup reconciliation `DELETE`s only rows whose backing connection is provably dead (via `pg_stat_activity` JOIN) |
| Plan-first if >3 files changed | ✅ | This plan lists every file |
| Check context7 before unfamiliar API | ✅ | `postgres` and Drizzle already used throughout; `pg_try_advisory_lock` is a Postgres built-in — no library docs to research |

No gate violations. Proceed to Phase 2 (tasks).

## Complexity Tracking

| Addition | Why Needed | Simpler Alternative Rejected |
|---|---|---|
| `deploy_locks` table | FR-011 — `checkLock` needs Postgres-accessible owner metadata without touching the advisory-lock side-channel. | Encode app_id into advisory lock key directly → impossible, key is int4+int4 only. Also LISTEN/NOTIFY → ephemeral, no point-in-time query. |
| Reserved connection pinned per held lock | FR-004 — session-scope advisory locks are tied to the exact connection; pooled reuse breaks `pg_advisory_unlock`. | Transaction-scope advisory lock (`pg_try_advisory_xact_lock`) — auto-releases at transaction end, but our lock spans multiple HTTP requests (acquire in POST /deploy, release in deploy completion callback). Wrong scope. |
| Startup reconciliation routine | FR-021/022 — row may outlive advisory lock after a crash, `pg_stat_activity` tells us which PIDs are truly gone. | Skip it → orphan rows accumulate forever, `checkLock` returns ghost owners. |
| Two-argument `pg_try_advisory_lock(1, hashtext(serverId))` | FR-002 — reserves 32-bit namespace so future features (migration lock, backup lock) never collide with deploy locks even on the same hashtext bucket. | One-argument `pg_try_advisory_lock(bigint)` — works, but co-mingles namespaces with anything else in the app using advisory locks. Tiny cost today, large unwind later. |
| In-process `held` map | Implementation detail — driver gives one `ReservedSql` per `reserve()` call; we need to remember which to release. | Global connection pool + connection-string tagging → fragile, driver-specific. |

## Out of Plan

Explicit non-goals (mirror spec § Out of Scope):

- Fixing imported apps' own lock mechanisms (their `/tmp/deploy.lock` etc. stays theirs)
- Lock timeouts / admin force-unlock — dashboard restart is the escape hatch
- Multi-instance dashboard HA — deferred; the design works naturally per-DB but `dashboard_pid` reconciliation needs coordination logic that's out of scope
- Per-app locks (current behaviour: server-scoped) — product decision, not infra
