import { Router } from "express";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { db } from "../db/index.js";
import { applications } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { validateBody } from "../middleware/validate.js";
import { normalisePath } from "../services/scanner-dedup.js";
import { validateScriptPath } from "../lib/validate-script-path.js";

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
  })
  .strict(); // Feature 005: reject deprecated `deployScript` field.

const updateAppSchema = createAppSchema.partial();

// GET /api/servers/:serverId/apps
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
        createdAt: now,
      })
      .returning();

    res.status(201).json(app);
  },
);

// GET /api/apps/:id
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
  const updates = { ...body } as Record<string, unknown>;
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

// DELETE /api/apps/:id
appsRouter.delete("/apps/:id", async (req, res) => {
  const id = req.params.id as string;
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
