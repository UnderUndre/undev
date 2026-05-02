/**
 * Shared SSH lazy-connect helper. Used by:
 *   - logs.ts file-tail endpoint (incident 2026-05-02)
 *   - caddy-reconciler.ts cron (mirror of above — was spamming
 *     "Caddy unreachable: No active SSH connection" every 5 min after
 *     dashboard restart wiped the in-memory pool)
 *   - boot reconnect job (parallel pool restore on dashboard startup)
 *
 * Returns true if a working SSH connection now exists for `serverId`,
 * false otherwise. Never throws — caller decides whether to surface the
 * failure (HTTP 503) or skip silently (background cron).
 */
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { servers } from "../db/schema.js";
import { sshPool } from "../services/ssh-pool.js";
import { logger } from "./logger.js";

export async function ensureSshConnected(serverId: string): Promise<boolean> {
  if (sshPool.isConnected(serverId)) return true;
  const [server] = await db
    .select()
    .from(servers)
    .where(eq(servers.id, serverId))
    .limit(1);
  if (!server) return false;
  try {
    await sshPool.connect({
      id: server.id,
      host: server.host,
      port: server.port,
      sshUser: server.sshUser,
      sshAuthMethod: (server.sshAuthMethod as "key" | "password") ?? "key",
      sshPrivateKey: server.sshPrivateKey,
      sshPassword: server.sshPassword,
    });
    return sshPool.isConnected(serverId);
  } catch (err) {
    logger.warn(
      { ctx: "ssh-lazy-connect", serverId, err },
      "lazy-connect failed",
    );
    return false;
  }
}

/**
 * Boot-time pool restore. Reads every row from `servers`, fires connects in
 * parallel via `Promise.allSettled` so a single dead box doesn't block boot.
 * Logs per-server outcome — operator sees connectivity matrix at startup.
 */
export async function restoreSshPoolFromDb(): Promise<void> {
  const rows = await db.select().from(servers);
  if (rows.length === 0) {
    logger.info({ ctx: "ssh-boot-restore" }, "no servers to restore");
    return;
  }
  logger.info(
    { ctx: "ssh-boot-restore", count: rows.length },
    "restoring SSH pool from DB",
  );
  const results = await Promise.allSettled(
    rows.map(async (server) => {
      try {
        await sshPool.connect({
          id: server.id,
          host: server.host,
          port: server.port,
          sshUser: server.sshUser,
          sshAuthMethod: (server.sshAuthMethod as "key" | "password") ?? "key",
          sshPrivateKey: server.sshPrivateKey,
          sshPassword: server.sshPassword,
        });
        return { id: server.id, label: server.label, ok: true };
      } catch (err) {
        return {
          id: server.id,
          label: server.label,
          ok: false,
          err: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );
  let okCount = 0;
  let failCount = 0;
  for (const r of results) {
    if (r.status === "fulfilled" && r.value.ok) {
      okCount++;
      logger.info(
        { ctx: "ssh-boot-restore", serverId: r.value.id, label: r.value.label },
        "SSH connected",
      );
    } else {
      failCount++;
      const v = r.status === "fulfilled" ? r.value : { id: "?", label: "?", err: r.reason };
      logger.warn(
        { ctx: "ssh-boot-restore", serverId: v.id, label: v.label, err: v.err },
        "SSH connect failed (will lazy-retry on demand)",
      );
    }
  }
  logger.info(
    { ctx: "ssh-boot-restore", ok: okCount, failed: failCount },
    "SSH pool restore complete",
  );
}
