// Feature 006 T017/T018 — per-application health resource routes.
//
// Surfaces:
//   GET /api/applications/:id/health         current state + last 50 probes
//   GET /api/applications/:id/health/history sparkline window (default 24h ASC)
//
// Auth + audit are applied at the parent /api mount in `server/index.ts`.
// All queries are Drizzle-parameterized — no raw SQL string interpolation.

import { Router } from "express";
import { z } from "zod";
import { and, asc, desc, eq, gte, lte } from "drizzle-orm";
import { db } from "../db/index.js";
import { applications, appHealthProbes, deployLocks } from "../db/schema.js";
import { logger } from "../lib/logger.js";
import { healthConfigPatchSchema } from "../lib/health-config-schema.js";
import { validateUrlForProbe } from "../lib/ssrf-guard.js";
import { appHealthPoller } from "../services/app-health-poller.js";
import { rateLimit } from "../middleware/rate-limit.js";

export const appHealthRouter = Router();

const idSchema = z.string().uuid();

const historyQuerySchema = z.object({
  since: z.string().datetime().optional(),
  until: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(10_000).optional(),
  probeType: z
    .enum(["container", "http", "cert_expiry", "caddy_admin"])
    .optional(),
});

function notFound(res: import("express").Response): void {
  res.status(404).json({
    error: { code: "APP_NOT_FOUND", message: "Application not found" },
  });
}

function badParams(
  res: import("express").Response,
  fieldErrors: Record<string, string[]>,
): void {
  res.status(400).json({
    error: {
      code: "INVALID_PARAMS",
      message: "Parameter validation failed",
      details: { fieldErrors },
    },
  });
}

// GET /api/applications/:id/health
appHealthRouter.get("/applications/:id/health", async (req, res) => {
  const idParse = idSchema.safeParse(req.params.id);
  if (!idParse.success) {
    badParams(res, { id: idParse.error.issues.map((i) => i.message) });
    return;
  }
  const id = idParse.data;

  try {
    const [app] = await db
      .select()
      .from(applications)
      .where(eq(applications.id, id))
      .limit(1);
    if (!app) {
      notFound(res);
      return;
    }

    const probes = await db
      .select({
        id: appHealthProbes.id,
        probedAt: appHealthProbes.probedAt,
        probeType: appHealthProbes.probeType,
        outcome: appHealthProbes.outcome,
        latencyMs: appHealthProbes.latencyMs,
        statusCode: appHealthProbes.statusCode,
        errorMessage: appHealthProbes.errorMessage,
        containerStatus: appHealthProbes.containerStatus,
      })
      .from(appHealthProbes)
      .where(eq(appHealthProbes.appId, id))
      .orderBy(desc(appHealthProbes.probedAt))
      .limit(50);

    res.json({
      appId: app.id,
      status: app.healthStatus,
      checkedAt: app.healthCheckedAt,
      lastChangeAt: app.healthLastChangeAt,
      message: app.healthMessage,
      config: {
        healthUrl: app.healthUrl,
        intervalSec: app.healthProbeIntervalSec,
        debounceCount: app.healthDebounceCount,
        monitoringEnabled: app.monitoringEnabled,
        alertsMuted: app.alertsMuted,
      },
      probes,
    });
  } catch (err) {
    logger.error(
      { ctx: "app-health-route", appId: id, err },
      "GET /applications/:id/health failed",
    );
    throw err;
  }
});

// GET /api/applications/:id/health/history
appHealthRouter.get("/applications/:id/health/history", async (req, res) => {
  const idParse = idSchema.safeParse(req.params.id);
  if (!idParse.success) {
    badParams(res, { id: idParse.error.issues.map((i) => i.message) });
    return;
  }
  const id = idParse.data;

  const queryParse = historyQuerySchema.safeParse(req.query);
  if (!queryParse.success) {
    const fieldErrors: Record<string, string[]> = {};
    for (const issue of queryParse.error.issues) {
      const key = issue.path.join(".") || "query";
      (fieldErrors[key] ??= []).push(issue.message);
    }
    badParams(res, fieldErrors);
    return;
  }
  const q = queryParse.data;

  const nowMs = Date.now();
  const sinceIso = q.since ?? new Date(nowMs - 24 * 3600 * 1000).toISOString();
  const untilIso = q.until ?? new Date(nowMs).toISOString();
  const limit = q.limit ?? 1500;

  try {
    const [app] = await db
      .select({ id: applications.id })
      .from(applications)
      .where(eq(applications.id, id))
      .limit(1);
    if (!app) {
      notFound(res);
      return;
    }

    const conditions = [
      eq(appHealthProbes.appId, id),
      gte(appHealthProbes.probedAt, sinceIso),
      lte(appHealthProbes.probedAt, untilIso),
    ];
    if (q.probeType !== undefined) {
      conditions.push(eq(appHealthProbes.probeType, q.probeType));
    }

    const probes = await db
      .select({
        probedAt: appHealthProbes.probedAt,
        probeType: appHealthProbes.probeType,
        outcome: appHealthProbes.outcome,
        latencyMs: appHealthProbes.latencyMs,
        statusCode: appHealthProbes.statusCode,
      })
      .from(appHealthProbes)
      .where(and(...conditions))
      .orderBy(asc(appHealthProbes.probedAt))
      .limit(limit);

    res.json({
      appId: id,
      windowStart: sinceIso,
      windowEnd: untilIso,
      probes,
    });
  } catch (err) {
    logger.error(
      { ctx: "app-health-route", appId: id, err },
      "GET /applications/:id/health/history failed",
    );
    throw err;
  }
});

