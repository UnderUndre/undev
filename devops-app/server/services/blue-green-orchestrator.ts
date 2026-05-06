/**
 * Feature 012 T028 — blue/green deploy orchestrator.
 *
 * Drives the state machine end-to-end. Per-phase actions:
 *   CANDIDATE_STARTING   — write override file + `docker compose up -d --no-deps`
 *   CANDIDATE_HEALTHY    — poll healthcheck per R-004
 *   SWITCHING            — call caddy-upstream-switcher
 *   OUTGOING_DRAINING    — start drain timer
 *   OUTGOING_STOPPED     — `docker compose stop` outgoing, delete override,
 *                          flip active_color
 *   ACTIVE → null        — clear deploy_state
 *
 * Every state transition wraps DB UPDATE + audit_entries INSERT in a
 * transaction BEFORE WS broadcast, per state-machine.md test invariant.
 *
 * Synthetic audit events:
 *   - `deploy.failure_cleared` on any FAILED_* → null transition
 *   - `deploy.caddy_admin_recovered` on FAILED_CADDY_ADMIN_POST_SWITCH →
 *     OUTGOING_DRAINING
 *   - `deploy.blue_green_succeeded` on ACTIVE → null
 *
 * NOTE: this orchestrator implements the orchestration shell. The
 * actual `docker compose` shell-outs reuse `sshPool.exec` directly
 * because feature 012 explicitly avoids new dependencies and the
 * pre-existing `scriptsRunner` flow is recreate-only.
 */

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { applications, auditEntries } from "../db/schema.js";
import { sshPool } from "./ssh-pool.js";
import { shQuote } from "../lib/sh-quote.js";
import { logger } from "../lib/logger.js";
import { channelManager } from "../ws/channels.js";
import {
  canTransition,
  findTransition,
  oppositeColor,
  type Phase,
  type PhaseOrIdle,
} from "../lib/blue-green-state-machine.js";
import {
  generateOverride,
  writeOverride,
  deleteOverride,
  overridePath,
} from "../lib/compose-override-generator.js";
import { caddyUpstreamSwitcher } from "./caddy-upstream-switcher.js";
import { drainTimer } from "./drain-timer.js";
import {
  migrateExistingToBlueSlot,
  resolveContainerName,
} from "./slot-namer.js";

const HEALTHCHECK_POLL_INTERVAL_MS = 2_000;

export type StartDeployResult =
  | { ok: true; deployId: string }
  | { ok: false; reason: string };

export interface BlueGreenAppContext {
  appId: string;
  serverId: string;
  appDir: string;
  upstreamService: string;
  upstreamPort: number;
  appDomain: string;
  drainSeconds: number;
  greenHealthcheckTimeoutSeconds: number;
  activeColor: "blue" | "green" | null;
}

export class BlueGreenOrchestrator {
  /**
   * Public entry point. Loads app, runs first-deploy migration if needed,
   * dispatches CANDIDATE_STARTING. Subsequent phases are triggered by
   * orchestrator-internal callbacks (kept simple; no external API).
   */
  async startDeploy(appId: string, userId: string): Promise<StartDeployResult> {
    const ctx = await loadContext(appId);
    if (!ctx) return { ok: false, reason: "app_not_found" };

    if (ctx.activeColor === null) {
      try {
        await migrateExistingToBlueSlot(ctx.serverId, ctx.appDir, ctx.upstreamService);
        await db
          .update(applications)
          .set({ activeColor: "blue" })
          .where(eq(applications.id, appId));
        ctx.activeColor = "blue";
      } catch (err) {
        logger.error(
          { ctx: "blue-green-orchestrator", appId, err },
          "first-deploy slot migration failed",
        );
        return { ok: false, reason: "slot_migration_failed" };
      }
    }

    const candidateColor = oppositeColor(ctx.activeColor);
    const outgoingColor = ctx.activeColor;

    await this.transitionTo(ctx, null, "CANDIDATE_STARTING", userId, {
      candidateColor,
      outgoingColor,
      drainSeconds: ctx.drainSeconds,
      greenTimeoutSeconds: ctx.greenHealthcheckTimeoutSeconds,
    });

    // Fire-and-forget the long-running flow; caller polls via WS / REST.
    void this.runHappyPath(ctx, userId, candidateColor, outgoingColor).catch((err) => {
      logger.error(
        { ctx: "blue-green-orchestrator", appId, err },
        "runHappyPath threw",
      );
    });

    return { ok: true, deployId: randomUUID() };
  }

