# Research: Database-Backed Deploy Lock

**Phase 0 output** | **Date**: 2026-04-21

---

## R-001: `pg_try_advisory_lock` vs `pg_advisory_lock` (non-blocking vs blocking)

**Decision**: Use the non-blocking `pg_try_advisory_lock`.

**Rationale**: The deploy route needs a fast yes/no answer — if another deploy is in progress, the correct response is **immediate 409 DEPLOYMENT_LOCKED** with metadata about the current holder, not a blocking wait. `pg_advisory_lock` would hang the request until the current holder releases (could be minutes), consume an HTTP handler slot, and fight the user's expectation of "my click did something observable right now".

**Key details**:
- `pg_try_advisory_lock(int4, int4) → boolean` — grants lock and returns `true`, or returns `false` without blocking.
- Session scope — holds until `pg_advisory_unlock` or connection close.
- Idempotent within a session: same session calling `pg_try_advisory_lock` twice with the same key gets `true` both times, needs two `pg_advisory_unlock` calls to fully release. Our `held` map guards against this by refusing re-entrant acquires.

**Alternatives considered**:
- **`pg_advisory_lock` (blocking)** — gives a simpler "wait your turn" UX but blocks HTTP worker, breaks 409 contract. Rejected.
- **`pg_advisory_xact_lock`** — transaction-scoped, auto-release at commit. Wrong scope; see Complexity Tracking in plan.md.

---

## R-002: `postgres` driver — reserved connections across async boundaries

**Decision**: Use `sql.reserve()` → keep the returned `ReservedSql` handle in a module-scoped Map, release it when the lock is released.

**Rationale**: porsager/postgres documents `sql.reserve()` as:

> Reserves a connection from the pool; returns an `sql`-like function you can use exclusively until you call `.release()`.

Behaviour verified for our use case:
- The reserved handle survives arbitrary `await` chains — no auto-release between statements.
- The reserved handle is **not** tied to a specific call-site; passing it between async functions works.
- If the underlying TCP connection dies (network error, server kill), all queries on the reserved handle error. We need to catch this and treat it as "lock released by Postgres" — the advisory lock is already gone.
- `reserved.begin(async tx => ...)` runs a transaction on the reserved connection (not checking out another one).

**Key invariant**: every `sql.reserve()` must be matched by exactly one `release()`. We always `release()` in a `finally` block inside `releaseLock`, plus the graceful-shutdown handler iterates the `held` map.

**Alternatives considered**:
- **Single global "lock connection"** — one extra connection always open, shared for all server lock operations. Simpler, but serialises every acquireLock/releaseLock globally — the fleet-wide fan-out benefit is lost. Rejected.
- **Raw `pg` driver (node-postgres) with manual `Client.connect()`** — gives more direct control but pulls in a new dependency and duplicates pool management. Rejected.

---

## R-003: Startup reconciliation SQL

**Decision**:

```sql
DELETE FROM deploy_locks
WHERE dashboard_pid NOT IN (SELECT pid FROM pg_stat_activity)
RETURNING server_id;
```

**Rationale**:
- `pg_stat_activity.pid` is the authoritative list of currently-alive backends. If a row's `dashboard_pid` is not in there, the connection that held the advisory lock has terminated → Postgres already auto-released the lock → the row is pure orphan metadata.
- `NOT IN (SELECT pid FROM pg_stat_activity)` is a semi-join. On a table with <10 rows (expected size) the planner picks a sequential scan → subquery is evaluated once; total cost is negligible.
- `RETURNING server_id` lets us log what was cleaned. `logger.info({ reconciled: count, serverIds: [...] }, "Orphan deploy locks cleaned")`.

**Edge cases**:
- **Postgres PID reuse**: if a backend dies and a fresh backend reuses the same OS PID, reconciliation might falsely conclude the row is live. On Linux, PID reuse requires wrapping around `kernel.pid_max` (default 4194304), functionally irrelevant over dashboard lifetimes. On Windows containers the space is smaller but we target Linux hosts. **Acceptable risk, documented in assumptions.**
- **`pg_stat_activity` permissions**: on some managed Postgres deployments, a non-superuser cannot see other backends' rows in `pg_stat_activity`. In our self-hosted compose setup, the `dashboard` role sees its own backends by default. No extra grant needed. Verified against the existing `devops-db` service.

**When it runs**: inside `server/index.ts` startup, after `migrate(...)` succeeds, before the HTTP server starts listening. A single await — if it fails (connection issue), we log and proceed anyway (startup is not blocked on cleanup).

**Alternatives considered**:
- **Timestamp-based expiry** — mark rows older than N minutes as stale. Fragile: legitimate long deploys would get wiped. Rejected.
- **Heartbeat loop** — writer thread refreshes `acquired_at` every 30s, reconciler drops rows not refreshed. Works, but needs a background timer + reduces the reconciliation question to "is the heartbeat fresh" which isn't more accurate than `pg_stat_activity`. Rejected.

---

## R-004: Error handling for transaction failure during `acquireLock`

**Decision**: On any SQL error AFTER `pg_try_advisory_lock` returned `true`, the catch block MUST explicitly issue `SELECT pg_advisory_unlock_all()` on the same reserved connection BEFORE calling `reserved.release()`. Then rethrow.

