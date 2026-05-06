/**
 * Feature 009 — bootstrap orchestrator HTTP surface.
 *
 *   POST   /api/applications/bootstrap                 — T014, US1
 *   GET    /api/applications/:id/bootstrap-state       — T015, US1
 *   POST   /api/applications/:id/bootstrap/retry       — T030, US2
 *   PATCH  /api/applications/:id/bootstrap/config      — T031, US2
 *   POST   /api/applications/:id/hard-delete           — T049, polish
 *   GET    /api/servers/:serverId/bootstraps           — T069, polish
 *
 * All routes require auth + audit (mounted under /api). Zod-validated bodies
 * route through the standard `validateBody` shim where convenient; ad-hoc
 * shapes get inline `safeParse`. Error envelopes follow the contracts/api.md
 * `{ error: { code, message, details? } }` shape.
 */

import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { applications, appBootstrapEvents } from "../db/schema.js";
import { logger } from "../lib/logger.js";
import { validateSlug, isSlugUniqueOnServer } from "../lib/slug.js";
import { validateComposePath } from "../lib/validate-compose-path.js";
import {
  bootstrapOrchestrator,
  canTransition,
  findCurrentRun,
  type BootstrapState,
  type BootstrapStep,
} from "../services/bootstrap-orchestrator.js";
import {
  BootstrapStateError,
  PathJailEscapeError,
  SlugCollisionError,
} from "../lib/bootstrap-errors.js";

export const bootstrapRouter = Router();

// ── Helpers ─────────────────────────────────────────────────────────────────

const BRANCH_REGEX = /^[a-zA-Z0-9._\-/]+$/;
const SLUG_REGEX = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const DOMAIN_REGEX = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

function jailRoot(): string {
  return process.env.DEPLOY_USER_HOME
    ? `${process.env.DEPLOY_USER_HOME.replace(/\/$/, "")}/apps`
    : "/home/deploy/apps";
}

function getUserId(req: Request): string {
  return (req as Request & { userId?: string }).userId ?? "system";
}

// ── POST /api/applications/bootstrap ─────────────────────────────────────────

const bootstrapRequestSchema = z
  .object({
    serverId: z.string().min(1),
    githubRepo: z.string().regex(/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/),
    name: z.string().regex(SLUG_REGEX).max(64),
    branch: z.string().regex(BRANCH_REGEX),
    composePath: z
      .string()
      .max(256)
      .default("docker-compose.yml")
      .refine((v) => {
        const r = validateComposePath(v);
        return r.ok;
      }, "composePath rejected: contains unsafe characters or wrong extension"),
    remotePath: z.string().min(1).max(512),
    upstreamService: z.string().nullable(),
    upstreamPort: z.number().int().min(1).max(65535).nullable(),
    domain: z.string().regex(DOMAIN_REGEX).nullable(),
    acmeEmail: z.string().email().nullable().optional(),
    bootstrapAutoRetry: z.boolean().default(false),
  })
  .refine(
    (v) => (v.upstreamService === null) === (v.upstreamPort === null),
    "upstreamService and upstreamPort must be both set or both null",
  );

