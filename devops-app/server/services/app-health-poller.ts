// Feature 006 — per-application health poller.
//
// Phase 1 shipped the retention prune lifecycle. Phase 2 adds:
//   - per-app probe scheduling via recursive setTimeout chain (R-001)
//   - deploy-lock interlock (FR-011) — read-only, never acquires
//   - 4 probe runners (container, http, cert_expiry, caddy_admin)
//   - state-machine commit with debounce (FR-007..FR-010)
//   - WebSocket fan-out + Telegram notifier wiring with FR-018 mute asymmetry
//
// Per-app cycle keys by appId; per-server Caddy cycle keys by serverId.
// Daily cert sweep is a single timer iterating apps with non-NULL domain.

import { randomUUID } from "node:crypto";
import { and, eq, isNotNull, lt, sql } from "drizzle-orm";
import { db, client } from "../db/index.js";
import {
  appHealthProbes,
  applications,
  servers,
  deployLocks,
} from "../db/schema.js";
import { logger } from "../lib/logger.js";
import { channelManager } from "../ws/channels.js";
import { notifier } from "./notifier.js";
import { runContainerProbe } from "./probes/container.js";
import { runHttpProbe } from "./probes/http.js";
import { runCertExpiryProbe } from "./probes/cert-expiry.js";
import { runCaddyAdminProbe } from "./probes/caddy-admin.js";
import type { AppProbeRow, ProbeOutcome, ServerProbeRow } from "./probes/types.js";

const DEFAULT_RETENTION_DAYS = 30;
const PRUNE_INTERVAL_MS = 24 * 3600 * 1000;
const CADDY_INTERVAL_MS = 60_000;
const DAILY_CERT_INTERVAL_MS = 24 * 3600 * 1000;
const MIN_INTERVAL_MS = 10_000; // FR-002 lower bound

// ──────────────────────────────────────────────────────────────────────────
// Retention prune (Phase 1, kept intact)
// ──────────────────────────────────────────────────────────────────────────

function resolveRetentionDays(): number {
  const raw = process.env.HEALTH_PROBE_RETENTION_DAYS;
  if (raw === undefined || raw === "") return DEFAULT_RETENTION_DAYS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    logger.warn(
      { ctx: "app-health-prune", raw },
      "HEALTH_PROBE_RETENTION_DAYS invalid — using default 30",
    );
    return DEFAULT_RETENTION_DAYS;
  }
  return parsed;
}

export async function pruneOldProbes(retentionDays: number): Promise<number> {
  const cutoffIso = new Date(
    Date.now() - retentionDays * 24 * 3600 * 1000,
  ).toISOString();
  const result = await db
    .delete(appHealthProbes)
    .where(lt(appHealthProbes.probedAt, cutoffIso))
    .returning({ id: appHealthProbes.id });
  return result.length;
}

let pruneTimer: ReturnType<typeof setInterval> | null = null;

export async function startRetentionPrune(): Promise<void> {
  if (pruneTimer !== null) return;
  const retentionDays = resolveRetentionDays();
  try {
    const deleted = await pruneOldProbes(retentionDays);
    logger.info(
      { ctx: "app-health-prune", retentionDays, deleted },
      "Initial prune complete",
    );
  } catch (err) {
    logger.error(
      { ctx: "app-health-prune", err },
      "Initial prune failed — scheduling daily retry anyway",
    );
  }
  pruneTimer = setInterval(() => {
    pruneOldProbes(retentionDays)
      .then((deleted) =>
        logger.info(
          { ctx: "app-health-prune", retentionDays, deleted },
          "Daily prune complete",
        ),
      )
      .catch((err) =>
        logger.error(
          { ctx: "app-health-prune", err },
          "Daily prune failed — will retry next interval",
        ),
      );
  }, PRUNE_INTERVAL_MS);
  pruneTimer.unref();
}

