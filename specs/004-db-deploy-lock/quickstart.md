# Quickstart: Database-Backed Deploy Lock

**Phase 1 output** | **Date**: 2026-04-21

This feature replaces an internal coordination primitive. No new UI, no new environment variables, no new infrastructure. For admins, the rollout is invisible except that a specific class of "Is a directory" errors from imported deploy scripts stops happening.

---

## Preconditions

- DevOps Dashboard from `001-devops-app` + feature `003-scan-for-repos` deployed and running.
- Postgres 10 or newer (advisory locks exist since 9.1; the two-argument form `pg_try_advisory_lock(int4, int4)` since 9.1). Our devops-db runs Postgres 16 — already satisfied.
- Dashboard's DB role has read access to `pg_stat_activity` (default for non-superusers in self-hosted compose setups — verified).

---

## Rollout

1. Merge the feature branch.
2. `npm --prefix devops-app run db:migrate` — applies `0004_deploy_locks.sql` (creates `deploy_locks` table). Idempotent, run on every boot anyway via `server/index.ts`.
3. Restart dashboard (rolling restart is fine — advisory locks auto-release on the old process's connection close; the new process's first `reconcileOrphanLocks` scrubs the row).
4. Done.

No environment changes. No target-server changes. No filesystem changes.

## Verifying the migration worked

### Check table exists

```bash
ssh <prod-host> 'cd /path/to/devops-app && docker compose exec -T devops-db \
  psql -U dashboard -d dashboard -c "\d deploy_locks"'
```

Expected output:

```
                Table "public.deploy_locks"
    Column     |  Type   | ...
---------------+---------+----
 server_id     | text    | PK, FK → servers
 app_id        | text    | NOT NULL
 acquired_at   | text    | NOT NULL
 dashboard_pid | integer | NOT NULL
```

### Observe an active lock

Start a deploy from the dashboard UI, then while it runs:

```sql
SELECT * FROM deploy_locks;
SELECT pid, state, query FROM pg_stat_activity
  WHERE pid IN (SELECT dashboard_pid FROM deploy_locks);
```

Expected: one row in `deploy_locks` matching the server being deployed to; one live row in `pg_stat_activity` with `state='idle in transaction'` or similar (the reserved connection is pinned for the lock's duration).

After the deploy completes, both tables should be clean.

### Verify crash safety

Simulate a dashboard crash mid-deploy:

1. Start a deploy.
2. While it's running: `docker compose kill -s SIGKILL dashboard`.
3. `docker compose start dashboard`.
4. Check logs for `[startup] Reconciled N orphan deploy locks`.
5. `SELECT * FROM deploy_locks` → should be empty.
6. Retry deploy from UI → should acquire lock cleanly.

### Verify no filesystem lock is created on target

On the imported app's server (e.g. ai-twins host):

```bash
ssh ai-twins-non-root-prod "ls /tmp/devops-dashboard-deploy.lock.d 2>&1"
# Expected: ls: cannot access '/tmp/devops-dashboard-deploy.lock.d': No such file or directory
```

After upgrade, the dashboard never creates this path. Imported deploy scripts (like ai-digital-twins's `server-deploy-prod.sh` which uses `/tmp/deploy.lock` as a file) can collide with **themselves** but never with the dashboard.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Deploy fails with 500 `LOCK_ACQUIRE_ERROR` | Postgres unreachable or connection pool exhausted | Check `docker compose ps devops-db`; check `postgres` driver logs for pool stats |
| `deploy_locks` row persists after deploy success | `releaseLock` path swallowed an error during cleanup | Look for `[deploy-lock] Failed to release lock on ...` in dashboard logs; restart dashboard to trigger reconcile |
| Startup reconciliation didn't run | `reconcileOrphanLocks` threw and was swallowed | Logs will show `logger.warn({ err }, "Orphan reconciliation skipped")` — DB was unreachable; next successful startup will clean up |
| Two dashboards on same DB — only one acquires | Expected behaviour: advisory lock is DB-global. Rare HA concern; out of scope for v1 | If running multi-instance (not supported), coordinate with Postgres team |
| `deploy_locks` accumulates many rows | Reconciliation misconfigured, or running many concurrent deploys across many servers | Check `SELECT count(*) FROM deploy_locks` — normal fleet has <10; if >50 something's wrong |

---

## Rollback plan

If a critical bug surfaces and we need to revert:

1. Revert the feature commit(s).
2. Redeploy previous dashboard image.
3. The `deploy_locks` table stays in the DB — harmless, unused by the old code. Can be dropped manually when convenient:
   ```sql
   DROP TABLE deploy_locks;
   ```
4. Old SSH-based lock resumes working. Previously-fixed `/tmp/deploy.lock` name-collision bug returns unless the `LOCK_PATH` namespace change from the previous hotfix is also preserved (it is — that change is in feature 003 hotfixes, not in 004).

---

## Follow-ups

- **Multi-instance HA** — currently out of scope. When adding a second dashboard instance behind a load balancer, `dashboard_pid` alone no longer uniquely identifies the lock holder (two processes could race on the same Postgres PID namespace via pooling). Solution sketch: include `inet_server_addr()` or a per-instance UUID in the lock row; update reconciliation accordingly.
- **Admin force-unlock UI** — currently admins restart the dashboard to clear a stuck lock. A future `DELETE /api/servers/:id/lock` endpoint could expose a safer "force clear" that requires double-confirm. Low priority.