bootstrapRouter.post("/applications/bootstrap", async (req, res) => {
  const parsed = bootstrapRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: {
        code: "INVALID_PARAMS",
        message: "Invalid bootstrap request",
        details: parsed.error.flatten(),
      },
    });
    return;
  }
  const body = parsed.data;
  // Belt-and-braces: server-side slug regex per FR-027 (already enforced by Zod).
  const slugCheck = validateSlug(body.name);
  if (!slugCheck.ok) {
    res.status(400).json({ error: { code: "INVALID_PARAMS", message: slugCheck.error } });
    return;
  }
  const unique = await isSlugUniqueOnServer(db, body.serverId, body.name);
  if (!unique) {
    res.status(409).json({
      error: {
        code: "SLUG_COLLISION",
        message: `Slug "${body.name}" already exists on server ${body.serverId}`,
      },
    });
    return;
  }

  const repoUrl = `https://github.com/${body.githubRepo}.git`;
  const appId = randomUUID();
  const occurredAt = new Date().toISOString();

  try {
    await db.transaction(async (tx) => {
      await tx.insert(applications).values({
        id: appId,
        serverId: body.serverId,
        name: body.name,
        repoUrl,
        branch: body.branch,
        remotePath: body.remotePath,
        githubRepo: body.githubRepo,
        bootstrapState: "init",
        bootstrapAutoRetry: body.bootstrapAutoRetry,
        composePath: body.composePath,
        upstreamService: body.upstreamService,
        upstreamPort: body.upstreamPort,
        domain: body.domain,
        acmeEmail: body.acmeEmail ?? null,
        createdVia: "bootstrap",
        skipInitialClone: false,
        createdAt: occurredAt,
      });
      await tx.insert(appBootstrapEvents).values({
        id: randomUUID(),
        appId,
        fromState: "init",
        toState: "init",
        occurredAt,
        metadata: { reason: "first_attempt", repoUrl, branch: body.branch },
        actor: getUserId(req),
      });
    });
  } catch (err) {
    logger.error({ ctx: "bootstrap-route", err }, "INSERT applications failed");
    res.status(500).json({ error: { code: "INTERNAL", message: "Failed to persist app row" } });
    return;
  }

  // Fire-and-forget orchestrator dispatch.
  void bootstrapOrchestrator.start(appId, getUserId(req)).catch((err: unknown) => {
    logger.error({ ctx: "bootstrap-route", appId, err }, "orchestrator.start crashed");
  });

  res.status(201).json({
    id: appId,
    bootstrapState: "init",
    createdVia: "bootstrap",
    events: [],
  });
});

// ── GET /api/applications/:id/bootstrap-state ────────────────────────────────

bootstrapRouter.get("/applications/:id/bootstrap-state", async (req, res) => {
  const id = req.params.id;
  if (!id) {
    res.status(400).json({ error: { code: "INVALID_PARAMS", message: "id required" } });
    return;
  }
  const [row] = await db
    .select({
      id: applications.id,
      name: applications.name,
      bootstrapState: applications.bootstrapState,
      createdVia: applications.createdVia,
      domain: applications.domain,
      upstreamService: applications.upstreamService,
      upstreamPort: applications.upstreamPort,
      composePath: applications.composePath,
    })
    .from(applications)
    .where(eq(applications.id, id))
    .limit(1);
  if (!row) {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "App not found" } });
    return;
  }
  const events = await db
    .select()
    .from(appBootstrapEvents)
    .where(eq(appBootstrapEvents.appId, id))
    .orderBy(asc(appBootstrapEvents.occurredAt));
  const currentRun = await findCurrentRun(id);
  res.json({ ...row, events, currentRun });
});

// ── POST /api/applications/:id/bootstrap/retry ───────────────────────────────

const retryStepSchema = z.enum([
  "cloning",
  "compose_up",
  "healthcheck",
  "proxy_applied",
  "cert_issued",
]);

bootstrapRouter.post("/applications/:id/bootstrap/retry", async (req, res) => {
  const id = req.params.id;
  if (!id) {
    res.status(400).json({ error: { code: "INVALID_PARAMS", message: "id required" } });
    return;
  }
  const fromParsed = retryStepSchema.safeParse(req.query.from);
  if (!fromParsed.success) {
    res.status(400).json({
      error: { code: "INVALID_PARAMS", message: "Invalid 'from' step" },
    });
    return;
  }
  const fromStep = fromParsed.data as BootstrapStep;

  const [row] = await db
    .select({ bootstrapState: applications.bootstrapState })
    .from(applications)
    .where(eq(applications.id, id))
    .limit(1);
  if (!row) {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "App not found" } });
    return;
  }
  if (!canTransition(row.bootstrapState as BootstrapState, fromStep)) {
    res.status(400).json({
      error: {
        code: "INVALID_TRANSITION",
        message: `Cannot retry from ${fromStep} when current state is ${row.bootstrapState}`,
        details: { currentState: row.bootstrapState, requestedFrom: fromStep },
      },
    });
    return;
  }
  // 409 BOOTSTRAP_IN_PROGRESS — a bootstrap/* run is currently running.
  const currentRun = await findCurrentRun(id);
  if (currentRun) {
    res.status(409).json({
      error: {
        code: "BOOTSTRAP_IN_PROGRESS",
        message: "A bootstrap step is already running for this app",
        details: { runId: currentRun.runId, scriptId: currentRun.scriptId },
      },
    });
    return;
  }
  try {
    await bootstrapOrchestrator.retryFromFailedStep(id, fromStep, getUserId(req));
  } catch (err) {
    if (err instanceof BootstrapStateError) {
      res.status(400).json({
        error: { code: "INVALID_TRANSITION", message: err.message },
      });
      return;
    }
    throw err;
  }
  res.status(202).json({ id, bootstrapState: fromStep });
});

