import { Router } from "express";
import { db } from "../db/index.js";
import { healthSnapshots } from "../db/schema.js";
import { eq, desc, gte, and } from "drizzle-orm";
import { healthPoller } from "../services/health-poller.js";

export const healthRouter = Router();

// GET /api/servers/:serverId/health
healthRouter.get("/servers/:serverId/health", async (req, res) => {
  const [latest] = await db
    .select()
    .from(healthSnapshots)
    .where(eq(healthSnapshots.serverId, req.params.serverId))
    .orderBy(desc(healthSnapshots.timestamp))
    .limit(1);

  if (!latest) {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "No health data" } });
    return;
  }
  res.json(latest);
});

// GET /api/servers/:serverId/health/history
healthRouter.get("/servers/:serverId/health/history", async (req, res) => {
  const hours = Number(req.query.hours) || 24;
  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

  const result = await db
    .select()
    .from(healthSnapshots)
    .where(
      and(
        eq(healthSnapshots.serverId, req.params.serverId),
        gte(healthSnapshots.timestamp, since),
      ),
    )
    .orderBy(desc(healthSnapshots.timestamp));

  res.json(result);
});

// POST /api/servers/:serverId/health/refresh
healthRouter.post("/servers/:serverId/health/refresh", async (req, res) => {
  const snapshot = await healthPoller.pollOnce(req.params.serverId);
  if (!snapshot) {
    res.status(503).json({
      error: { code: "POLL_FAILED", message: "Health check failed" },
    });
    return;
  }
  res.json(snapshot);
});
