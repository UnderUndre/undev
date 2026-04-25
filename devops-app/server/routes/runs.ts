/**
 * Feature 005 T043: runs history API.
 *
 *   GET /api/runs                 → paginated list with filters
 *   GET /api/runs/:id             → detail view including `archived` flag
 *
 * `archived` is computed read-side: when the row's scriptId is no longer
 * present in the current manifest (FR-043). The UI uses this to mute the
 * Re-run button.
 */

import { Router } from "express";
import { z } from "zod";
import { and, desc, eq, type SQL } from "drizzle-orm";
import { db } from "../db/index.js";
import { scriptRuns } from "../db/schema.js";
import { scriptsRunner } from "../services/scripts-runner.js";

export const runsRouter = Router();

const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  status: z.string().optional(),
  serverId: z.string().optional(),
  scriptId: z.string().optional(),
});

runsRouter.get("/runs", async (req, res) => {
  const parsed = listQuery.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({
      error: {
        code: "INVALID_QUERY",
        message: "Query validation failed",
        details: { fieldErrors: parsed.error.flatten().fieldErrors },
      },
    });
    return;
  }
  const { limit, offset, status, serverId, scriptId } = parsed.data;

  const rawConditions: (SQL | undefined)[] = [
    status ? eq(scriptRuns.status, status) : undefined,
    serverId ? eq(scriptRuns.serverId, serverId) : undefined,
    scriptId ? eq(scriptRuns.scriptId, scriptId) : undefined,
  ];
  const conditions: SQL[] = rawConditions.filter((c): c is SQL => Boolean(c));

  const rows = await db
    .select()
    .from(scriptRuns)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(scriptRuns.startedAt))
    .limit(limit)
    .offset(offset);

  const activeIds = new Set(
    scriptsRunner.getManifestDescriptor().map((d) => d.id),
  );

  res.json({
    runs: rows.map((r) => ({
      id: r.id,
      scriptId: r.scriptId,
      serverId: r.serverId,
      userId: r.userId,
      status: r.status,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      duration: r.duration,
      archived: !activeIds.has(r.scriptId),
      // Feature 007: surface params so renderScriptIdentity() can extract
      // scriptPath for `deploy/project-local-deploy` rows. Already masked at
      // insert time via maskSecrets() in scripts-runner.
      params: r.params,
    })),
  });
});

runsRouter.get("/runs/:id", async (req, res) => {
  const id = req.params.id as string;
  const [row] = await db
    .select()
    .from(scriptRuns)
    .where(eq(scriptRuns.id, id))
    .limit(1);
  if (!row) {
    res.status(404).json({
      error: { code: "NOT_FOUND", message: "Run not found" },
    });
    return;
  }

  const activeIds = new Set(
    scriptsRunner.getManifestDescriptor().map((d) => d.id),
  );
  const archived = !activeIds.has(row.scriptId);

  res.json({
    ...row,
    archived,
    reRunnable: !archived,
  });
});