// ── PATCH /api/applications/:id/bootstrap/config ─────────────────────────────

const editConfigSchema = z
  .object({
    branch: z.string().regex(BRANCH_REGEX).optional(),
    composePath: z
      .string()
      .max(256)
      .refine((v) => validateComposePath(v).ok, "composePath unsafe")
      .optional(),
    upstreamService: z.string().nullable().optional(),
    upstreamPort: z.number().int().min(1).max(65535).nullable().optional(),
  })
  .strict()
  .refine(
    (v) =>
      (v.upstreamService === undefined && v.upstreamPort === undefined) ||
      (v.upstreamService !== undefined && v.upstreamPort !== undefined),
    "upstreamService and upstreamPort must be edited together",
  );

bootstrapRouter.patch("/applications/:id/bootstrap/config", async (req, res) => {
  const id = req.params.id;
  if (!id) {
    res.status(400).json({ error: { code: "INVALID_PARAMS", message: "id required" } });
    return;
  }
  // Reject immutable fields up-front per FR-020 last paragraph.
  for (const field of ["remotePath", "repoUrl", "name", "githubRepo", "domain"]) {
    if (Object.prototype.hasOwnProperty.call(req.body ?? {}, field)) {
      res.status(400).json({
        error: { code: "IMMUTABLE_FIELD", message: `Field "${field}" is immutable`, details: { field } },
      });
      return;
    }
  }
  const parsed = editConfigSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: { code: "INVALID_PARAMS", message: "Invalid config", details: parsed.error.flatten() },
    });
    return;
  }
  const [row] = await db
    .select({ bootstrapState: applications.bootstrapState })
    .from(applications)
    .where(eq(applications.id, id))
    .limit(1);
  if (!row) {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "App not found" } });
    return;
  }
  if (!row.bootstrapState.startsWith("failed_")) {
    res.status(409).json({
      error: {
        code: "BOOTSTRAP_NOT_FAILED",
        message: `App is in state ${row.bootstrapState}, edit-config requires failed_*`,
        details: { currentState: row.bootstrapState },
      },
    });
    return;
  }
  await db.update(applications).set(parsed.data).where(eq(applications.id, id));
  const [updated] = await db.select().from(applications).where(eq(applications.id, id)).limit(1);
  res.json(updated);
});

// ── POST /api/applications/:id/hard-delete ───────────────────────────────────

const hardDeleteSchema = z.object({ confirmName: z.string().min(1) });

