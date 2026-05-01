/**
 * Feature 008 T028/T029/T068/T071 — Caddy reconciler.
 *
 * Three triggers:
 *   1. on-write (route handlers call `reconcile(serverId)`)
 *   2. 5-minute drift cron (`startDriftCron()`)
 *   3. manual UI "Reconcile now" (P3 — just calls `reconcile`)
 *
 * Per FR-009 / FR-017a / FR-006b:
 *   - Caddy unreachable → mark non-active certs `pending_reconcile`, debounce
 *     Telegram alert per server.
 *   - `applications.domain IS NULL AND proxy_type = 'caddy'` → site removal trigger
 *     (NOT a no-op). The builder excludes the app; the `/load` PUT trims it.
 *   - Drift-detection cron + on-write: serialised by Postgres SELECT FOR UPDATE
 *     on the applications row inside a Drizzle transaction (FR drift-edge case).
 */

import { sql, and, eq, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { applications, appCerts, appSettings, servers } from "../db/schema.js";
import { caddyAdminClient, CaddyAdminError } from "./caddy-admin-client.js";
import {
  buildCaddyConfig,
  type AppForCaddy,
  type OrphanGraceCert,
} from "./caddy-config-builder.js";
import { notifier } from "./notifier.js";
import { logger } from "../lib/logger.js";
import { channelManager } from "../ws/channels.js";

export type ReconcileResult =
  | { ok: true; serverId: string }
  | { ok: false; serverId: string; err: CaddyAdminError };

const UNREACHABLE_DEBOUNCE_MS = 5 * 60 * 1000;
const lastUnreachableAlert = new Map<string, number>();
const lastReachableAt = new Map<string, number>();

async function loadGlobalAcmeEmail(): Promise<string | null> {
  const [row] = await db
    .select()
    .from(appSettings)
    .where(eq(appSettings.key, "acme_email"))
    .limit(1);
  return row?.value ?? null;
}

async function loadAppsForServer(serverId: string): Promise<AppForCaddy[]> {
  const rows = await db
    .select({
      id: applications.id,
      name: applications.name,
      remotePath: applications.remotePath,
      domain: applications.domain,
      proxyType: applications.proxyType,
      acmeEmail: applications.acmeEmail,
      upstreamService: applications.upstreamService,
      upstreamPort: applications.upstreamPort,
    })
    .from(applications)
    .where(eq(applications.serverId, serverId));
  return rows;
}

async function loadGraceCerts(appIds: string[]): Promise<OrphanGraceCert[]> {
  if (appIds.length === 0) return [];
  const rows = await db
    .select({
      appId: appCerts.appId,
      domain: appCerts.domain,
      orphanReason: appCerts.orphanReason,
      orphanedAt: appCerts.orphanedAt,
    })
    .from(appCerts)
    .where(
      and(
        eq(appCerts.status, "orphaned"),
        inArray(appCerts.appId, appIds),
      ),
    );
  return rows;
}

/**
 * Reconcile a single server's Caddy config to match DB desired state.
 * Wrapped in a Drizzle transaction with `SELECT FOR UPDATE` on applications
 * rows to serialise vs concurrent operator-domain-change handlers (T071).
 */
export async function reconcile(serverId: string): Promise<ReconcileResult> {
  return await db.transaction(async (tx) => {
    // T071 — row-level lock on every applications row for this server.
    await tx.execute(sql`
      SELECT 1 FROM ${applications}
       WHERE ${applications.serverId} = ${serverId}
       FOR UPDATE
    `);

    const apps = await tx
      .select({
        id: applications.id,
        name: applications.name,
        remotePath: applications.remotePath,
        domain: applications.domain,
        proxyType: applications.proxyType,
        acmeEmail: applications.acmeEmail,
        upstreamService: applications.upstreamService,
        upstreamPort: applications.upstreamPort,
      })
      .from(applications)
      .where(eq(applications.serverId, serverId));

    const [globalEmailRow] = await tx
      .select()
      .from(appSettings)
      .where(eq(appSettings.key, "acme_email"))
      .limit(1);
    const globalAcmeEmail = globalEmailRow?.value ?? null;

    const graceCerts =
      apps.length === 0
        ? []
        : await tx
            .select({
              appId: appCerts.appId,
              domain: appCerts.domain,
              orphanReason: appCerts.orphanReason,
              orphanedAt: appCerts.orphanedAt,
            })
            .from(appCerts)
            .where(
              and(
                eq(appCerts.status, "orphaned"),
                inArray(
                  appCerts.appId,
                  apps.map((a) => a.id),
                ),
              ),
            );

    const desired = buildCaddyConfig({
      apps,
      globalAcmeEmail,
      graceCerts,
    });

    try {
      await caddyAdminClient.load(serverId, desired);
      lastReachableAt.set(serverId, Date.now());
      // Clear previous pending_reconcile markers for this server's apps.
      if (apps.length > 0) {
        await tx
          .update(appCerts)
          .set({ status: "pending" })
          .where(
            and(
              inArray(
                appCerts.appId,
                apps.map((a) => a.id),
              ),
              eq(appCerts.status, "pending_reconcile"),
            ),
          );
      }
      logger.info(
        { ctx: "caddy-reconciler", serverId, apps: apps.length },
        "reconciled",
      );
      return { ok: true, serverId } as const;
    } catch (err) {
      if (err instanceof CaddyAdminError) {
        if (apps.length > 0) {
          await tx
            .update(appCerts)
            .set({
              status: sql`CASE WHEN ${appCerts.status} = 'active' THEN 'active' ELSE 'pending_reconcile' END`,
            })
            .where(
              inArray(
                appCerts.appId,
                apps.map((a) => a.id),
              ),
            );
        }
        await maybeFireUnreachable(serverId, err);
        logger.error(
          { ctx: "caddy-reconciler", serverId, kind: err.kind, err },
          "Caddy unreachable",
        );
        return { ok: false, serverId, err } as const;
      }
      throw err;
    }
  });
}

async function maybeFireUnreachable(serverId: string, err: CaddyAdminError): Promise<void> {
  const now = Date.now();
  const last = lastUnreachableAlert.get(serverId) ?? 0;
  if (now - last < UNREACHABLE_DEBOUNCE_MS) return;
  lastUnreachableAlert.set(serverId, now);

  const [srv] = await db.select().from(servers).where(eq(servers.id, serverId)).limit(1);
  const reachableAt = lastReachableAt.get(serverId);
  const lastSuccessAgoMs = reachableAt === undefined ? null : now - reachableAt;
  void notifier.notifyCaddyUnreachable({
    serverId,
    serverLabel: srv?.label ?? serverId,
    lastSuccessAgoMs,
  });
  channelManager.broadcast(`server:${serverId}`, {
    type: "caddy.unreachable",
    data: {
      serverId,
      serverLabel: srv?.label ?? serverId,
      lastReachableAt: reachableAt === undefined ? null : new Date(reachableAt).toISOString(),
      errorKind: err.kind,
      errorMessage: err.message,
    },
  });
}

// ── Drift cron (T029) ──────────────────────────────────────────────────────
let driftTimer: ReturnType<typeof setInterval> | null = null;
const inflightServers = new Set<string>();

export async function reconcileAllServers(): Promise<void> {
  const rows = await db.select().from(servers);
  for (const srv of rows) {
    if (inflightServers.has(srv.id)) continue;
    inflightServers.add(srv.id);
    void reconcile(srv.id)
      .catch((err) => {
        logger.error({ ctx: "caddy-reconciler-cron", err, serverId: srv.id }, "tick failed");
      })
      .finally(() => {
        inflightServers.delete(srv.id);
      });
  }
}

export function startDriftCron(): void {
  if (driftTimer !== null) return;
  driftTimer = setInterval(() => {
    void reconcileAllServers();
  }, 5 * 60 * 1000);
  driftTimer.unref();
  logger.info({ ctx: "caddy-reconciler-cron" }, "drift cron started (5min)");
}

export function stopDriftCron(): void {
  if (driftTimer !== null) {
    clearInterval(driftTimer);
    driftTimer = null;
  }
}

/** Test helper — clear in-memory debounce/inflight state. */
export function __resetForTests(): void {
  lastUnreachableAlert.clear();
  lastReachableAt.clear();
  inflightServers.clear();
}

export { loadGlobalAcmeEmail, loadAppsForServer, loadGraceCerts };
