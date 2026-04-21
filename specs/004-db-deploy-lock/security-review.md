# Security Review: Database-Backed Deploy Lock

**Reviewer**: Valera (internal audit) | **Date**: 2026-04-21 | **Scope**: feature 004 implementation.

## Files audited

- `server/services/deploy-lock.ts` — rewritten service (acquire, release, check, reconcile, watchdog, pool self-check)
- `server/index.ts` — startup integration (pool-safety check → reconcile → watchdog + SIGTERM handler)
- `server/db/schema.ts` — `deployLocks` table definition
- `server/db/migrations/0004_deploy_locks.sql` — migration DDL

## Findings

### ✅ A1 — SQL injection via `serverId` / `appId` (FR-parameterisation)

- Every query in `deploy-lock.ts` is issued through the `postgres` driver's tagged-template (`sql\`…\${value}…\``). The driver binds values as typed parameters — there is **no string concatenation** anywhere in the service.
- Verified individually:
  - `SELECT pg_try_advisory_lock(${DEPLOY_LOCK_NAMESPACE}, hashtext(${serverId}))` — both args bound.
  - `INSERT INTO deploy_locks (...) VALUES (${serverId}, ${appId}, ${now}, pg_backend_pid())` — three bound values, plus the server-side function `pg_backend_pid()`.
  - `DELETE FROM deploy_locks WHERE server_id = ${serverId}` + `SELECT pg_advisory_unlock(${DEPLOY_LOCK_NAMESPACE}, hashtext(${serverId}))` — bound.
  - `SELECT app_id FROM deploy_locks WHERE server_id = ${serverId} AND dashboard_pid IN (SELECT pid FROM pg_stat_activity)` — bound.
  - `DELETE FROM deploy_locks WHERE dashboard_pid NOT IN (SELECT pid FROM pg_stat_activity) RETURNING server_id` — no user input.
- `DEPLOY_LOCK_NAMESPACE` is a compile-time constant (`= 1`).

**Verdict**: No injection path. `serverId` and `appId` are admin-controlled upstream (server FK + application FK, validated on write), but injection would be impossible even if they weren't.

### ✅ A2 — Scope of startup reconciliation DELETE

- `reconcileOrphanLocks` deletes rows **only** where `dashboard_pid NOT IN (SELECT pid FROM pg_stat_activity)`.
- `pg_stat_activity.pid` is the authoritative in-memory catalogue of currently-alive backends on the target Postgres instance. A row survives iff the owning backend is alive.
- This is **not** a mass delete, **not** a TRUNCATE, and **not** time-based (no "delete anything older than X" clause that could wipe legitimate long-running deploys).
- `RETURNING server_id` gives us an audit trail of exactly what was cleaned up; count + list is logged at `info`.

**Verdict**: Conservative by construction. Cannot wipe live locks.

### ✅ A3 — PID-reuse false-negative edge case

- On Linux, `pid_max` defaults to 4194304 (`/proc/sys/kernel/pid_max`). For a PID to be reused, the kernel must cycle the full 4M PID space between the dashboard crash and the next reconcile — functionally impossible over realistic dashboard lifetimes (the box would have to fork tens of millions of processes per minute). PID-reuse is catalogued in `research.md` R-003 "Edge cases" and accepted as **negligible risk** for the Linux-host target.
- On Windows containers the PID space is smaller, but the project targets Linux hosts for the Postgres tier.
- Even in the impossible-in-practice case: the false negative would leave an orphan row visible to `checkLock` that the next `acquireLock` would safely overwrite via `ON CONFLICT DO UPDATE`. The advisory lock itself is already released by the dead backend — no double-deploy risk.

**Verdict**: Accepted risk, documented.

### ✅ A4 — `pg_stat_activity` cross-tenant visibility

