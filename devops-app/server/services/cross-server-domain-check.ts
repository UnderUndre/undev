/**
 * Feature 010 T032 — find cross-server conflicts for a domain.
 *
 * One parameterised SELECT joining `applications` + `servers` + latest
 * `app_certs` row. Returns conflicts sorted by `serverLabel` then `appName`.
 * Excludes soft-deleted apps (none yet — column TBD; placeholder for v2).
 */

import { and, eq, ne, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { applications, servers, appCerts } from "../db/schema.js";

export interface DomainConflict {
  appId: string;
  appName: string;
  serverId: string;
  serverLabel: string;
  domain: string;
  certStatus: string | null;
}

export async function findCrossServerConflicts(
  domain: string,
  excludeAppId: string,
): Promise<DomainConflict[]> {
  const rows = await db
    .select({
      appId: applications.id,
      appName: applications.name,
      serverId: applications.serverId,
      serverLabel: servers.label,
      domain: applications.domain,
      // Latest cert status by created_at via correlated subquery.
      certStatus: sql<string | null>`(
        SELECT ${appCerts.status}
        FROM ${appCerts}
        WHERE ${appCerts.appId} = ${applications.id}
        ORDER BY ${appCerts.createdAt} DESC
        LIMIT 1
      )`,
    })
    .from(applications)
    .innerJoin(servers, eq(servers.id, applications.serverId))
    .where(
      and(
        eq(applications.domain, domain),
        ne(applications.id, excludeAppId),
      ),
    );

  return rows
    .filter((r): r is DomainConflict => r.domain !== null)
    .sort((a, b) =>
      a.serverLabel.localeCompare(b.serverLabel) ||
      a.appName.localeCompare(b.appName),
    );
}
