/**
 * Database-backed deploy lock.
 *
 * Replaces the previous SSH-`mkdir` based lock (`/tmp/devops-dashboard-deploy.lock.d`)
 * with a Postgres session-scoped advisory lock (`pg_try_advisory_lock`) pinned to
 * a reserved connection per held lock. Owner metadata lives in the `deploy_locks`
 * table.
 *
 * See specs/004-db-deploy-lock/{plan.md,data-model.md,research.md} for rationale.
 */

import type { ReservedSql } from "postgres";
import { client } from "../db/index.js";
import { logger } from "../lib/logger.js";

// Two-arg advisory-lock namespace (FR-002). Reserves the 32-bit "1" bucket for
// deploy locks so future features can pick 2, 3, ... without collision.
export const DEPLOY_LOCK_NAMESPACE = 1;

// Watchdog tuning — overridable via env.
const DEPLOY_LOCK_MAX_AGE_MS = Number(process.env.DEPLOY_LOCK_MAX_AGE_MS ?? 1_800_000); // 30 min
const DEPLOY_LOCK_WATCHDOG_INTERVAL_MS = 60_000;

// In-process entry: the pinned reserved connection + acquire metadata for the
// pool-exhaustion watchdog (T014).
interface HeldEntry {
  reserved: ReservedSql;
  acquiredAt: number;
  appId: string;
}

class DeployLock {
  private readonly held = new Map<string, HeldEntry>();
  private watchdogTimer: NodeJS.Timeout | null = null;

  /** Starts the pool-exhaustion watchdog. Called from server/index.ts startup. */
  start(): void {
    if (this.watchdogTimer) return;
    this.watchdogTimer = setInterval(() => {
      void this.watchdogTick();
    }, DEPLOY_LOCK_WATCHDOG_INTERVAL_MS);
    // Don't keep the process alive just for this interval.
    this.watchdogTimer.unref();
  }