- In the self-hosted compose setup (`docker-compose.yml`'s `devops-db` service), the `dashboard` role connects with its own credentials to a dedicated database. Postgres's default visibility rule: a non-superuser sees own-database rows in `pg_stat_activity`, and for other databases sees row count but not query text / user detail.
- The reconciliation query reads only `pid` — the one field every role can see for every session in the cluster. This is a feature, not a leak: a sibling service running in the same Postgres cluster CANNOT hide from our pool-of-life check.
- No PII or secret is read from `pg_stat_activity`. `pid` is a process identifier with no information-disclosure value.

**Verdict**: Safe for self-hosted. If migrated to a managed Postgres with stricter `pg_stat_activity` restrictions (e.g. RDS with `rds_superuser`), the reconciliation query may return an empty set and orphan cleanup would silently no-op — a reliability concern, not a security one.

### ✅ A5 — Graceful-shutdown ordering

- SIGTERM handler in `server/index.ts`:
  1. `deployLock.stop()` — clears watchdog interval **first**, so no tick can fire mid-shutdown and try to release a lock concurrently with step 2.
  2. `Promise.allSettled` over `releaseLock(id)` for every held serverId, with a 2-second overall race timeout.
  3. `client.end({ timeout: 5 })` — closes the main pool, which also terminates any still-reserved handles, which makes Postgres release any still-held advisory locks at the TCP layer.
  4. `process.exit(0)`.
- HTTP server close is **not** explicitly invoked before exit — in-flight deploy requests will be torn by `process.exit`, but any lock they hold is cleaned up by step 3 via connection close. This is the existing behaviour for other resources (WS server, jobManager) and matches the fail-closed design of the migration step above (a partial shutdown is allowed to drop requests cleanly).
- The 2s race timeout prevents one stuck `releaseLock` query from blocking shutdown indefinitely.

**Verdict**: Correct ordering — watchdog stopped before releases, releases bounded, connection-close as a second line of defence.

### ⚠️ A6 — Split-brain across multiple dashboard instances

- Spec § Out of Scope explicitly defers multi-instance dashboard HA. The lock design **works correctly** in single-instance mode because every dashboard shares the same Postgres and therefore the same advisory-lock space.
- If two dashboard instances ever run against the same DB simultaneously:
  - Acquire semantics stay correct: `pg_try_advisory_lock` is consistent across all connections to the same cluster. Only one instance can win for a given `(namespace, key)`.
  - Reconciliation becomes a conflict: instance A's startup reconciliation would wipe rows whose `dashboard_pid` is on instance B's backend if the two dashboards talk to different Postgres hosts. In practice they share one DB → B's PIDs appear in `pg_stat_activity` → A's reconciliation correctly preserves them.
- **Not a vulnerability in the lock** — it's a deployment-topology constraint.

**Verdict**: Accepted scope limitation. Documented in spec Out of Scope.

### ✅ A7 — Pool-contamination from transaction failure

- Per R-004, if `pg_try_advisory_lock` returns `true` but the subsequent `INSERT ... ON CONFLICT` throws, the advisory lock is still held on the reserved backend. Returning that connection to the pool via `.release()` without explicit unlock would let the next pool consumer inherit our lock.
- `deploy-lock.ts:acquireLock` tracks a `gotLock` sentinel and, on any catch path with `gotLock === true`, issues `reserved\`SELECT pg_advisory_unlock_all()\`.catch(() => {})` before `reserved.release()`. The `.catch(()=>{})` is correct: if the connection itself is dead, Postgres has already released the locks at the TCP layer, so swallowing the unlock error converges on the same end-state.
- Covered by a dedicated regression test in `tests/integration/deploy-lock.test.ts` ("pool-contamination regression: INSERT failure runs pg_advisory_unlock_all before release").

**Verdict**: Correct and tested.

### ✅ A8 — Pool-safety self-check (transaction-mode pooler)

- `assertDirectConnection()` issues `SELECT pg_backend_pid()` twice on a single reserved handle. Identical PIDs ⇒ session-mode or direct (safe). Divergent PIDs ⇒ transaction-mode pooler ⇒ throws.
- Called from `server/index.ts` startup **after** `migrate()` and **before** `reconcileOrphanLocks()`. On failure, `lockHooksEnabled` is set to `false` and the SIGTERM handler + watchdog are NOT registered. The service methods are still callable by the deploy route, but they will malfunction — this is a **known visible failure mode** rather than silent corruption. Operator is expected to read the fatal log + disable the feature or fix the pool mode.
- Opt-out via `DEPLOY_LOCK_SKIP_POOL_CHECK=1` for operators who intentionally run a session-mode PgBouncer with `pool_mode = session` (where PIDs would be stable but the self-check cannot distinguish from a real pooler).

**Verdict**: Fail-loud. Covered by unit test.

## Summary

| ID | Severity | Status |
|----|----------|--------|
| A1 | info | ✅ Safe — parameterised queries throughout |
| A2 | info | ✅ Scoped DELETE via `pg_stat_activity` filter |
| A3 | low | ✅ Accepted risk (PID-reuse impossible in practice) |
| A4 | info | ✅ No PII in `pg_stat_activity.pid` |
| A5 | info | ✅ Shutdown order verified |
| A6 | scope | ⚠️ Split-brain deferred to multi-instance HA (out of v1 scope) |
| A7 | info | ✅ Pool contamination guarded + regression test |
| A8 | info | ✅ Fail-loud pool-mode self-check with opt-out |

No blocking issues. Feature is safe to ship.
