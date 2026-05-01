/**
 * Feature 008 T051 — daily orphan cert cleanup job (FR-019).
 *
 * Deletes `app_certs` rows whose grace window elapsed:
 *   - domain_change   → 7 days
 *   - app_soft_delete → 30 days (LE rate-limit window)
 *   - manual_orphan   → 7 days
 *
 * For each deleted row, attempts SSH `rm -rf` on the Caddy storage path
 * `/var/lib/caddy/.local/share/caddy/certificates/.../<domain>` (best-effort).
 * Cascade removes `app_cert_events` automatically via FK ON DELETE CASCADE.
 */

import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { servers, applications } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { sshPool } from "./ssh-pool.js";
import { shQuote } from "../lib/sh-quote.js";
import { logger } from "../lib/logger.js";

interface DeletedRow extends Record<string, unknown> {
  id: string;
  app_id: string;
  domain: string;
}

export async function runOrphanCleanup(): Promise<{ deleted: number }> {
  const result = await db.execute<DeletedRow>(sql`
    DELETE FROM app_certs
     WHERE status = 'orphaned'
       AND (
         (orphan_reason = 'domain_change'   AND orphaned_at::timestamptz < NOW() - INTERVAL '7 days')
         OR
         (orphan_reason = 'app_soft_delete' AND orphaned_at::timestamptz < NOW() - INTERVAL '30 days')
         OR
         (orphan_reason = 'manual_orphan'   AND orphaned_at::timestamptz < NOW() - INTERVAL '7 days')
       )
    RETURNING id, app_id, domain
  `);
  const rows = result as unknown as DeletedRow[];
  if (rows.length === 0) return { deleted: 0 };

  logger.info({ ctx: "orphan-cleanup", deleted: rows.length }, "orphan certs deleted");

  for (const r of rows) {
    try {
      const [app] = await db
        .select({ serverId: applications.serverId })
        .from(applications)
        .where(eq(applications.id, r.app_id))
        .limit(1);
      if (!app) continue;
      await sshPool.exec(
        app.serverId,
        `rm -rf /var/lib/caddy/.local/share/caddy/certificates/*/${shQuote(r.domain)} 2>/dev/null || true`,
        15_000,
      );
    } catch (err) {
      logger.warn({ ctx: "orphan-cleanup-rm", err, certId: r.id, domain: r.domain }, "rm failed (best-effort)");
    }
  }
  return { deleted: rows.length };
}

let cronTimer: ReturnType<typeof setInterval> | null = null;

export function startOrphanCleanupCron(): void {
  if (cronTimer !== null) return;
  cronTimer = setInterval(() => {
    void runOrphanCleanup().catch((err) => {
      logger.error({ ctx: "orphan-cleanup-cron", err }, "tick failed");
    });
  }, 24 * 60 * 60 * 1000);
  cronTimer.unref();
  logger.info({ ctx: "orphan-cleanup-cron" }, "started (24h)");
}

export function stopOrphanCleanupCron(): void {
  if (cronTimer !== null) {
    clearInterval(cronTimer);
    cronTimer = null;
  }
}