export function stopRetentionPrune(): void {
  if (pruneTimer !== null) {
    clearInterval(pruneTimer);
    pruneTimer = null;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Scheduler state
// ──────────────────────────────────────────────────────────────────────────

interface AppPollState {
  appId: string;
  intervalMs: number;
  isPolling: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  consecutive: { healthy: number; unhealthy: number; unknown: number };
}

interface CaddyPollState {
  serverId: string;
  isPolling: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  consecutive: { healthy: number; unhealthy: number };
  lastHealthyAt: number | null;
  lastUnhealthyAt: number | null;
  status: "healthy" | "unhealthy" | "unknown";
}

type AppRow = typeof applications.$inferSelect;
type ServerRow = typeof servers.$inferSelect;

function appRowToProbeRow(app: AppRow): AppProbeRow {
  // `domain` is feature-008 owned; not present on this row in feature 006
  // schema. Tests/wiring may patch it via reloadApp() if/when 008 ships.
  return {
    id: app.id,
    serverId: app.serverId,
    name: app.name,
    remotePath: app.remotePath,
    healthUrl: app.healthUrl,
    domain: null,
  };
}

/**
 * Minimal `now()` indirection so unit tests can pin time.
 */
function nowIso(): string {
  return new Date().toISOString();
}

// ──────────────────────────────────────────────────────────────────────────
// State-machine commit (FR-007..FR-010, FR-013, FR-018, R-011)
// ──────────────────────────────────────────────────────────────────────────

export type EffectiveOutcome = "healthy" | "unhealthy" | "unknown";

/**
 * FR-006: any unhealthy probe → unhealthy. All healthy → healthy. Otherwise
 * unknown. Cert-expiry probe outcomes do NOT influence overall app state
 * (FR-006a) — only container + http participate.
 */
export function computeEffectiveOutcome(
  container: ProbeOutcome | null,
  http: ProbeOutcome | null,
): EffectiveOutcome {
  const considered = [container, http].filter(
    (p): p is ProbeOutcome => p !== null && p.probeType !== "cert_expiry",
  );
  if (considered.length === 0) return "unknown";
  if (considered.some((p) => p.outcome === "unhealthy")) return "unhealthy";
  if (considered.every((p) => p.outcome === "healthy")) return "healthy";
  // mix of healthy + error/warning: insufficient evidence
  return "unknown";
}

function messageFromOutcomes(c: ProbeOutcome | null, h: ProbeOutcome | null): string | null {
  const reasons: string[] = [];
  if (c && c.outcome !== "healthy" && c.errorMessage !== null) {
    reasons.push(`container: ${c.errorMessage}`);
  }
  if (h && h.outcome !== "healthy" && h.errorMessage !== null) {
    reasons.push(`http: ${h.errorMessage}`);
  }
  return reasons.length === 0 ? null : reasons.join("; ");
}

export interface CommitDeps {
  /** Loads server row for notifier payload. Defaults to live DB. */
  loadServer?: (serverId: string) => Promise<ServerRow | null>;
  /** Builds dashboard deep-link for `[Open](...)` markdown. Defaults to BASE_URL env. */
  buildDeepLink?: (appId: string) => string;
  now?: () => Date;
}

function defaultDeepLink(appId: string): string {
  const base = process.env.DASHBOARD_BASE_URL;
  if (base === undefined || base === "") {
    return `/apps/${appId}`;
  }
  return `${base.replace(/\/$/, "")}/apps/${appId}`;
}

/**
 * Persist a batch of probe outcomes to `app_health_probes`. XOR app/server
 * is enforced at the DB level via the migration's CHECK constraint.
 */
export async function persistProbes(
  outcomes: Array<{ appId: string | null; serverId: string | null; outcome: ProbeOutcome }>,
): Promise<void> {
  if (outcomes.length === 0) return;
  const probedAt = nowIso();
  const rows = outcomes.map((entry) => ({
    id: randomUUID(),
    appId: entry.appId,
    serverId: entry.serverId,
    probedAt,
    probeType: entry.outcome.probeType,
    outcome: entry.outcome.outcome,
    latencyMs: entry.outcome.latencyMs,
    statusCode: entry.outcome.statusCode,
    errorMessage: entry.outcome.errorMessage,
    containerStatus: entry.outcome.containerStatus,
  }));
  await db.insert(appHealthProbes).values(rows);
}

/**
 * State-machine commit. Called once per app per tick after probes complete.
 *
 * FR-013 / R-011 freshness: `health_checked_at` + `health_message` updated
 * on every probe.
 * FR-007..FR-010 correctness: `health_status` + `health_last_change_at`
 * updated ONLY when the consecutive counter clears the configured debounce
 * AND the outcome differs from the previously committed status.
 *
 * FR-018: when crossing the healthy↔unhealthy boundary, ALWAYS broadcast
 * the WS event and ALWAYS commit DB state. ONLY the Telegram dispatch is
 * gated behind `app.alertsMuted` — mute is a notification-channel filter,
 * never a tracking-suppression toggle.
 */
export async function commitState(
  app: AppRow,
  state: AppPollState,
  newOutcome: EffectiveOutcome,
  c: ProbeOutcome | null,
  h: ProbeOutcome | null,
  deps: CommitDeps = {},
): Promise<void> {
  const prev = (app.healthStatus as EffectiveOutcome) ?? "unknown";

  // Update consecutive counters.
  state.consecutive[newOutcome] = (state.consecutive[newOutcome] ?? 0) + 1;
  if (newOutcome === "healthy") state.consecutive.unhealthy = 0;
  if (newOutcome === "unhealthy") state.consecutive.healthy = 0;

  const message = messageFromOutcomes(c, h);
  // R-011 freshness write — every probe.
  await db
    .update(applications)
    .set({
      healthCheckedAt: nowIso(),
      healthMessage: message,
    })
    .where(eq(applications.id, app.id));

  const debounceN = Math.max(1, app.healthDebounceCount);
  const counter = state.consecutive[newOutcome];
  if (counter < debounceN) return;
  if (newOutcome === prev) return;

  // Snapshot prev change-at BEFORE the commit so downtime is correct.
  const prevChangeAtIso = app.healthLastChangeAt;
  const newChangeAtIso = nowIso();
  await db
    .update(applications)
    .set({
      healthStatus: newOutcome,
      healthLastChangeAt: newChangeAtIso,
    })
    .where(eq(applications.id, app.id));

  // Always broadcast WS — UI updates regardless of mute (FR-018).
  channelManager.broadcast(`app-health:${app.id}`, {
    type: "health-changed",
    data: {
      from: prev,
      to: newOutcome,
      at: newChangeAtIso,
      reason: message,
    },
  });
  channelManager.broadcast(`server-apps-health:${app.serverId}`, {
    type: "app-health-changed",
    data: { appId: app.id, status: newOutcome, at: newChangeAtIso },
  });

  // Telegram alerts: FR-008 silent on unknown→healthy; FR-009/FR-010 fire
  // only on healthy↔unhealthy crossings; FR-018 mute filters Telegram only.
  const cross =
    (prev === "healthy" && newOutcome === "unhealthy") ||
    (prev === "unhealthy" && newOutcome === "healthy");
  if (!cross) return;
  if (app.alertsMuted) {
    logger.info(
      { ctx: "app-health-commit", appId: app.id, prev, newOutcome },
      "transition committed; Telegram suppressed (alertsMuted)",
    );
    return;
  }

  const loadServer =
    deps.loadServer ??
    (async (sid: string): Promise<ServerRow | null> => {
      const [row] = await db.select().from(servers).where(eq(servers.id, sid));
      return row ?? null;
    });
  const buildLink = deps.buildDeepLink ?? defaultDeepLink;
  const server = await loadServer(app.serverId);
  if (server === null) {
    logger.warn(
      { ctx: "app-health-commit", appId: app.id, serverId: app.serverId },
      "server row missing during alert dispatch",
    );
    return;
  }

  const transition: "to-unhealthy" | "to-healthy" =
    newOutcome === "unhealthy" ? "to-unhealthy" : "to-healthy";
  const downtimeMs =
    transition === "to-healthy" && prevChangeAtIso !== null
      ? Math.max(0, Date.now() - new Date(prevChangeAtIso).getTime())
      : undefined;
  try {
    await notifier.notifyAppHealthChange({
      appId: app.id,
      appName: app.name,
      serverLabel: server.label,
      transition,
      reason: message ?? undefined,
      downtimeMs,
      deepLink: buildLink(app.id),
    });
  } catch (err) {
    // FR-017: notifier failures MUST NOT crash the probe loop.
    logger.warn(
      { ctx: "app-health-commit", appId: app.id, err },
      "notifier dispatch failed",
    );
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Scheduler (T006)
// ──────────────────────────────────────────────────────────────────────────

class AppHealthPoller {
  private appPolls = new Map<string, AppPollState>();
  private serverCaddyPolls = new Map<string, CaddyPollState>();
  private dailyCertTimer: ReturnType<typeof setInterval> | null = null;
  private inFlight = new Map<string, Promise<EffectiveOutcome>>();

  async start(): Promise<void> {
    const apps = await db
      .select()
      .from(applications)
      .where(eq(applications.monitoringEnabled, true));
    for (const app of apps) this.scheduleAppCycle(app);
    const serverIds = await this.serversWithApps();
    for (const sid of serverIds) this.scheduleCaddyCycle(sid);
    this.scheduleDailyCertSweep();
  }

  stop(): void {
    for (const [, state] of this.appPolls) {
      if (state.timer !== null) clearTimeout(state.timer);
    }
    this.appPolls.clear();
    for (const [, state] of this.serverCaddyPolls) {
      if (state.timer !== null) clearTimeout(state.timer);
    }
    this.serverCaddyPolls.clear();
    if (this.dailyCertTimer !== null) {
      clearInterval(this.dailyCertTimer);
      this.dailyCertTimer = null;
    }
  }

  /**
   * PATCH /api/applications/:id/health/config calls this so the running tick
   * picks up cadence / mute / monitoringEnabled flips on the next iteration.
   */
  async reloadApp(appId: string): Promise<void> {
    const [row] = await db
      .select()
      .from(applications)
      .where(eq(applications.id, appId));
    if (!row || !row.monitoringEnabled) {
      this.stopApp(appId);
      return;
    }
    const existing = this.appPolls.get(appId);
    if (existing !== undefined && existing.timer !== null) {
      clearTimeout(existing.timer);
    }
    this.scheduleAppCycle(row);
  }

  /**
   * FR-023 Check Now — bypass cadence, run a single probe cycle immediately.
   * Idempotent: concurrent calls receive the same in-flight promise.
   */
  runOutOfCycleProbe(appId: string): Promise<EffectiveOutcome> {
    const existing = this.inFlight.get(appId);
    if (existing !== undefined) return existing;
    const p = (async (): Promise<EffectiveOutcome> => {
      const [row] = await db
        .select()
        .from(applications)
        .where(eq(applications.id, appId));
      if (!row) throw new Error(`app not found: ${appId}`);
      if (!row.monitoringEnabled) throw new Error("monitoring disabled");
      const state =
        this.appPolls.get(appId) ?? this.makeAppPollState(row);
      return await this.runOnce(row, state);
    })();
    this.inFlight.set(appId, p);
    p.finally(() => this.inFlight.delete(appId));
    return p;
  }

  private stopApp(appId: string): void {
    const s = this.appPolls.get(appId);
    if (s !== undefined && s.timer !== null) clearTimeout(s.timer);
    this.appPolls.delete(appId);
  }

  private makeAppPollState(app: AppRow): AppPollState {
    return {
      appId: app.id,
      intervalMs: Math.max(MIN_INTERVAL_MS, app.healthProbeIntervalSec * 1000),
      isPolling: false,
      timer: null,
      consecutive: { healthy: 0, unhealthy: 0, unknown: 0 },
    };
  }

  private scheduleAppCycle(app: AppRow): void {
    const state = this.makeAppPollState(app);
    this.appPolls.set(app.id, state);
    this.tickApp(state);
  }

  private tickApp(state: AppPollState): void {
    state.timer = setTimeout(async () => {
      if (!this.appPolls.has(state.appId)) return;
      if (state.isPolling) {
        this.tickApp(state);
        return;
      }

      // FR-011 deploy-lock interlock — read-only.
      const lockedRows = await db
        .select({ id: deployLocks.serverId })
        .from(deployLocks)
        .where(eq(deployLocks.appId, state.appId));
      if (lockedRows.length > 0) {
        logger.debug(
          { ctx: "app-health", appId: state.appId },
          "Probe paused — deploy in progress",
        );
        this.tickApp(state);
        return;
      }

      state.isPolling = true;
      try {
        const [row] = await db
          .select()
          .from(applications)
          .where(eq(applications.id, state.appId));
        if (!row || !row.monitoringEnabled) {
          this.appPolls.delete(state.appId);
          return;
        }
        await this.runOnce(row, state);
      } catch (err) {
        logger.warn(
          { ctx: "app-health", appId: state.appId, err },
          "Probe cycle failed",
        );
      } finally {
        state.isPolling = false;
      }
      this.tickApp(state);
    }, state.intervalMs);
    state.timer.unref();
  }

  private async runOnce(
    app: AppRow,
    state: AppPollState,
  ): Promise<EffectiveOutcome> {
    const probeRow = appRowToProbeRow(app);
    const containerOutcome = await runContainerProbe(probeRow);
    const httpOutcome =
      app.healthUrl !== null && app.healthUrl !== ""
        ? await runHttpProbe(probeRow)
        : null;
    const effective = computeEffectiveOutcome(containerOutcome, httpOutcome);

    const probeRows: Array<{
      appId: string | null;
      serverId: string | null;
      outcome: ProbeOutcome;
    }> = [{ appId: app.id, serverId: null, outcome: containerOutcome }];
    if (httpOutcome !== null) {
      probeRows.push({ appId: app.id, serverId: null, outcome: httpOutcome });
    }
    await persistProbes(probeRows);

    // Per-tick WS push so the sparkline can update before commit.
    channelManager.broadcast(`app-health:${app.id}`, {
      type: "probe-completed",
      data: {
        effective,
        container: containerOutcome,
        http: httpOutcome,
        at: nowIso(),
      },
    });

    await commitState(app, state, effective, containerOutcome, httpOutcome);
    return effective;
  }

  private scheduleCaddyCycle(serverId: string): void {
    const state: CaddyPollState = {
      serverId,
      isPolling: false,
      timer: null,
      consecutive: { healthy: 0, unhealthy: 0 },
      lastHealthyAt: null,
      lastUnhealthyAt: null,
      status: "unknown",
    };
    this.serverCaddyPolls.set(serverId, state);
    this.tickCaddy(state);
  }

  private tickCaddy(state: CaddyPollState): void {
    state.timer = setTimeout(async () => {
      if (!this.serverCaddyPolls.has(state.serverId)) return;
      if (state.isPolling) {
        this.tickCaddy(state);
        return;
      }
      state.isPolling = true;
      try {
        const [server] = await db
          .select()
          .from(servers)
          .where(eq(servers.id, state.serverId));
        if (!server) {
          this.serverCaddyPolls.delete(state.serverId);
          return;
        }
        const outcome = await runCaddyAdminProbe({
          id: server.id,
          label: server.label,
        });
        await persistProbes([
          { appId: null, serverId: server.id, outcome },
        ]);
        if (outcome.outcome === "healthy") {
          state.consecutive.healthy += 1;
          state.consecutive.unhealthy = 0;
          state.lastHealthyAt = Date.now();
        } else if (outcome.outcome === "unhealthy" || outcome.outcome === "error") {
          state.consecutive.unhealthy += 1;
          state.consecutive.healthy = 0;
          state.lastUnhealthyAt = Date.now();
        }
        // 2-tick debounce, no per-server config knob exposed.
        if (state.consecutive.unhealthy >= 2 && state.status !== "unhealthy") {
          state.status = "unhealthy";
          // T047 — Cross-spec hook contract.
          // The `server-caddy:<serverId>` channel + `caddy-unreachable` event
          // form the documented surface that feature 008's reconciler
          // subscribes to. On receipt, 008 marks affected `app_certs.status =
          // 'pending_reconcile'` (spec 008 FR-009). Feature 006 owns the
          // signal; feature 008 owns the `app_certs` write — bidirectional
          // contract per data-model.md. Integration test: see
          // tests/integration/caddy-alert-pipeline.test.ts case (c).
          channelManager.broadcast(`server-caddy:${server.id}`, {
            type: "caddy-unreachable",
            data: { serverId: server.id, at: nowIso() },
          });
          try {
            await notifier.notifyCaddyUnreachable({
              serverId: server.id,
              serverLabel: server.label,
              lastSuccessAgoMs:
                state.lastHealthyAt === null
                  ? null
                  : Date.now() - state.lastHealthyAt,
            });
          } catch (err) {
            logger.warn({ ctx: "caddy-alert", err }, "notifier failed");
          }
        } else if (state.consecutive.healthy >= 2 && state.status === "unhealthy") {
          const downtimeMs =
            state.lastUnhealthyAt === null
              ? 0
              : Date.now() - state.lastUnhealthyAt;
          state.status = "healthy";
          channelManager.broadcast(`server-caddy:${server.id}`, {
            type: "caddy-recovered",
            data: { serverId: server.id, downtimeMs, at: nowIso() },
          });
          try {
            await notifier.notifyCaddyRecovered({
              serverId: server.id,
              serverLabel: server.label,
              downtimeMs,
            });
          } catch (err) {
            logger.warn({ ctx: "caddy-recover", err }, "notifier failed");
          }
        } else if (
          state.consecutive.healthy >= 2 &&
          state.status === "unknown"
        ) {
          // FR-008-style: silent unknown→healthy.
          state.status = "healthy";
        }
      } catch (err) {
        logger.warn(
          { ctx: "caddy-probe", serverId: state.serverId, err },
          "Caddy probe cycle failed",
        );
      } finally {
        state.isPolling = false;
      }
      this.tickCaddy(state);
    }, CADDY_INTERVAL_MS);
    state.timer.unref();
  }

  private scheduleDailyCertSweep(): void {
    if (this.dailyCertTimer !== null) return;
    this.dailyCertTimer = setInterval(async () => {
      try {
        const apps = await db
          .select()
          .from(applications)
          .where(
            and(
              eq(applications.monitoringEnabled, true),
              isNotNull(applications.healthUrl), // proxy for "has a domain"
            ),
          );
        for (const app of apps) {
          const probeRow = appRowToProbeRow(app);
          if (probeRow.domain === null || probeRow.domain === "") continue;
          const outcome = await runCertExpiryProbe(probeRow);
          await persistProbes([
            { appId: app.id, serverId: null, outcome },
          ]);
        }
      } catch (err) {
        logger.warn({ ctx: "cert-sweep", err }, "Daily cert sweep failed");
      }
    }, DAILY_CERT_INTERVAL_MS);
    this.dailyCertTimer.unref();
  }

  private async serversWithApps(): Promise<string[]> {
    const rows = await client<{ server_id: string }[]>`
      SELECT DISTINCT server_id FROM applications WHERE monitoring_enabled = true
    `;
    return rows.map((r) => r.server_id);
  }
}

export const appHealthPoller = new AppHealthPoller();
// Re-export under a stable name for tests that need to spin a fresh instance.
export { AppHealthPoller as _AppHealthPollerCtor };

// Suppress unused-import lint when sql import isn't otherwise referenced.
void sql;