bootstrapRouter.post("/applications/:id/hard-delete", async (req, res) => {
  const id = req.params.id;
  if (!id) {
    res.status(400).json({ error: { code: "INVALID_PARAMS", message: "id required" } });
    return;
  }
  const parsed = hardDeleteSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: "INVALID_PARAMS", message: "confirmName required" } });
    return;
  }
  const force = req.query.force === "true";
  try {
    // Feature 010 T018 — pre_destroy hook gate before bootstrap hard-delete.
    const { hardDeleteWithHooks } = await import(
      "../services/hard-delete-with-hooks.js"
    );
    await hardDeleteWithHooks(
      id,
      getUserId(req),
      async () => ({ removed: { remotePath: "" } }),
      { force },
    );
    const result = await bootstrapOrchestrator.hardDelete(
      id,
      parsed.data.confirmName,
      getUserId(req),
      jailRoot(),
    );
    res.json({ id, removed: result.removed });
    return;
  } catch (err) {
    const e = err as Error & { name?: string; hookPath?: string; exitCode?: number; sshStderr?: string };
    if (e.name === "PreDestroyHookFailed") {
      res.status(422).json({
        error: {
          code: "pre_destroy_hook_failed",
          message: e.message,
          details: { hookPath: e.hookPath, exitCode: e.exitCode, sshStderr: e.sshStderr },
        },
      });
      return;
    }
    if (e.name === "HardDeleteAppNotFound") {
      res.status(404).json({
        error: { code: "NOT_FOUND", message: "Application not found" },
      });
      return;
    }
    // fall through to existing handler below
    if (err instanceof PathJailEscapeError) {
      res.status(422).json({
        error: {
          code: "JAIL_ESCAPE",
          message: err.message,
          details: { remotePath: err.resolved, jailRoot: err.jailRoot },
        },
      });
      return;
    }
    if (err instanceof BootstrapStateError) {
      const status = err.toState === "hard_deleted" && err.message === "CONFIRM_MISMATCH" ? 400 : 400;
      res.status(status).json({
        error: {
          code: err.message === "CONFIRM_MISMATCH" ? "CONFIRM_MISMATCH" : "INVALID_TRANSITION",
          message: err.message,
        },
      });
      return;
    }
    if (err instanceof SlugCollisionError) {
      res.status(409).json({ error: { code: "SLUG_COLLISION", message: err.message } });
      return;
    }
    logger.error({ ctx: "bootstrap-route", err }, "hard-delete failed");
    res.status(503).json({
      error: {
        code: "SSH_UNREACHABLE",
        message: err instanceof Error ? err.message : String(err),
      },
    });
    return;
  }
});

// ── GET /api/servers/:serverId/bootstraps ────────────────────────────────────
// T069 — list bootstraps for a server, optional status filter.

const listStatusSchema = z.enum(["all", "in_flight", "failed", "active"]).optional();

bootstrapRouter.get("/servers/:serverId/bootstraps", async (req, res) => {
  const serverId = req.params.serverId;
  if (!serverId) {
    res.status(400).json({ error: { code: "INVALID_PARAMS", message: "serverId required" } });
    return;
  }
  const statusParse = listStatusSchema.safeParse(req.query.status);
  if (!statusParse.success) {
    res.status(400).json({ error: { code: "INVALID_PARAMS", message: "Invalid status filter" } });
    return;
  }
  const status = statusParse.data ?? "all";
  const inFlight: BootstrapState[] = [
    "init",
    "cloning",
    "compose_up",
    "healthcheck",
    "proxy_applied",
    "cert_issued",
  ];
  const baseQuery = db
    .select({
      id: applications.id,
      name: applications.name,
      bootstrapState: applications.bootstrapState,
      createdAt: applications.createdAt,
    })
    .from(applications);

  let whereClause;
  if (status === "in_flight") {
    whereClause = and(
      eq(applications.serverId, serverId),
      eq(applications.createdVia, "bootstrap"),
      sql`${applications.bootstrapState} IN ${inFlight}`,
    );
  } else if (status === "failed") {
    whereClause = and(
      eq(applications.serverId, serverId),
      eq(applications.createdVia, "bootstrap"),
      sql`${applications.bootstrapState} LIKE 'failed_%'`,
    );
  } else if (status === "active") {
    whereClause = and(
      eq(applications.serverId, serverId),
      eq(applications.createdVia, "bootstrap"),
      eq(applications.bootstrapState, "active"),
    );
  } else {
    whereClause = and(
      eq(applications.serverId, serverId),
      eq(applications.createdVia, "bootstrap"),
    );
  }
  const rows = await baseQuery.where(whereClause).orderBy(desc(applications.createdAt));
  // Sort: in-flight first, then by createdAt desc.
  const inFlightSet = new Set(inFlight);
  rows.sort((a, b) => {
    const aIf = inFlightSet.has(a.bootstrapState as BootstrapState) ? 0 : 1;
    const bIf = inFlightSet.has(b.bootstrapState as BootstrapState) ? 0 : 1;
    if (aIf !== bIf) return aIf - bIf;
    return a.createdAt < b.createdAt ? 1 : -1;
  });
  res.json({ bootstraps: rows });
});

// Used by index.ts. Express route layering: this router mounts at /api like
// the others; routes above use full /api/* paths internally.
function _ensureType(_v: Response): void {
  /* no-op */
}
_ensureType.toString();
