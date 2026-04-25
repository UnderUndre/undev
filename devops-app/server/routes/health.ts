import { Router } from "express";
import { db } from "../db/index.js";
import { healthSnapshots } from "../db/schema.js";
import { eq, desc, gte, and } from "drizzle-orm";
import { healthPoller } from "../services/health-poller.js";

export const healthRouter = Router();

// Map drizzle row OR poller snapshot → API contract expected by
// client/hooks/useHealth.ts. Both sources share the same field names (the
// poller writes the row), but TS types diverge (drizzle infers strict, poller
// returns Record<string, unknown>). One projection serves both via duck-typing.
function projectSnapshot(row: Record<string, unknown>) {
  const services = row.services;
  const containers = row.dockerContainers;
  return {
    cpu: Number(row.cpuLoadPercent ?? 0),
    memory: Number(row.memoryPercent ?? 0),
    disk: Number(row.diskPercent ?? 0),
    swap: Number(row.swapPercent ?? 0),
    services: Array.isArray(services) ? services : [],
    containers: Array.isArray(containers) ? containers : [],
    checkedAt: typeof row.timestamp === "string" ? row.timestamp : "",
  };
}

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
  res.json(projectSnapshot(latest));
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

  res.json(result.map(projectSnapshot));
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
  res.json(projectSnapshot(snapshot));
});
