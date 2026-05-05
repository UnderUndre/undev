/**
 * Feature 009 T033/T057 — bootstrap auto-retry + stuck-state reconciler.
 *
 * Runs every 5 minutes (FR-022). Two passes:
 *
 *   1. Auto-retry: any `failed_*` row with `bootstrap_auto_retry=true` whose
 *      last hour shows fewer than 3 auto-retry events → re-dispatch the
 *      step. Three consecutive failures within an hour disables auto-retry
 *      and fires a Telegram alert ("auto-retry stopped after 3 strikes").
 *
 *   2. Stuck-state recovery (Q7): any row in an in-flight state (`cloning`,
 *      `compose_up`, `healthcheck`, `proxy_applied`, `cert_issued`) with no
 *      `script_runs` row currently `running` → re-dispatch.
 *
 * Disabled when `BOOTSTRAP_RECONCILER_INTERVAL_MS=0` (operator opt-out;
 * fallback `5*60_000` mirrors feature 005's prune timer per memory).
 */

import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { applications, appBootstrapEvents, scriptRuns } from "../db/schema.js";
import { logger } from "../lib/logger.js";
import { notifier } from "./notifier.js";
import {
  bootstrapOrchestrator,
  type BootstrapStep,
} from "./bootstrap-orchestrator.js";

const DEFAULT_INTERVAL_MS = 5 * 60_000;
const RETRY_WINDOW_HOURS = 1;
const MAX_AUTO_RETRIES_PER_WINDOW = 3;

const FAILED_TO_STEP: Record<string, BootstrapStep> = {
  failed_clone: "cloning",
  failed_clone_pat_expired: "cloning",
  failed_compose: "compose_up",
  failed_healthcheck: "healthcheck",
  failed_proxy: "proxy_applied",
  failed_cert: "cert_issued",
};

const IN_FLIGHT_STATES: BootstrapStep[] = [
  "cloning",
  "compose_up",
  "healthcheck",
  "proxy_applied",
  "cert_issued",
];

let timer: ReturnType<typeof setInterval> | null = null;

export function startBootstrapReconciler(): void {
  const raw = process.env.BOOTSTRAP_RECONCILER_INTERVAL_MS;
  const intervalMs = raw === undefined ? DEFAULT_INTERVAL_MS : Number(raw);
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    logger.info({ ctx: "bootstrap-reconciler" }, "Disabled (interval ≤ 0)");
    return;
  }
  timer = setInterval(() => {
    void reconcile().catch((err: unknown) => {
      logger.error({ ctx: "bootstrap-reconciler", err }, "Reconcile crashed");
    });
  }, intervalMs);
  timer.unref?.();
  logger.info({ ctx: "bootstrap-reconciler", intervalMs }, "Started");
}

export function stopBootstrapReconciler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

export async function reconcile(): Promise<void> {
  await reconcileAutoRetries();
  await reconcileStuckStates();
}

async function reconcileAutoRetries(): Promise<void> {
  const rows = await db
    .select({
      id: applications.id,
      bootstrapState: applications.bootstrapState,
      serverId: applications.serverId,
      name: applications.name,
    })
    .from(applications)
    .where(
      and(
        eq(applications.bootstrapAutoRetry, true),
        sql`${applications.bootstrapState} LIKE 'failed_%'`,
      ),
    );

  for (const row of rows) {
    const fromStep = FAILED_TO_STEP[row.bootstrapState];
    if (!fromStep) continue;
    const recentRetries = await db
      .select({ count: sql<number>`COUNT(*)` })
      .from(appBootstrapEvents)
      .where(
        and(
          eq(appBootstrapEvents.appId, row.id),
          sql`${appBootstrapEvents.metadata}->>'reason' = 'auto_retry'`,
          sql`${appBootstrapEvents.occurredAt}::timestamptz > NOW() - INTERVAL '${sql.raw(String(RETRY_WINDOW_HOURS))} hour'`,
        ),
      );
    const count = Number(recentRetries[0]?.count ?? 0);
    if (count >= MAX_AUTO_RETRIES_PER_WINDOW) {
      logger.warn(
        { ctx: "bootstrap-reconciler", appId: row.id, count },
        "Auto-retry exhausted — disabling",
      );
      await db
        .update(applications)
        .set({ bootstrapAutoRetry: false })
        .where(eq(applications.id, row.id));
      await notifier
        .notify({
          serverId: row.serverId,
          event: "Bootstrap auto-retry stopped",
          details: `*${row.name}* exceeded ${MAX_AUTO_RETRIES_PER_WINDOW} auto-retries in the last hour. Auto-retry disabled.`,
        })
        .catch((err: unknown) =>
          logger.warn({ ctx: "bootstrap-reconciler", err }, "Telegram notify failed"),
        );
      continue;
    }
    await bootstrapOrchestrator
      .retryFromFailedStep(row.id, fromStep, "system")
      .catch((err: unknown) => {
        logger.warn(
          { ctx: "bootstrap-reconciler", appId: row.id, err },
          "Auto-retry dispatch failed",
        );
      });
  }
}

async function reconcileStuckStates(): Promise<void> {
  const rows = await db
    .select({
      id: applications.id,
      bootstrapState: applications.bootstrapState,
    })
    .from(applications)
    .where(
      sql`${applications.bootstrapState} IN ('cloning','compose_up','healthcheck','proxy_applied','cert_issued')`,
    );
  for (const row of rows) {
    if (!IN_FLIGHT_STATES.includes(row.bootstrapState as BootstrapStep)) continue;
    // Check whether a bootstrap/* run is currently `running` for this app.
    const running = await db
      .select({ id: scriptRuns.id })
      .from(scriptRuns)
      .where(
        and(
          eq(scriptRuns.status, "running"),
          sql`${scriptRuns.scriptId} LIKE 'bootstrap/%'`,
          sql`${scriptRuns.params}->>'appId' = ${row.id}`,
        ),
      )
      .limit(1);
    if (running.length > 0) continue;
    logger.info(
      { ctx: "bootstrap-reconciler", appId: row.id, state: row.bootstrapState },
      "Stuck state detected — re-dispatching",
    );
    await bootstrapOrchestrator
      .retryFromFailedStep(row.id, row.bootstrapState as BootstrapStep, "system")
      .catch((err: unknown) => {
        logger.warn(
          { ctx: "bootstrap-reconciler", appId: row.id, err },
          "Stuck-state re-dispatch failed",
        );
      });
  }
}
