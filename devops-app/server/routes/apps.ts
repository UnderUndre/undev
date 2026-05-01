import { Router } from "express";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { db } from "../db/index.js";
import { applications } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { validateBody } from "../middleware/validate.js";
import { normalisePath } from "../services/scanner-dedup.js";
import { validateScriptPath } from "../lib/validate-script-path.js";
import { healthUrlFieldSchema } from "../lib/health-config-schema.js";
import { validateDomain } from "../lib/domain-validator.js";

export const appsRouter = Router();

const createAppSchema = z
  .object({
    name: z.string().min(1).max(100),
    repoUrl: z.string().min(1),
    branch: z.string().min(1).default("main"),
    remotePath: z.string().min(1).transform(normalisePath), // FR-040: canonical form at write time
    envVars: z.record(z.string(), z.string()).optional().default({}),
    githubRepo: z
      .string()
      .regex(/^[^/\s]+\/[^/\s]+$/, "Must be in 'owner/repo' format")
      .nullable()
      .optional(),
    source: z.enum(["manual", "scan"]).optional().default("manual"),
    skipInitialClone: z.boolean().optional(),
    // Feature 007: optional project-local deploy script. Strict typing —
    // non-string non-null non-absent rejected by z.union before it reaches
    // validateScriptPath. Empty/whitespace normalises to null in the handler.
    scriptPath: z.union([z.string(), z.null()]).optional(),
    // Feature 006 T038: health config fragment (additive, all optional).
    healthUrl: healthUrlFieldSchema.optional(),
    monitoringEnabled: z.boolean().optional(),
    alertsMuted: z.boolean().optional(),
    healthProbeIntervalSec: z.number().int().min(10).optional(),
    healthDebounceCount: z.number().int().min(1).optional(),
    // Feature 008 T036
    domain: z.union([z.string(), z.null()]).optional(),
    acmeEmail: z.union([z.string().email(), z.null()]).optional(),
    proxyType: z.enum(["caddy", "nginx-legacy", "none"]).optional(),
    upstreamService: z.union([z.string(), z.null()]).optional(),
    upstreamPort: z.union([z.number().int().min(1).max(65535), z.null()]).optional(),
  })
  .strict(); // Feature 005: reject deprecated `deployScript` field.

const updateAppSchema = createAppSchema.partial();

// GET /api/servers/:serverId/apps
// Feature 006 T019: response surfaces the 8 health columns additively. Drizzle
// `select()` projects every column on `applications`, including healthUrl /
// healthStatus / healthCheckedAt / healthLastChangeAt / healthMessage /
// healthProbeIntervalSec / healthDebounceCount / monitoringEnabled /
// alertsMuted. No explicit field list needed — backward-compatible additive.
appsRouter.get("/servers/:serverId/apps", async (req, res) => {
  const serverId = req.params.serverId as string;
  const result = await db
    .select()
    .from(applications)
    .where(eq(applications.serverId, serverId));

  res.json(result);
});

