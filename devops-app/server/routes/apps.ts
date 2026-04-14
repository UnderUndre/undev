import { Router } from "express";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { db } from "../db/index.js";
import { applications } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { validateBody } from "../middleware/validate.js";

export const appsRouter = Router();

const createAppSchema = z.object({
  name: z.string().min(1).max(100),
  repoUrl: z.string().min(1),
  branch: z.string().min(1).default("main"),
  remotePath: z.string().min(1),
  deployScript: z.string().min(1),
  envVars: z.record(z.string()).optional().default({}),
});

const updateAppSchema = createAppSchema.partial();

// GET /api/servers/:serverId/apps
appsRouter.get("/servers/:serverId/apps", async (req, res) => {
  const result = await db
    .select()
    .from(applications)
    .where(eq(applications.serverId, req.params.serverId));

  res.json(result);
});

// POST /api/servers/:serverId/apps
appsRouter.post(
  "/servers/:serverId/apps",
  validateBody(createAppSchema),
  async (req, res) => {
    const id = randomUUID();
    const now = new Date().toISOString();

    const [app] = await db
      .insert(applications)
      .values({
        id,
        serverId: req.params.serverId,
        ...req.body,
        createdAt: now,
      })
      .returning();

    res.status(201).json(app);
  },
);

// GET /api/apps/:id
appsRouter.get("/apps/:id", async (req, res) => {
  const [app] = await db
    .select()
    .from(applications)
    .where(eq(applications.id, req.params.id))
    .limit(1);

  if (!app) {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "Application not found" } });
    return;
  }
  res.json(app);
});

// PUT /api/apps/:id
appsRouter.put("/apps/:id", validateBody(updateAppSchema), async (req, res) => {
  const [app] = await db
    .update(applications)
    .set(req.body)
    .where(eq(applications.id, req.params.id))
    .returning();

  if (!app) {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "Application not found" } });
    return;
  }
  res.json(app);
});

// DELETE /api/apps/:id
appsRouter.delete("/apps/:id", async (req, res) => {
  const [deleted] = await db
    .delete(applications)
    .where(eq(applications.id, req.params.id))
    .returning({ id: applications.id });

  if (!deleted) {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "Application not found" } });
    return;
  }
  res.status(204).end();
});
