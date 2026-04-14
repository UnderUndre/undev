import { Router } from "express";
import { db } from "../db/index.js";
import { auditEntries } from "../db/schema.js";
import { desc, eq, and, gte, lte, sql } from "drizzle-orm";
import { scriptRunner } from "../services/script-runner.js";
import { applications, servers } from "../db/schema.js";

export const auditRouter = Router();

// GET /api/audit-trail
auditRouter.get("/audit-trail", async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const offset = Number(req.query.offset) || 0;

  const result = await db
    .select()
    .from(auditEntries)
    .orderBy(desc(auditEntries.timestamp))
    .limit(limit)
    .offset(offset);

  const countResult = await db
    .select({ count: sql<number>`count(*)` })
    .from(auditEntries);
  const total = Number(countResult[0]?.count ?? 0);

  res.json({ items: result, total });
});

// POST /api/apps/:appId/audit (security audit)
auditRouter.post("/apps/:appId/audit", async (req, res) => {
  const appId = req.params.appId as string;

  const [app] = await db
    .select()
    .from(applications)
    .where(eq(applications.id, appId))
    .limit(1);

  if (!app) {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "Application not found" } });
    return;
  }

  const [server] = await db
    .select()
    .from(servers)
    .where(eq(servers.id, app.serverId))
    .limit(1);

  if (!server) {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "Server not found" } });
    return;
  }

  try {
    const { jobId } = await scriptRunner.runScript(
      server.id,
      "~/.undev/scripts/security/security-audit.sh",
      [`--app=${app.remotePath}`],
    );

    res.status(201).json({ jobId });
  } catch {
    res.status(500).json({
      error: { code: "AUDIT_ERROR", message: "Failed to start security audit" },
    });
  }
});