// POST /api/servers/:serverId/apps
appsRouter.post(
  "/servers/:serverId/apps",
  validateBody(createAppSchema),
  async (req, res) => {
    const id = randomUUID();
    const now = new Date().toISOString();

    const serverId = req.params.serverId as string;

    // FR-051/052: clients cannot forge the skipInitialClone flag. It is set
    // true iff source === "scan" (backend is the sole writer).
    const body = req.body as z.infer<typeof createAppSchema>;
    const skipInitialClone = body.source === "scan";

    // Feature 007: normalise + validate scriptPath at the route boundary.
    const sp = validateScriptPath(body.scriptPath);
    if (!sp.ok) {
      res.status(400).json({
        error: {
          code: "INVALID_PARAMS",
          message: "Invalid scriptPath",
          details: { fieldErrors: { scriptPath: [sp.error] } },
        },
      });
      return;
    }

    // Feature 008 T036 — domain validator at route boundary
    const dv = validateDomain(body.domain ?? null);
    if (!dv.ok) {
      const code = dv.error.toLowerCase().includes("wildcard")
        ? "WILDCARD_NOT_SUPPORTED"
        : "INVALID_DOMAIN";
      res.status(400).json({
        error: { code, message: dv.error, details: { fieldErrors: { domain: [dv.error] } } },
      });
      return;
    }

    const [app] = await db
      .insert(applications)
      .values({
        id,
        serverId,
        name: body.name,
        repoUrl: body.repoUrl,
        branch: body.branch,
        remotePath: body.remotePath,
        envVars: body.envVars,
        githubRepo: body.githubRepo ?? null,
        scriptPath: sp.value,
        skipInitialClone,
        domain: dv.value,
        acmeEmail: body.acmeEmail ?? null,
        proxyType: body.proxyType ?? "caddy",
        upstreamService: body.upstreamService ?? null,
        upstreamPort: body.upstreamPort ?? null,
        createdAt: now,
      })
      .returning();

    res.status(201).json(app);
  },
);

// GET /api/apps/:id
// Feature 006 T019: response surfaces the 8 health columns additively (see
// note on the GET /servers/:serverId/apps handler above).
appsRouter.get("/apps/:id", async (req, res) => {
  const id = req.params.id as string;
  const [app] = await db
    .select()
    .from(applications)
    .where(eq(applications.id, id))
    .limit(1);

  if (!app) {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "Application not found" } });
    return;
  }
  res.json(app);
});

// PUT /api/apps/:id
appsRouter.put("/apps/:id", validateBody(updateAppSchema), async (req, res) => {
  const id = req.params.id as string;
  const body = req.body as z.infer<typeof updateAppSchema>;

  // Feature 007: normalise scriptPath. Three states:
  //   absent (key missing)  → leave row column untouched
  //   explicit null          → clear (set to null)
  //   string                 → trim + validate; "" or whitespace → null
  const updates = { ...body };
  if ("scriptPath" in body) {
    const sp = validateScriptPath(body.scriptPath);
    if (!sp.ok) {
      res.status(400).json({
        error: {
          code: "INVALID_PARAMS",
          message: "Invalid scriptPath",
          details: { fieldErrors: { scriptPath: [sp.error] } },
        },
      });
      return;
    }
    updates.scriptPath = sp.value;
  }
  if ("domain" in body) {
    const dv = validateDomain(body.domain ?? null);
    if (!dv.ok) {
      const code = dv.error.toLowerCase().includes("wildcard")
        ? "WILDCARD_NOT_SUPPORTED"
        : "INVALID_DOMAIN";
      res.status(400).json({
        error: { code, message: dv.error, details: { fieldErrors: { domain: [dv.error] } } },
      });
      return;
    }
    updates.domain = dv.value;
  }

  const [app] = await db
    .update(applications)
    .set(updates)
    .where(eq(applications.id, id))
    .returning();

  if (!app) {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "Application not found" } });
    return;
  }
  res.json(app);
});

