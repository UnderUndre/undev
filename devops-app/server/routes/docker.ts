import { Router } from "express";
import { z } from "zod";
import { sshPool } from "../services/ssh-pool.js";
import { scriptRunner } from "../services/script-runner.js";
import { validateBody } from "../middleware/validate.js";
import { db } from "../db/index.js";
import { servers } from "../db/schema.js";
import { eq } from "drizzle-orm";

export const dockerRouter = Router();

const cleanupSchema = z.object({
  mode: z.enum(["safe", "aggressive"]),
});

// GET /api/servers/:serverId/docker
dockerRouter.get("/servers/:serverId/docker", async (req, res) => {
  const serverId = req.params.serverId as string;

  if (!sshPool.isConnected(serverId)) {
    res.status(503).json({ error: { code: "NOT_CONNECTED", message: "Server not connected" } });
    return;
  }

  try {
    const [dfResult, psResult] = await Promise.all([
      sshPool.exec(serverId, "docker system df --format json 2>/dev/null || echo '{}'"),
      sshPool.exec(serverId, 'docker ps -a --format \'{"name":"{{.Names}}","status":"{{.Status}}","image":"{{.Image}}"}\''),
    ]);

    const containers = psResult.stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    let diskUsage = {};
    try {
      diskUsage = JSON.parse(dfResult.stdout.trim());
    } catch {
      // Fallback
    }

    res.json({ diskUsage, containers });
  } catch (err) {
    res.status(500).json({
      error: { code: "DOCKER_ERROR", message: "Failed to get Docker info" },
    });
  }
});

// POST /api/servers/:serverId/docker/cleanup
dockerRouter.post(
  "/servers/:serverId/docker/cleanup",
  validateBody(cleanupSchema),
  async (req, res) => {
    const serverId = req.params.serverId as string;
    const { mode } = req.body;

    const [server] = await db
      .select()
      .from(servers)
      .where(eq(servers.id, serverId))
      .limit(1);

    if (!server) {
      res.status(404).json({ error: { code: "NOT_FOUND", message: "Server not found" } });
      return;
    }

    try {
      const { jobId } = await scriptRunner.runScript(
        serverId,
        `${server.scriptsPath}/scripts/docker/docker-cleanup.sh`,
        [`--mode=${mode}`],
      );

      res.json({ jobId });
    } catch {
      res.status(500).json({
        error: { code: "CLEANUP_ERROR", message: "Failed to start Docker cleanup" },
      });
    }
  },
);
