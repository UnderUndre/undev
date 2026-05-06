/**
 * Feature 010 T040 — paginated faceted audit query + streaming CSV export.
 *
 * Performance budget per R-004 / FR-025:
 *   - Page cap 100, total cap 10000
 *   - Response includes `isCapped: boolean` (true when matching rows ≥ cap)
 *   - CSV export streams 500-row batches via cursor pagination, hard-cap 10000
 *   - Stream loop checks `req.aborted` at each batch boundary (GE-4)
 */

import { and, eq, gte, lte, lt, inArray, sql, desc } from "drizzle-orm";
import type { Request, Response } from "express";
import { db } from "../db/index.js";
import { auditEntries } from "../db/schema.js";
import { logger } from "../lib/logger.js";

export type ResourceTypeFilter = "server" | "application" | "cert" | "bootstrap" | "other";

export interface AuditFilters {
  actor?: ReadonlyArray<string>;
  action?: ReadonlyArray<string>;
  resourceType?: ResourceTypeFilter;
  since?: string;
  until?: string;
}

export interface AuditRow {
  id: string;
  occurredAt: string;
  actor: string;
  action: string;
  resourceType: ResourceTypeFilter;
  resourceId: string | null;
  resourceLabel: string | null;
  details: unknown;
}

export interface AuditQueryResult {
  rows: AuditRow[];
  totalCount: number;
  isCapped: boolean;
  page: number;
  pageSize: number;
}

const PAGE_CAP = 100;
const TOTAL_CAP = 10_000;
const CSV_BATCH = 500;

function classifyTargetType(t: string): ResourceTypeFilter {
  if (t === "server" || t === "application" || t === "cert" || t === "bootstrap") {
    return t;
  }
  return "other";
}

function buildWhere(filters: AuditFilters) {
  const clauses = [];
  if (filters.actor && filters.actor.length > 0) {
    clauses.push(inArray(auditEntries.userId, [...filters.actor]));
  }
  if (filters.action && filters.action.length > 0) {
    clauses.push(inArray(auditEntries.action, [...filters.action]));
  }
  if (filters.resourceType && filters.resourceType !== "other") {
    clauses.push(eq(auditEntries.targetType, filters.resourceType));
  }
  if (filters.since) {
    clauses.push(gte(auditEntries.timestamp, filters.since));
  }
  if (filters.until) {
    clauses.push(lte(auditEntries.timestamp, filters.until));
  }
  return clauses.length > 0 ? and(...clauses) : undefined;
}

function rowFromRecord(r: typeof auditEntries.$inferSelect): AuditRow {
  let details: unknown = r.details;
  if (typeof r.details === "string") {
    try {
      details = JSON.parse(r.details);
    } catch {
      // leave as string
    }
  }
  return {
    id: r.id,
    occurredAt: r.timestamp,
    actor: r.userId,
    action: r.action,
    resourceType: classifyTargetType(r.targetType),
    resourceId: r.targetId === "unknown" ? null : r.targetId,
    resourceLabel: null,
    details,
  };
}

export async function query(
  filters: AuditFilters,
  page: number,
  pageSize: number,
): Promise<AuditQueryResult> {
  const safePage = Math.max(1, Math.floor(page));
  const safePageSize = Math.min(PAGE_CAP, Math.max(1, Math.floor(pageSize)));
  const where = buildWhere(filters);

  const countOver = await db
    .select({ c: sql<number>`COUNT(*)` })
    .from(auditEntries)
    .where(where ?? sql`true`);
  const rawTotal = Number(countOver[0]?.c ?? 0);
  const isCapped = rawTotal >= TOTAL_CAP;
  const totalCount = Math.min(rawTotal, TOTAL_CAP);

  const offset = (safePage - 1) * safePageSize;
  const rows = await db
    .select()
    .from(auditEntries)
    .where(where ?? sql`true`)
    .orderBy(desc(auditEntries.timestamp))
    .limit(safePageSize)
    .offset(offset);

  return {
    rows: rows.map(rowFromRecord),
    totalCount,
    isCapped,
    page: safePage,
    pageSize: safePageSize,
  };
}

function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export async function streamCsv(
  filters: AuditFilters,
  req: Request,
  res: Response,
): Promise<void> {
  const where = buildWhere(filters);
  let aborted = false;
  req.on("close", () => {
    aborted = true;
  });

  res.write(
    "timestamp,actor,action,resource_type,resource_id,resource_label,details_json\n",
  );

  let cursor: string | null = null;
  let total = 0;
  while (total < TOTAL_CAP && !aborted) {
    const baseClauses = where ? [where] : [];
    if (cursor) baseClauses.push(lt(auditEntries.timestamp, cursor));
    const batch = await db
      .select()
      .from(auditEntries)
      .where(baseClauses.length > 0 ? and(...baseClauses) : sql`true`)
      .orderBy(desc(auditEntries.timestamp))
      .limit(CSV_BATCH);
    if (batch.length === 0) break;
    for (const r of batch) {
      if (aborted || total >= TOTAL_CAP) break;
      const row = rowFromRecord(r);
      const line = [
        row.occurredAt,
        row.actor,
        row.action,
        row.resourceType,
        row.resourceId ?? "",
        row.resourceLabel ?? "",
        csvEscape(row.details),
      ]
        .map((v, i) => (i < 6 ? csvEscape(v) : v))
        .join(",");
      res.write(`${line}\n`);
      total += 1;
      cursor = r.timestamp;
    }
    if (batch.length < CSV_BATCH) break;
  }
  if (aborted) {
    logger.info({ ctx: "audit-query-csv", total }, "CSV export aborted by client");
  }
  res.end();
}
