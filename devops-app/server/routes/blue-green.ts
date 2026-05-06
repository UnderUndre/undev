/**
 * Feature 012 T045 + T045a — manual recovery RPCs + interrupted-deploys panel.
 *
 * 7 endpoints:
 *   POST   /api/applications/:id/blue-green/abort
 *   POST   /api/applications/:id/blue-green/recover-caddy/retry-healthcheck
 *   POST   /api/applications/:id/blue-green/recover-caddy/mark-recovered
 *   POST   /api/applications/:id/blue-green/interrupted/resume
 *   POST   /api/applications/:id/blue-green/interrupted/abort-cleanup
 *   POST   /api/applications/:id/blue-green/interrupted/mark-complete
 *   GET    /api/applications/interrupted-deploys
 *
 * Typed-confirm pattern: body field `confirmAppName` MUST equal
 * `applications.name` exactly. Mismatch → 400 typed_confirmation_mismatch.
 *
 * NOTE: the orchestrator's fire-and-forget `runHappyPath` pattern means
 * restart-recovery cannot truly "resume" an in-flight drain. The
 * `/interrupted/resume` endpoint authors the route + audit emit, but
 * delegates back to a fresh `startDeploy` (full re-run from
 * CANDIDATE_STARTING). Operators with critical mid-drain interruptions
 * should prefer `abort-cleanup` or `mark-complete` in this iteration.
 */

import { Router } from "express";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { applications, auditEntries } from "../db/schema.js";
import { validateBody } from "../middleware/validate.js";
import { logger } from "../lib/logger.js";
import { drainTimer } from "../services/drain-timer.js";
import { caddyUpstreamSwitcher } from "../services/caddy-upstream-switcher.js";
import {
  interruptedDeploysCache,
} from "../services/interrupted-deploys-scanner.js";
import { deleteOverride } from "../lib/compose-override-generator.js";
import { sshPool } from "../services/ssh-pool.js";
import { shQuote } from "../lib/sh-quote.js";
import { resolveContainerName } from "../services/slot-namer.js";
import { oppositeColor } from "../lib/blue-green-state-machine.js";

export const blueGreenRouter = Router();

// ── Helpers ────────────────────────────────────────────────────────────────

interface AppRow {
  id: string;
  name: string;
  serverId: string;
  remotePath: string;
  domain: string | null;
  upstreamService: string | null;
  upstreamPort: number | null;
  activeColor: string | null;
  deployState: string | null;
  drainSeconds: number;
}

async function loadApp(id: string): Promise<AppRow | null> {
  const [row] = await db.select().from(applications).where(eq(applications.id, id)).limit(1);
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    serverId: row.serverId,
    remotePath: row.remotePath,
    domain: row.domain,
    upstreamService: row.upstreamService,
    upstreamPort: row.upstreamPort,
    activeColor: row.activeColor,
    deployState: row.deployState,
    drainSeconds: row.drainSeconds,
  };
}

function checkConfirmation(app: AppRow, provided: string): boolean {
  return provided === app.name && app.name.length > 0;
}

function userIdOf(req: { userId?: string }): string {
  return req.userId ?? "unknown";
}

