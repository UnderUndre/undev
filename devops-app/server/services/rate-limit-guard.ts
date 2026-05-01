/**
 * Feature 008 T022 — Let's Encrypt rate-limit guard (FR-023..FR-024 / R-007).
 *
 * Counts `app_certs` rows for the registered domain over the last 7 days.
 * Boundaries: warn ≥3, block ≥5.
 */

import { sql } from "drizzle-orm";
import { getRegisteredDomain } from "../lib/psl.js";

export type RateLimitResult =
  | { kind: "ok"; count: number; registered: string }
  | { kind: "warn"; count: number; registered: string }
  | { kind: "block"; count: number; registered: string };

interface CountQuery {
  count(registered: string): Promise<number>;
}

// Lazy db lookup — keeps unit tests that pass their own `deps` from
// triggering the DATABASE_URL check at module-load time.
const defaultCountQuery: CountQuery = {
  async count(registered) {
    const { db } = await import("../db/index.js");
    const rows = await db.execute<{ count: string | number } & Record<string, unknown>>(
      sql`
        SELECT COUNT(*)::int AS count
          FROM app_certs
         WHERE status IN ('pending', 'active', 'failed')
           AND created_at::timestamptz > NOW() - INTERVAL '7 days'
           AND (domain = ${registered} OR domain LIKE '%.' || ${registered})
      `,
    );
    const row = (rows as unknown as { count: string | number }[])[0];
    if (!row) return 0;
    const c = typeof row.count === "string" ? Number(row.count) : row.count;
    return Number.isFinite(c) ? c : 0;
  },
};

export async function checkRateLimit(
  domain: string,
  deps: CountQuery = defaultCountQuery,
): Promise<RateLimitResult> {
  const registered = getRegisteredDomain(domain);
  const count = await deps.count(registered);
  if (count >= 5) return { kind: "block", count, registered };
  if (count >= 3) return { kind: "warn", count, registered };
  return { kind: "ok", count, registered };
}