// PATCH /api/applications/:id/health/config — T037 / T054.
// Per FR-002 / FR-007 lower bounds (interval ≥10s, debounce ≥1).
// SSRF block list applied via shared schema fragment (FR-029b — UX layer).
appHealthRouter.patch("/applications/:id/health/config", async (req, res) => {
  const idParse = idSchema.safeParse(req.params.id);
  if (!idParse.success) {
    badParams(res, { id: idParse.error.issues.map((i) => i.message) });
    return;
  }
  const id = idParse.data;

  const bodyParse = await healthConfigPatchSchema.safeParseAsync(req.body);
  if (!bodyParse.success) {
    const fieldErrors: Record<string, string[]> = {};
    let blockedCode: string | undefined;
    for (const issue of bodyParse.error.issues) {
      const key = issue.path.join(".") || "body";
      (fieldErrors[key] ??= []).push(issue.message);
      const params = (issue as { params?: { error_code?: string } }).params;
      if (params?.error_code === "health_url_blocked") {
        blockedCode = "health_url_blocked";
      }
    }
    res.status(400).json({
      error: {
        code: blockedCode ?? "INVALID_PARAMS",
        message: "Health config validation failed",
        details: { fieldErrors },
      },
    });
    return;
  }
  const patch = bodyParse.data;
  if (Object.keys(patch).length === 0) {
    res.status(400).json({
      error: {
        code: "INVALID_PARAMS",
        message: "At least one field must be provided",
      },
    });
    return;
  }

  try {
    const [updated] = await db
      .update(applications)
      .set(patch)
      .where(eq(applications.id, id))
      .returning();
    if (!updated) {
      notFound(res);
      return;
    }
    // Reload so the running tick picks up cadence / mute / monitoringEnabled flips.
    try {
      await appHealthPoller.reloadApp(id);
    } catch (err) {
      logger.warn(
        { ctx: "app-health-route", appId: id, err },
        "appHealthPoller.reloadApp failed; config saved",
      );
    }
    res.json({
      appId: updated.id,
      config: {
        healthUrl: updated.healthUrl,
        intervalSec: updated.healthProbeIntervalSec,
        debounceCount: updated.healthDebounceCount,
        monitoringEnabled: updated.monitoringEnabled,
        alertsMuted: updated.alertsMuted,
      },
    });
  } catch (err) {
    logger.error(
      { ctx: "app-health-route", appId: id, err },
      "PATCH /applications/:id/health/config failed",
    );
    throw err;
  }
});

// POST /api/applications/:id/health/check-now — T039.
// 202 Accepted, fire-and-forget; idempotent in-flight memoisation lives in the
// poller (`runOutOfCycleProbe`). 409 on deploy lock or monitoring disabled.
appHealthRouter.post("/applications/:id/health/check-now", async (req, res) => {
  const idParse = idSchema.safeParse(req.params.id);
  if (!idParse.success) {
    badParams(res, { id: idParse.error.issues.map((i) => i.message) });
    return;
  }
  const id = idParse.data;

  try {
    const [app] = await db
      .select({
        id: applications.id,
        monitoringEnabled: applications.monitoringEnabled,
      })
      .from(applications)
      .where(eq(applications.id, id))
      .limit(1);
    if (!app) {
      notFound(res);
      return;
    }
    if (!app.monitoringEnabled) {
      res.status(409).json({
        error: {
          code: "MONITORING_DISABLED",
          message: "Monitoring is disabled for this application",
        },
      });
      return;
    }

    // FR-011 deploy-lock interlock — same as the periodic poller.
    const locked = await db
      .select({ appId: deployLocks.appId })
      .from(deployLocks)
      .where(eq(deployLocks.appId, id))
      .limit(1);
    if (locked.length > 0) {
      res.status(409).json({
        error: {
          code: "DEPLOY_IN_PROGRESS",
          message: "Cannot run probe while a deploy is in progress",
        },
      });
      return;
    }

    // Fire-and-forget. The poller memoises the in-flight promise so two
    // concurrent calls collapse to a single execution.
    void appHealthPoller.runOutOfCycleProbe(id).catch((err) => {
      logger.warn(
        { ctx: "app-health-route", appId: id, err },
        "Out-of-cycle probe failed",
      );
    });

    res.status(202).json({
      appId: id,
      queuedAt: new Date().toISOString(),
      expectedWithinSec: 15,
    });
  } catch (err) {
    logger.error(
      { ctx: "app-health-route", appId: id, err },
      "POST /applications/:id/health/check-now failed",
    );
    throw err;
  }
});

// POST /api/applications/health-url/validate — T055.
// Rate-limited at 10 req/sec/user to prevent enumeration of internal subnets.
const validateUrlBodySchema = z.object({ url: z.string() }).strict();

appHealthRouter.post(
  "/applications/health-url/validate",
  rateLimit({ windowMs: 1000, max: 10 }),
  async (req, res) => {
    const parsed = validateUrlBodySchema.safeParse(req.body);
    if (!parsed.success) {
      const fieldErrors: Record<string, string[]> = {};
      for (const issue of parsed.error.issues) {
        const key = issue.path.join(".") || "body";
        (fieldErrors[key] ??= []).push(issue.message);
      }
      badParams(res, fieldErrors);
      return;
    }

    const result = await validateUrlForProbe(parsed.data.url);
    // Resolved IPs intentionally NOT logged at info — debug only (T058).
    logger.debug(
      { ctx: "ssrf-validate", ok: result.ok },
      "Health URL validate request",
    );
    if (result.ok) {
      res.json({ ok: true });
      return;
    }
    res.json({ ok: false, code: result.code });
  },
);