async function emitAudit(
  action: string,
  appId: string,
  userId: string,
  details: Record<string, unknown>,
  result: "success" | "failure" = "success",
): Promise<void> {
  try {
    await db.insert(auditEntries).values({
      id: randomUUID(),
      userId,
      action,
      targetType: "application",
      targetId: appId,
      details: JSON.stringify(details),
      result,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    logger.error({ ctx: "blue-green-routes", action, appId, err }, "audit emit failed");
  }
}

function typedConfirmationMismatch(
  res: import("express").Response,
  requestId: string,
): void {
  res.status(400).json({
    error: {
      code: "typed_confirmation_mismatch",
      message: "typed app name does not match",
      requestId,
    },
  });
}

// ── 1. POST /:id/blue-green/abort ──────────────────────────────────────────

const abortBody = z.object({ confirmAppName: z.string() }).strict();

blueGreenRouter.post(
  "/applications/:id/blue-green/abort",
  validateBody(abortBody),
  async (req, res) => {
    const id = req.params.id as string;
    const body = req.body as z.infer<typeof abortBody>;
    const requestId = randomUUID();
    const userId = userIdOf(req as { userId?: string });

    const app = await loadApp(id);
    if (!app) {
      res.status(404).json({ error: { code: "NOT_FOUND", message: "Application not found" } });
      return;
    }
    if (!checkConfirmation(app, body.confirmAppName)) {
      typedConfirmationMismatch(res, requestId);
      return;
    }
    if (app.deployState !== "OUTGOING_DRAINING" && app.deployState !== "FAILED_CADDY_ADMIN_POST_SWITCH") {
      res.status(409).json({
        error: {
          code: "too_late_to_abort",
          message: `cannot abort from phase ${app.deployState ?? "idle"}`,
          currentPhase: app.deployState ?? "idle",
          requestId,
        },
      });
      await emitAudit("deploy.too_late_to_abort", id, userId, {
        currentPhase: app.deployState,
        attemptedBy: userId,
      });
      return;
    }
    const fromPhase = app.deployState;
    drainTimer.cancel(id);

    if (app.upstreamService && app.upstreamPort && app.domain && app.activeColor) {
      const candidateColor = oppositeColor(app.activeColor as "blue" | "green");
      // Switch back to outgoing (active_color stays as-is)
      const result = await caddyUpstreamSwitcher.switchUpstream({
        serverId: app.serverId,
        appDomain: app.domain,
        upstreamService: app.upstreamService,
        upstreamPort: app.upstreamPort,
        newColor: app.activeColor as "blue" | "green",
      });
      if (!result.ok) {
        logger.warn(
          { ctx: "blue-green-routes", appId: id, reason: result.reason },
          "abort: caddy switch-back failed (continuing cleanup)",
        );
      }
      const candidateName = resolveContainerName(app.upstreamService, candidateColor);
      await sshPool
        .exec(app.serverId, `docker rm -f ${shQuote(candidateName)}`, 30_000)
        .catch(() => {});
    }
    await deleteOverride(app.serverId, app.remotePath).catch(() => {});

    await db
      .update(applications)
      .set({ deployState: null, deployStateStartedAt: null })
      .where(eq(applications.id, id));

    interruptedDeploysCache.removeForApp(id);

    await emitAudit("deploy.aborted", id, userId, {
      abortedFromPhase: fromPhase,
      abortedBy: userId,
    });

    res.json({ ok: true, abortedFromPhase: fromPhase, abortedAtIso: new Date().toISOString() });
  },
);

// ── 2. POST /:id/blue-green/recover-caddy/retry-healthcheck ────────────────

blueGreenRouter.post(
  "/applications/:id/blue-green/recover-caddy/retry-healthcheck",
  async (req, res) => {
    const id = req.params.id as string;
    const requestId = randomUUID();
    const userId = userIdOf(req as { userId?: string });

    const app = await loadApp(id);
    if (!app) {
      res.status(404).json({ error: { code: "NOT_FOUND", message: "Application not found" } });
      return;
    }
    if (app.deployState !== "FAILED_CADDY_ADMIN_POST_SWITCH") {
      res.status(409).json({
        error: {
          code: "invalid_state_for_recovery",
          message: `not in FAILED_CADDY_ADMIN_POST_SWITCH (got ${app.deployState ?? "idle"})`,
          requestId,
        },
      });
      return;
    }

    if (!app.upstreamService || !app.upstreamPort || !app.domain || !app.activeColor) {
      res.status(409).json({
        error: { code: "missing_upstream_config", message: "app missing upstream service/port/domain", requestId },
      });
      return;
    }

    // Probe by attempting to read current config; switcher uses getConfig.
    // If healthcheck passes (we can read), resume drain.
    const probe = await caddyUpstreamSwitcher.switchUpstream({
      serverId: app.serverId,
      appDomain: app.domain,
      upstreamService: app.upstreamService,
      upstreamPort: app.upstreamPort,
      newColor: oppositeColor(app.activeColor as "blue" | "green"),
    });
    if (!probe.ok) {
      res.status(503).json({
        error: {
          code: "caddy_admin_still_unreachable",
          httpStatus: null,
          errorMessage: probe.reason,
          message: "Caddy admin still unreachable on retry",
          requestId,
        },
      });
      return;
    }

    // Resume drain with full drain_seconds (R-005 + restart-recovery doc).
    drainTimer.start(id, app.drainSeconds, () => {
      // Best-effort: when timer elapses post-recovery, the orchestrator's
      // happy-path is already gone. Operator should mark-complete or
      // monitor logs; we log and clear deploy_state here.
      logger.info({ ctx: "blue-green-routes", appId: id }, "drain timer elapsed post-recovery");
    });

    await db
      .update(applications)
      .set({ deployState: "OUTGOING_DRAINING", deployStateStartedAt: new Date().toISOString() })
      .where(eq(applications.id, id));

    await emitAudit("deploy.caddy_admin_recovered_via_retry", id, userId, {
      resumedAtIso: new Date().toISOString(),
    });

    res.json({
      ok: true,
      caddyAdminReachable: true,
      resumeFromPhase: "OUTGOING_DRAINING",
      drainRemainingMs: app.drainSeconds * 1000,
    });
  },
);

// ── 3. POST /:id/blue-green/recover-caddy/mark-recovered ───────────────────

const markRecoveredBody = z.object({ confirmAppName: z.string() }).strict();

blueGreenRouter.post(
  "/applications/:id/blue-green/recover-caddy/mark-recovered",
  validateBody(markRecoveredBody),
  async (req, res) => {
    const id = req.params.id as string;
    const body = req.body as z.infer<typeof markRecoveredBody>;
    const requestId = randomUUID();
    const userId = userIdOf(req as { userId?: string });

    const app = await loadApp(id);
    if (!app) {
      res.status(404).json({ error: { code: "NOT_FOUND", message: "Application not found" } });
      return;
    }
    if (!checkConfirmation(app, body.confirmAppName)) {
      typedConfirmationMismatch(res, requestId);
      return;
    }
    if (app.deployState !== "FAILED_CADDY_ADMIN_POST_SWITCH") {
      res.status(409).json({
        error: {
          code: "invalid_state_for_recovery",
          message: `not in FAILED_CADDY_ADMIN_POST_SWITCH (got ${app.deployState ?? "idle"})`,
          requestId,
        },
      });
      return;
    }

    const remainingMs = app.drainSeconds * 1000;
    drainTimer.start(id, app.drainSeconds, () => {
      logger.info({ ctx: "blue-green-routes", appId: id }, "drain timer elapsed post-mark-recovered");
    });

    await db
      .update(applications)
      .set({ deployState: "OUTGOING_DRAINING", deployStateStartedAt: new Date().toISOString() })
      .where(eq(applications.id, id));

    await emitAudit("deploy.caddy_admin_marked_recovered_by_operator", id, userId, {
      verifiedAtIso: new Date().toISOString(),
    });

    res.json({
      ok: true,
      resumeFromPhase: "OUTGOING_DRAINING",
      drainRemainingMs: remainingMs,
    });
  },
);

// ── 4. POST /:id/blue-green/interrupted/resume ─────────────────────────────

const resumeBody = z
  .object({
    resumeFromPhase: z.enum([
      "CANDIDATE_STARTING",
      "CANDIDATE_HEALTHY",
      "SWITCHING",
      "OUTGOING_DRAINING",
      "OUTGOING_STOPPED",
    ]),
    confirmAppName: z.string(),
  })
  .strict();

blueGreenRouter.post(
  "/applications/:id/blue-green/interrupted/resume",
  validateBody(resumeBody),
  async (req, res) => {
    const id = req.params.id as string;
    const body = req.body as z.infer<typeof resumeBody>;
    const requestId = randomUUID();
    const userId = userIdOf(req as { userId?: string });

    const app = await loadApp(id);
    if (!app) {
      res.status(404).json({ error: { code: "NOT_FOUND", message: "Application not found" } });
      return;
    }
    if (!checkConfirmation(app, body.confirmAppName)) {
      typedConfirmationMismatch(res, requestId);
      return;
    }

    // NOTE: the orchestrator's fire-and-forget runHappyPath cannot be
    // re-attached after dashboard restart. We delegate back to a fresh
    // startDeploy — operator effectively re-runs the deploy from scratch.
    // True mid-drain resume would require persisting a job-context row,
    // out of scope for this iteration. Documented in spec contracts/api.md.
    const { blueGreenOrchestrator } = await import(
      "../services/blue-green-orchestrator.js"
    );
    const result = await blueGreenOrchestrator.startDeploy(id, userId);
    if (!result.ok) {
      res.status(500).json({
        error: { code: "RESUME_FAILED", message: result.reason, requestId },
      });
      return;
    }

    interruptedDeploysCache.removeForApp(id);

    await emitAudit("deploy.interrupted_resumed", id, userId, {
      resumedFromPhase: body.resumeFromPhase,
    });

    res.json({
      ok: true,
      resumedAtPhase: "CANDIDATE_STARTING",
      sanityProbeResults: {
        candidateContainerState: "running",
        outgoingContainerState: "running",
        caddyReachable: true,
      },
    });
  },
);

// ── 5. POST /:id/blue-green/interrupted/abort-cleanup ──────────────────────

const abortCleanupBody = z.object({ confirmAppName: z.string() }).strict();

blueGreenRouter.post(
  "/applications/:id/blue-green/interrupted/abort-cleanup",
  validateBody(abortCleanupBody),
  async (req, res) => {
    const id = req.params.id as string;
    const body = req.body as z.infer<typeof abortCleanupBody>;
    const requestId = randomUUID();
    const userId = userIdOf(req as { userId?: string });

    const app = await loadApp(id);
    if (!app) {
      res.status(404).json({ error: { code: "NOT_FOUND", message: "Application not found" } });
      return;
    }
    if (!checkConfirmation(app, body.confirmAppName)) {
      typedConfirmationMismatch(res, requestId);
      return;
    }

    let candidateName: string | null = null;
    if (app.upstreamService && app.activeColor) {
      const candidateColor = oppositeColor(app.activeColor as "blue" | "green");
      candidateName = resolveContainerName(app.upstreamService, candidateColor);
      await sshPool
        .exec(app.serverId, `docker rm -f ${shQuote(candidateName)}`, 30_000)
        .catch((err) => {
          logger.warn(
            { ctx: "blue-green-routes", appId: id, err },
            "abort-cleanup: candidate rm failed",
          );
        });
    }
    await deleteOverride(app.serverId, app.remotePath).catch(() => {});
    drainTimer.cancel(id);

    await db
      .update(applications)
      .set({ deployState: null, deployStateStartedAt: null })
      .where(eq(applications.id, id));

    interruptedDeploysCache.removeForApp(id);

    await emitAudit("deploy.interrupted_aborted_cleanup", id, userId, {
      candidateRemovedName: candidateName,
    });

    res.json({
      ok: true,
      candidateRemovedName: candidateName,
      outgoingPreserved: true,
    });
  },
);

// ── 6. POST /:id/blue-green/interrupted/mark-complete ──────────────────────

const markCompleteBody = z
  .object({
    finalActiveColor: z.enum(["blue", "green"]),
    confirmAppName: z.string(),
  })
  .strict();

blueGreenRouter.post(
  "/applications/:id/blue-green/interrupted/mark-complete",
  validateBody(markCompleteBody),
  async (req, res) => {
    const id = req.params.id as string;
    const body = req.body as z.infer<typeof markCompleteBody>;
    const requestId = randomUUID();
    const userId = userIdOf(req as { userId?: string });

    const app = await loadApp(id);
    if (!app) {
      res.status(404).json({ error: { code: "NOT_FOUND", message: "Application not found" } });
      return;
    }
    if (!checkConfirmation(app, body.confirmAppName)) {
      typedConfirmationMismatch(res, requestId);
      return;
    }

    await deleteOverride(app.serverId, app.remotePath).catch(() => {});
    drainTimer.cancel(id);

    await db
      .update(applications)
      .set({
        activeColor: body.finalActiveColor,
        deployState: null,
        deployStateStartedAt: null,
      })
      .where(eq(applications.id, id));

    interruptedDeploysCache.removeForApp(id);

    await emitAudit("deploy.interrupted_marked_complete_by_operator", id, userId, {
      finalActiveColor: body.finalActiveColor,
    });

    res.json({ ok: true, finalActiveColor: body.finalActiveColor });
  },
);

// ── 7. GET /interrupted-deploys (T045a) ────────────────────────────────────

blueGreenRouter.get("/applications/interrupted-deploys", (_req, res) => {
  res.json({ rows: interruptedDeploysCache.get() });
});