// DELETE /api/apps/:id  (Feature 008 T055)
//
// Default path: DELETE the app row. `app_certs` + `app_cert_events` cascade.
//   v1 limitation: spec asks for soft-retain (30d grace), but cascade defeats
//   that. Re-enable when `applications.deleted_at` (or `ON DELETE SET NULL`)
//   ships. Documented below at the soft-path branch.
//
// Hard path (?hard=true, FR-018a — best-effort Caddy + authoritative DB):
//   1-3 (best-effort) — revoke each cert via Caddy, remove site, rm files;
//                       failures audited as `hard_delete_partial` events.
//   4-5 (authoritative) — DELETE app_certs rows, DELETE app row.
appsRouter.delete("/apps/:id", async (req, res) => {
  const id = req.params.id as string;
  const hard = req.query.hard === "true";
  const confirmName =
    typeof req.headers["x-confirm-name"] === "string" ? req.headers["x-confirm-name"] : null;

  const [app] = await (await import("../db/schema.js")).applications
    ? await db.select().from(applications).where(eq(applications.id, id)).limit(1)
    : [];
  if (!app) {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "Application not found" } });
    return;
  }

  if (hard) {
    if (confirmName !== app.name) {
      res.status(400).json({
        error: {
          code: "HARD_DELETE_NAME_MISMATCH",
          message: "Application name does not match confirmation",
          details: { expected: app.name, got: confirmName },
        },
      });
      return;
    }

    const { appCerts: appCertsTable, appCertEvents: appCertEventsTable } = await import(
      "../db/schema.js"
    );
    const { caddyAdminClient: cac, CaddyAdminError: CAE } = await import(
      "../services/caddy-admin-client.js"
    );
    const { reconcile: rec } = await import("../services/caddy-reconciler.js");
    const { sshPool: sp } = await import("../services/ssh-pool.js");
    const { shQuote } = await import("../lib/sh-quote.js");
    const { logger } = await import("../lib/logger.js");
    const { randomUUID } = await import("node:crypto");

    const certs = await db.select().from(appCertsTable).where(eq(appCertsTable.appId, id));

    // Step 1 — revoke each cert (best-effort)
    for (const c of certs) {
      try {
        await cac.revokeCert(app.serverId, c.domain);
      } catch (err) {
        if (err instanceof CAE) {
          logger.warn(
            { ctx: "hard-delete", err, certId: c.id, step: "revoke" },
            "caddy cleanup failed during hard delete",
          );
          await db.insert(appCertEventsTable).values({
            id: randomUUID(),
            certId: c.id,
            eventType: "hard_delete_partial",
            eventData: { failed_step: "revoke", error_message: err.message },
            actor: "system",
            occurredAt: new Date().toISOString(),
          });
        } else {
          throw err;
        }
      }
    }

    // Step 2 — Caddy site removal via reconcile (after we delete the app rows below).
    // Step 3 — rm cert files (best-effort).
    for (const c of certs) {
      try {
        await sp.exec(
          app.serverId,
          `rm -rf /var/lib/caddy/.local/share/caddy/certificates/*/${shQuote(c.domain)} 2>/dev/null || true`,
          15_000,
        );
      } catch (err) {
        logger.warn(
          { ctx: "hard-delete", err, certId: c.id, step: "rm" },
          "caddy cleanup failed during hard delete",
        );
        await db.insert(appCertEventsTable).values({
          id: randomUUID(),
          certId: c.id,
          eventType: "hard_delete_partial",
          eventData: { failed_step: "rm", error_message: (err as Error).message },
          actor: "system",
          occurredAt: new Date().toISOString(),
        });
      }
    }

    // Steps 4-5 — authoritative DB cleanup. CASCADE removes app_certs + app_cert_events.
    await db.delete(applications).where(eq(applications.id, id));

    // Post-delete reconcile to trim the Caddy site (step 2).
    void rec(app.serverId).catch((err) => {
      logger.warn({ ctx: "hard-delete-reconcile", err }, "post-delete reconcile failed");
    });

    res.status(204).end();
    return;
  }

  // Soft path — DELETE the app row. `app_certs` and `app_cert_events` cascade.
  //
  // v1 limitation (per gemini-code-assist review): the spec calls for marking
  // certs `orphaned (app_soft_delete)` with a 30-day grace window, but the
  // current schema has `ON DELETE CASCADE` on app_certs.app_id, so any UPDATE
  // we make here is undone immediately by the DELETE below. Until a
  // `applications.deleted_at` column ships (or the FK becomes
  // `ON DELETE SET NULL`), the orphan-marking has no lasting effect — so we
  // omit it rather than mislead future readers.
  const [deleted] = await db
    .delete(applications)
    .where(eq(applications.id, id))
    .returning({ id: applications.id });
  if (!deleted) {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "Application not found" } });
    return;
  }
  res.status(204).end();
});