  /** Stops the watchdog. MUST be called first in the SIGTERM handler. */
  stop(): void {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  /** List of serverIds currently held by this instance (for shutdown iteration). */
  heldServerIds(): string[] {
    return [...this.held.keys()];
  }

  private async watchdogTick(): Promise<void> {
    const now = Date.now();
    const stale: string[] = [];
    for (const [serverId, entry] of this.held.entries()) {
      if (now - entry.acquiredAt > DEPLOY_LOCK_MAX_AGE_MS) {
        stale.push(serverId);
      }
    }
    for (const serverId of stale) {
      const entry = this.held.get(serverId);
      if (!entry) continue;
      logger.warn(
        {
          ctx: "deploy-lock-watchdog",
          serverId,
          appId: entry.appId,
          ageMs: now - entry.acquiredAt,
        },
        "Forcing release of stuck lock",
      );
      await this.releaseLock(serverId);
    }
  }

  /**
   * Attempt to acquire the lock for `serverId`, recording `appId` as owner.
   *
   * Returns `true` on success (connection pinned, row upserted),
   * `false` if another dashboard connection holds the advisory lock.
   *
   * Throws:
   *  - `Error("lock already held by this instance")` if this process already holds it.
   *  - Underlying postgres driver errors on infrastructure failure.
   */
  async acquireLock(serverId: string, appId: string): Promise<boolean> {
    if (this.held.has(serverId)) {
      throw new Error("lock already held by this instance");
    }

    const reserved = await client.reserve();
    let gotLock = false;

    try {
      await reserved.begin(async (tx) => {
        const probe = await tx<{ got: boolean }[]>`
          SELECT pg_try_advisory_lock(${DEPLOY_LOCK_NAMESPACE}, hashtext(${serverId})) AS got
        `;
        if (!probe[0]?.got) {
          // Another connection holds the advisory lock. Roll back (empty tx).
          return;
        }
        gotLock = true;
        await tx`
          INSERT INTO deploy_locks (server_id, app_id, acquired_at, dashboard_pid)
          VALUES (${serverId}, ${appId}, ${new Date().toISOString()}, pg_backend_pid())
          ON CONFLICT (server_id) DO UPDATE
            SET app_id = EXCLUDED.app_id,
                acquired_at = EXCLUDED.acquired_at,
                dashboard_pid = EXCLUDED.dashboard_pid
        `;
      });

      if (!gotLock) {
        // Didn't win the lock — return the clean connection to the pool.
        reserved.release();
        return false;
      }

      // Happy path: keep the reserved connection pinned so we can release later.
      this.held.set(serverId, {
        reserved,
        acquiredAt: Date.now(),
        appId,
      });
      return true;
    } catch (err) {
      // Pool-contamination guard (R-004): if the advisory lock was granted but
      // the transaction failed afterwards, the session still holds the lock.
      // We MUST nuke it before returning the connection to the pool — otherwise
      // the next pool consumer inherits our orphan lock.
      if (gotLock) {
        await reserved`SELECT pg_advisory_unlock_all()`.catch(() => {
          /* connection dead — Postgres already released */
        });
      }
      reserved.release();
      throw err;
    }
  }

  /**
   * Release any lock held by this instance for `serverId`. Idempotent — no-op
   * when no lock is held. Never throws; release errors are logged.
   */
  async releaseLock(serverId: string): Promise<void> {
    const entry = this.held.get(serverId);
    if (!entry) return;

    // Remove from `held` SYNCHRONOUSLY — before any await — so two concurrent
    // callers (e.g. route-driven release racing the watchdog) cannot both see
    // the entry and end up calling `reserved.release()` twice on the same
    // connection. porsager/postgres throws on double-release.
    this.held.delete(serverId);

    const { reserved } = entry;
    // DELETE and advisory-unlock must be INDEPENDENT: if the DELETE fails
    // (statement timeout, transient network blip, etc.), the unlock MUST still
    // run — otherwise the reserved connection goes back to the pool with our
    // session-scoped advisory lock still held, poisoning the next consumer.
    try {
      await reserved`DELETE FROM deploy_locks WHERE server_id = ${serverId}`;
    } catch (err) {
      logger.error(
        { ctx: "deploy-lock-release", serverId, err },
        "Failed to delete deploy_locks row",
      );
    }
    try {
      await reserved`SELECT pg_advisory_unlock(${DEPLOY_LOCK_NAMESPACE}, hashtext(${serverId}))`;
    } catch (err) {
      logger.error(
        { ctx: "deploy-lock-release", serverId, err },
        "Failed to release advisory lock",
      );
    }
    try {
      reserved.release();
    } catch (err) {
      logger.error(
        { ctx: "deploy-lock-release", serverId, err },
        "Failed to release reserved connection",
      );
    }
  }

  /**
   * Read-only lookup of the current owner of `serverId`'s lock.
   * Filters orphan rows whose backend PID is no longer in pg_stat_activity.
   */
  async checkLock(serverId: string): Promise<string | null> {
    const rows = await client<{ app_id: string }[]>`
      SELECT app_id FROM deploy_locks
      WHERE server_id = ${serverId}
        AND dashboard_pid IN (SELECT pid FROM pg_stat_activity)
      LIMIT 1
    `;
    return rows[0]?.app_id ?? null;
  }

  /**
   * Startup hook: delete rows whose owning backend is no longer alive.
   * Advisory locks owned by dead backends have already been auto-released by
   * Postgres — this query is pure metadata cleanup.
   */
  async reconcileOrphanLocks(): Promise<number> {
    const rows = await client<{ server_id: string }[]>`
      DELETE FROM deploy_locks
      WHERE dashboard_pid NOT IN (SELECT pid FROM pg_stat_activity)
      RETURNING server_id
    `;
    const serverIds = rows.map((r) => r.server_id);
    if (serverIds.length > 0) {
      logger.info(
        { ctx: "deploy-lock-reconcile", count: serverIds.length, serverIds },
        "Orphan locks cleaned",
      );
    }
    return serverIds.length;
  }

  /**
   * Self-check: verify the dashboard is not behind a transaction-mode pooler
   * (e.g. PgBouncer with `pool_mode = transaction`). Advisory locks travel with
   * a session, so a transaction-mode pooler would silently break the lock.
   *
   * Method: on a single reserved handle, issue `SELECT pg_backend_pid()` twice.
   * Identical PIDs ⇒ session-mode or direct connection (safe).
   * Divergent PIDs ⇒ pooler is multiplexing queries across backends.
   *
   * Set env `DEPLOY_LOCK_SKIP_POOL_CHECK=1` to bypass.
   */
  async assertDirectConnection(): Promise<void> {
    if (process.env.DEPLOY_LOCK_SKIP_POOL_CHECK === "1") return;

    const reserved = await client.reserve();
    try {
      const first = await reserved<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      const second = await reserved<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      const pid1 = first[0]?.pid;
      const pid2 = second[0]?.pid;
      if (pid1 == null || pid2 == null || pid1 !== pid2) {
        throw new Error(
          "transaction-mode pooler detected between dashboard and Postgres — " +
            "advisory locks cannot function. Set DEPLOY_LOCK_SKIP_POOL_CHECK=1 to bypass.",
        );
      }
    } finally {
      reserved.release();
    }
  }
}

export const deployLock = new DeployLock();