**Rationale** — pool contamination risk (caught on PR #7 by @gemini-code-assist):
- The acquire sequence is `SELECT pg_try_advisory_lock` + `INSERT ... ON CONFLICT DO UPDATE`. If step 1 grants the lock but step 2 fails (network blip, constraint error, admin `pg_terminate_backend`, client timeout), the advisory lock is **still held** on the reserved connection.
- `reserved.release()` does NOT destroy the connection — it **returns it to the pool for reuse**. The advisory lock is session-scoped, not transaction-scoped, so returning a lock-holding connection to the pool means **the next consumer of that connection will unknowingly hold our lock**. Pool contamination. Every subsequent `pg_try_advisory_lock` on the same key from a different consumer will get `true` (already held by "me"), corrupting the lock semantics.
- Rely-on-connection-death logic (previous version of this decision) is insufficient: in the normal error path the connection is **healthy**, just the SQL statement failed. It goes back to the pool alive and contaminated.

**Correct sequence** inside `acquireLock`:

```
const reserved = await client.reserve();
let gotLock = false;
try {
  await reserved.begin(async tx => {
    const [{ got }] = await tx`SELECT pg_try_advisory_lock(${ns}, ${key}) AS got`;
    if (!got) { /* return false; transaction rolls back empty */ return; }
    gotLock = true;
    await tx`INSERT INTO deploy_locks ... ON CONFLICT ... DO UPDATE ...`;
  });
  return gotLock;
} catch (err) {
  if (gotLock) {
    // Advisory lock was granted but tx didn't finish committing the metadata —
    // MUST nuke ALL advisory locks on this connection before returning it to the
    // pool, otherwise the next pool consumer inherits our orphan lock.
    await reserved`SELECT pg_advisory_unlock_all()`.catch(() => {
      /* connection is dead — Postgres already released anyway */
    });
  }
  throw err;
} finally {
  reserved.release();
}
```

- **Why `pg_advisory_unlock_all()` not targeted `pg_advisory_unlock(ns, key)`**: the error might have fired AFTER the `INSERT ... ON CONFLICT DO UPDATE` inserted successfully but before the final COMMIT. In some error paths we might have held multiple advisory locks (future-proofing). `unlock_all` is one cheap statement that guarantees the connection returns clean.
- **Why the `.catch(() => {})` on unlock**: if the connection itself is dead (network partition, server kill), the unlock query fails — but that's ALSO the case where Postgres has already released the lock on its end. Both paths converge on "lock released". Swallowing the error here is correct.
- **`gotLock` flag**: we only run `unlock_all` if we actually got a lock. If `pg_try_advisory_lock` returned `false` (lock held by another connection), there's nothing of ours to unlock. Without the flag we'd `unlock_all` on a connection that held no locks from us — harmless, but wastes a round-trip on the common 409 path.

**Visible behaviour**: `acquireLock` throws instead of returning `false`. The route `deployments.ts` already catches exceptions from `acquireLock` and returns 500 `LOCK_ACQUIRE_ERROR`. Admin retries. Pool stays clean.

**Alternatives considered**:
- **Rely on connection death** — only works for connection-level errors; silent on statement-level errors (PK constraint, network timeout during tx). Rejected — that's exactly the bug Gemini flagged.
- **Destroy connection instead of release** — `postgres` driver doesn't expose "destroy this specific reserved handle" cleanly; forcing it would leak pool slots. Cheaper to unlock_all.
- **Swallow the error and return `false`** — user sees "another deploy in progress" when actually the DB is down. Dishonest UX; masks the real incident. Rejected.

---

## R-005: Graceful shutdown

**Decision**: Register a `SIGTERM` handler that:
1. Iterates `held.keys()` → calls `releaseLock(serverId)` for each.
2. Awaits `Promise.allSettled` with a 2s total timeout.
3. Calls `client.end()` on the main `postgres` pool.
4. `process.exit(0)`.

**Rationale**:
- Without explicit release, dashboard shutdown relies on TCP teardown to drop the connection → Postgres eventually notices and releases the advisory lock. On a healthy shutdown this happens within milliseconds; on a partitioned shutdown (container killed mid-flush) it can take `tcp_keepalive_time` (default 2h on Linux) before Postgres reaps the dead session. Explicit release makes clean shutdown deterministic.
- Running `releaseLock` on each held lock ALSO cleans up the `deploy_locks` row — otherwise the next dashboard startup sees it as an orphan (reconcile handles that, but unnecessary churn).
- 2s timeout prevents shutdown from hanging if a specific release query stalls. Connection close in step 3 is the second line of defence.

**Implementation touchpoint**: `server/index.ts` already has shutdown logic patterns (see how WS/jobs are set up). Adding a single `process.on("SIGTERM", ...)` block next to the HTTP server bring-up is the entire change.

**Alternatives considered**:
- **Rely only on connection close** — works correctly for the advisory lock, leaves orphan row behind. Accepted as fallback but not primary. In practice step 3 always runs; step 1+2 just make the row cleanup proactive.
- **Per-request release with heartbeat** — overkill, see R-003 alternatives.

---

## Summary of Unknowns Resolved

| Spec reference | Decision |
|---|---|
| Lock primitive (FR-001, FR-003) | `pg_try_advisory_lock` non-blocking, session-scope (R-001) |
| Dedicated connection (FR-004) | `sql.reserve()` from `postgres` driver, handle held in `Map<serverId, ReservedSql>` (R-002) |
| Startup reconciliation (FR-022) | `DELETE ... WHERE dashboard_pid NOT IN (SELECT pid FROM pg_stat_activity)` (R-003) |
| Transaction error handling | On SQL error after advisory-lock grant, explicitly `SELECT pg_advisory_unlock_all()` in catch BEFORE `reserved.release()` to prevent pool contamination; then rethrow (R-004) |
| Graceful shutdown | SIGTERM handler: iterate held, release each, 2s timeout, then `client.end()` (R-005) |
| PK conflict race during acquire | `INSERT ... ON CONFLICT (server_id) DO UPDATE` (spec clarification #2 — recorded in spec.md, no separate R-entry needed) |
| `checkLock` semantics | Read-only, no side-effects (spec clarification #3) |
| `dashboard_pid` meaning | `pg_backend_pid()` (spec clarification #1) |
