import { Router } from "express";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { db } from "../db/index.js";
import { servers } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { validateBody } from "../middleware/validate.js";
import { sshPool } from "../services/ssh-pool.js";
import { scriptRunner } from "../services/script-runner.js";

export const serversRouter = Router();

const createServerSchema = z.object({
  label: z.string().min(1).max(100),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535).default(22),
  sshUser: z.string().min(1),
  sshAuthMethod: z.enum(["key", "password"]).default("key"),
  sshPrivateKey: z.string().optional(),
  sshPassword: z.string().optional(),
  scriptsPath: z.string().default(""),
});

const updateServerSchema = createServerSchema.partial();

// GET /api/servers
serversRouter.get("/", async (_req, res) => {
  const result = await db.select().from(servers);
  res.json(result);
});

// POST /api/servers
serversRouter.post("/", validateBody(createServerSchema), async (req, res) => {
  const id = randomUUID();
  const now = new Date().toISOString();

  const [server] = await db
    .insert(servers)
    .values({ id, ...req.body, createdAt: now })
    .returning();

  res.status(201).json(server);
});

// GET /api/servers/:id
serversRouter.get("/:id", async (req, res) => {
  const id = req.params.id as string;
  const [server] = await db
    .select()
    .from(servers)
    .where(eq(servers.id, id))
    .limit(1);

  if (!server) {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "Server not found" } });
    return;
  }
  res.json(server);
});

// PUT /api/servers/:id
serversRouter.put("/:id", validateBody(updateServerSchema), async (req, res) => {
  const id = req.params.id as string;
  const [server] = await db
    .update(servers)
    .set(req.body)
    .where(eq(servers.id, id))
    .returning();

  if (!server) {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "Server not found" } });
    return;
  }
  res.json(server);
});

// DELETE /api/servers/:id
serversRouter.delete("/:id", async (req, res) => {
  const id = req.params.id as string;
  sshPool.disconnect(id);

  const [deleted] = await db
    .delete(servers)
    .where(eq(servers.id, id))
    .returning({ id: servers.id });

  if (!deleted) {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "Server not found" } });
    return;
  }
  res.status(204).end();
});

// POST /api/servers/:id/verify
serversRouter.post("/:id/verify", async (req, res) => {
  const id = req.params.id as string;
  const [server] = await db
    .select()
    .from(servers)
    .where(eq(servers.id, id))
    .limit(1);

  if (!server) {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "Server not found" } });
    return;
  }

  const start = Date.now();
  try {
    await sshPool.connect({
      id: server.id,
      host: server.host,
      port: server.port,
      sshUser: server.sshUser,
      sshAuthMethod: (server.sshAuthMethod as "key" | "password") ?? "key",
      sshPrivateKey: server.sshPrivateKey,
      sshPassword: server.sshPassword,
    });

    const latencyMs = Date.now() - start;

    await db
      .update(servers)
      .set({ status: "online", lastHealthCheck: new Date().toISOString() })
      .where(eq(servers.id, server.id));

    res.json({ status: "online", latencyMs });
  } catch (err) {
    const latencyMs = Date.now() - start;

    await db
      .update(servers)
      .set({ status: "offline", lastHealthCheck: new Date().toISOString() })
      .where(eq(servers.id, server.id));

    res.json({
      status: "offline",
      latencyMs,
      error: err instanceof Error ? err.message : "Connection failed",
    });
  }
});

// POST /api/servers/:id/setup (T046)
const setupSchema = z.object({
  tasks: z.array(z.string().min(1)).min(1),
});

serversRouter.post("/:id/setup", validateBody(setupSchema), async (req, res) => {
  const id = req.params.id as string;
  const [server] = await db
    .select()
    .from(servers)
    .where(eq(servers.id, id))
    .limit(1);

  if (!server) {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "Server not found" } });
    return;
  }

  const { tasks } = req.body;

  try {
    // Run tasks sequentially as one job
    const scriptArgs = tasks.map((t: string) => `--task=${t}`);
    const { jobId } = await scriptRunner.runScript(
      server.id,
      `${server.scriptsPath}/scripts/setup/setup-vps.sh`,
      scriptArgs,
    );

    res.json({ jobId });
  } catch {
    res.status(500).json({
      error: { code: "SETUP_ERROR", message: "Failed to start server setup" },
    });
  }
});
