/**
 * Feature 010 T041 — paginated audit query + CSV export endpoints.
 *
 * Note filename — `routes/audit.ts` already exists (feature 001's
 * older audit listing endpoint). This file mounts at the same router
 * prefix but adds the new faceted-query + CSV endpoints.
 */

import { Router } from "express";
import { z } from "zod";
import { query, streamCsv, type AuditFilters } from "../services/audit-query.js";

export const auditQueryRouter = Router();

const ResourceType = z.enum(["server", "application", "cert", "bootstrap", "other"]);

function parseArrayParam(input: unknown): string[] | undefined {
  if (input === undefined || input === null) return undefined;
  if (Array.isArray(input)) return input.map((v) => String(v));
  if (typeof input === "string") return input.split(",").filter(Boolean);
  return undefined;
}

const querySchema = z.object({
  resourceType: ResourceType.optional(),
  since: z.string().datetime().optional(),
  until: z.string().datetime().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});

function buildFilters(req: import("express").Request): AuditFilters & { page: number; pageSize: number } {
  const parsed = querySchema.parse(req.query);
  return {
    actor: parseArrayParam(req.query.actor),
    action: parseArrayParam(req.query.action),
    resourceType: parsed.resourceType,
    since: parsed.since,
    until: parsed.until,
    page: parsed.page,
    pageSize: parsed.pageSize,
  };
}

auditQueryRouter.get("/audit/query", async (req, res) => {
  try {
    const f = buildFilters(req);
    const result = await query(f, f.page, f.pageSize);
    res.json(result);
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({
        error: { code: "INVALID_PARAMS", message: "Invalid filters", details: err.flatten() },
      });
      return;
    }
    throw err;
  }
});

auditQueryRouter.get("/audit/export.csv", async (req, res) => {
  try {
    const f = buildFilters(req);
    const filename = `audit-${new Date().toISOString().replace(/[:.]/g, "-")}.csv`;
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    await streamCsv(f, req, res);
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({
        error: { code: "INVALID_PARAMS", message: "Invalid filters", details: err.flatten() },
      });
      return;
    }
    throw err;
  }
});