  private async runHappyPath(
    ctx: BlueGreenAppContext,
    userId: string,
    candidateColor: "blue" | "green",
    outgoingColor: "blue" | "green",
  ): Promise<void> {
    // 1. Spawn candidate
    const overrideContent = generateOverride(ctx.upstreamService, candidateColor);
    await writeOverride(ctx.serverId, ctx.appDir, overrideContent);
    const upCmd = buildComposeUpCommand(ctx.appDir, ctx.upstreamService);
    const upRes = await sshPool.exec(ctx.serverId, upCmd, 5 * 60_000);
    if (upRes.exitCode !== 0) {
      await this.handleFailure(
        ctx,
        "CANDIDATE_STARTING",
        "FAILED_CANDIDATE_HEALTHCHECK",
        userId,
        { failureReason: "container_exit", lastLogLines: tailLines(upRes.stderr) },
      );
      return;
    }

    // 2. Wait healthy
    const candidateName = resolveContainerName(ctx.upstreamService, candidateColor);
    const healthStart = Date.now();
    const healthy = await waitForCandidateHealthy(
      ctx.serverId,
      candidateName,
      ctx.greenHealthcheckTimeoutSeconds * 1000,
    );
    if (!healthy.ok) {
      await this.handleFailure(
        ctx,
        "CANDIDATE_STARTING",
        "FAILED_CANDIDATE_HEALTHCHECK",
        userId,
        { failureReason: healthy.reason, lastLogLines: [] },
      );
      return;
    }
    await this.transitionTo(ctx, "CANDIDATE_STARTING", "CANDIDATE_HEALTHY", userId, {
      candidateColor,
      candidateName,
      healthyAfterMs: Date.now() - healthStart,
    });

    // 3. Switch
    await this.transitionTo(ctx, "CANDIDATE_HEALTHY", "SWITCHING", userId, {
      candidateColor,
    });
    const switchResult = await caddyUpstreamSwitcher.switchUpstream({
      serverId: ctx.serverId,
      appDomain: ctx.appDomain,
      upstreamService: ctx.upstreamService,
      upstreamPort: ctx.upstreamPort,
      newColor: candidateColor,
    });
    if (!switchResult.ok) {
      await this.handleFailure(ctx, "SWITCHING", "FAILED_SWITCH", userId, {
        errorMessage: switchResult.reason,
        retryCount: 0,
      });
      return;
    }
    await this.transitionTo(ctx, "SWITCHING", "OUTGOING_DRAINING", userId, {
      fromColor: outgoingColor,
      toColor: candidateColor,
      switchedAtIso: switchResult.switchedAt,
    });

    // 4. Drain timer
    const drainStart = Date.now();
    const drainComplete = new Promise<void>((resolve) => {
      drainTimer.start(ctx.appId, ctx.drainSeconds, () => resolve());
    });
    await drainComplete;

    // 5. Stop outgoing
    await this.transitionTo(ctx, "OUTGOING_DRAINING", "OUTGOING_STOPPED", userId, {
      drainElapsedMs: Date.now() - drainStart,
    });
    const outgoingName = resolveContainerName(ctx.upstreamService, outgoingColor);
    await sshPool
      .exec(
        ctx.serverId,
        `docker stop ${shQuote(outgoingName)} && docker rm -f ${shQuote(outgoingName)}`,
        2 * 60_000,
      )
      .catch((err) => {
        logger.warn(
          { ctx: "blue-green-orchestrator", appId: ctx.appId, err },
          "outgoing stop failed (continuing)",
        );
      });
    await deleteOverride(ctx.serverId, ctx.appDir);

    // Flip active_color
    await db
      .update(applications)
      .set({ activeColor: candidateColor })
      .where(eq(applications.id, ctx.appId));

    await this.transitionTo(ctx, "OUTGOING_STOPPED", "ACTIVE", userId, {
      stoppedColor: outgoingColor,
      stoppedName: outgoingName,
      finalActiveColor: candidateColor,
    });

    // Clear deploy_state
    await this.transitionTo(ctx, "ACTIVE", null, userId, {});
  }

  private async handleFailure(
    ctx: BlueGreenAppContext,
    fromPhase: Phase,
    toPhase: Phase,
    userId: string,
    detail: Record<string, unknown>,
  ): Promise<void> {
    await this.transitionTo(ctx, fromPhase, toPhase, userId, detail);
    // Best-effort cleanup of override + candidate.
    await deleteOverride(ctx.serverId, ctx.appDir).catch(() => {});
  }

  /**
   * Transition with DB tx + audit emit + WS broadcast (in that order).
   * Validates the transition via canTransition() and finds the metadata
   * via findTransition() to learn the audit event name.
   */
  private async transitionTo(
    ctx: BlueGreenAppContext,
    from: PhaseOrIdle,
    to: PhaseOrIdle,
    userId: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    if (!canTransition(from, to)) {
      logger.error(
        { ctx: "blue-green-orchestrator", appId: ctx.appId, from, to },
        "invalid transition refused",
      );
      throw new Error(`invalid transition ${String(from)} → ${String(to)}`);
    }
    const transition = findTransition(from, to);
    const occurredAt = new Date().toISOString();

    await db.transaction(async (tx) => {
      await tx
        .update(applications)
        .set({
          deployState: to,
          deployStateStartedAt: to === null ? null : occurredAt,
        })
        .where(eq(applications.id, ctx.appId));
      if (transition?.emitsAuditEvent) {
        await tx.insert(auditEntries).values({
          id: randomUUID(),
          userId,
          action: transition.emitsAuditEvent,
          targetType: "application",
          targetId: ctx.appId,
          details: JSON.stringify({ from, to, ...metadata }),
          result: to?.startsWith("FAILED_") ? "failure" : "success",
          timestamp: occurredAt,
        });
      }
    });

    channelManager.broadcast(`blue_green:${ctx.appId}`, {
      type: "blue_green.state-changed",
      appId: ctx.appId,
      fromState: from,
      toState: to,
      occurredAt,
      metadata,
    });
  }
}

export const blueGreenOrchestrator = new BlueGreenOrchestrator();

// ── Helpers ────────────────────────────────────────────────────────────────

async function loadContext(appId: string): Promise<BlueGreenAppContext | null> {
  const [row] = await db
    .select()
    .from(applications)
    .where(eq(applications.id, appId))
    .limit(1);
  if (!row) return null;
  if (!row.upstreamService || !row.upstreamPort) {
    logger.warn(
      { ctx: "blue-green-orchestrator", appId },
      "missing upstream service/port — cannot blue/green deploy",
    );
    return null;
  }
  return {
    appId: row.id,
    serverId: row.serverId,
    appDir: row.remotePath,
    upstreamService: row.upstreamService,
    upstreamPort: row.upstreamPort,
    appDomain: row.domain ?? "",
    drainSeconds: row.drainSeconds,
    greenHealthcheckTimeoutSeconds: row.greenHealthcheckTimeoutSeconds,
    activeColor: (row.activeColor as "blue" | "green" | null) ?? null,
  };
}

function buildComposeUpCommand(appDir: string, serviceName: string): string {
  const overrideFile = overridePath(appDir);
  return `cd ${shQuote(appDir)} && docker compose -f docker-compose.yml -f ${shQuote(
    overrideFile,
  )} up -d --no-deps ${shQuote(serviceName)}`;
}

async function waitForCandidateHealthy(
  serverId: string,
  containerName: string,
  timeoutMs: number,
): Promise<{ ok: true } | { ok: false; reason: "timeout" | "unhealthy" | "container_exit" }> {
  const deadline = Date.now() + timeoutMs;
  const cmd = `docker inspect --format '{{.State.Status}}|{{.State.Health.Status}}' ${shQuote(
    containerName,
  )} 2>/dev/null || echo missing`;
  while (Date.now() < deadline) {
    try {
      const result = await sshPool.exec(serverId, cmd, 10_000);
      const out = result.stdout.trim();
      if (out === "missing") return { ok: false, reason: "container_exit" };
      const [status, health] = out.split("|");
      if (status === "exited") return { ok: false, reason: "container_exit" };
      if (health === "healthy") return { ok: true };
      if (health === "unhealthy") return { ok: false, reason: "unhealthy" };
    } catch (err) {
      logger.warn(
        { ctx: "blue-green-orchestrator", serverId, containerName, err },
        "healthcheck probe error (will retry)",
      );
    }
    await sleep(HEALTHCHECK_POLL_INTERVAL_MS);
  }
  return { ok: false, reason: "timeout" };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tailLines(s: string, count = 10): string[] {
  return s
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .slice(-count);
}
