/**
 * Feature 010 T050 — Migration toolkit.
 *
 *   adopt(input, userId): INSERT new app row OR PATCH-promote existing
 *   `created_via='scan'` row (preserving its origin).
 *
 * Pre-flight (in order):
 *   1. Path-jail check via feature 009's `path-jail.ts:resolveAndJailCheck`
 *      against `server.scan_roots` (per Session 2026-05-05 GE-1).
 *   2. SSH `test -d <remotePath>` validation.
 *   3. If `domain` non-null, `domain-attach-validator.validateDomainAttach`.
 *   4. Collision query on `(server_id, remote_path)`.
 *
 * Branch logic:
 *   - No row → INSERT with `created_via='migrate'`, audit `app.migrated`.
 *   - `created_via='scan'` row → PATCH-promote, preserve origin, audit
 *     `app.migrated_from_scan`.
 *   - Other origin → 409 `path_already_managed`.
 */

import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { applications, auditEntries, servers } from "../db/schema.js";
import { sshPool } from "./ssh-pool.js";
import { shQuote } from "../lib/sh-quote.js";
import { resolveAndJailCheck, type ExecCapture } from "../lib/path-jail.js";
import { validateDomainAttach } from "../lib/domain-attach-validator.js";
import { logger } from "../lib/logger.js";

export interface MigrationInput {
  serverId: string;
  remotePath: string;
  composePath?: string;
  healthUrl?: string | null;
  domain?: string | null;
  domainTypedConfirmation?: string | null;
}

export type MigrationResult =
  | {
      kind: "insert";
      appId: string;
      app: typeof applications.$inferSelect;
      detected: { repoUrl: string | null };
    }
  | {
      kind: "patch_promote";
      appId: string;
      app: typeof applications.$inferSelect;
      addedFields: string[];
      preservedCreatedVia: "scan";
    }
  | { kind: "path_already_managed"; existing: { id: string; name: string; createdVia: string } }
  | { kind: "target_path_invalid"; reason: "not_a_directory" | "ssh_unreachable" | "permission_denied" }
  | {
      kind: "target_path_jail_violation";
      resolvedPath: string;
      allowedRoots: string[];
    }
  | {
      kind: "domain_confirmation_required";
      conflicts: ReadonlyArray<{
        appId: string;
        appName: string;
        serverId: string;
        serverLabel: string;
        domain: string;
        certStatus: string | null;
      }>;
    };

const sshExec: ExecCapture = async (serverId, command) => {
  const r = await sshPool.exec(serverId, command, 15_000);
  return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr };
};

export async function adopt(
  input: MigrationInput,
  userId: string,
): Promise<MigrationResult> {
  // 0. Load server for scan_roots + jail base.
  const [srv] = await db
    .select({ id: servers.id, scanRoots: servers.scanRoots })
    .from(servers)
    .where(eq(servers.id, input.serverId))
    .limit(1);
  if (!srv) {
    return { kind: "target_path_invalid", reason: "ssh_unreachable" };
  }
  const scanRoots = Array.isArray(srv.scanRoots) ? srv.scanRoots : [];

  // 1. Path-jail check — resolved path must be rooted under one of scan_roots.
  let resolved: string | null = null;
  for (const root of scanRoots.length > 0 ? scanRoots : ["/opt", "/srv", "/var/www", "/home"]) {
    const r = await resolveAndJailCheck(sshExec, input.serverId, input.remotePath, root);
    if (r.ok) {
      resolved = r.resolved;
      break;
    }
  }
  if (resolved === null) {
    // Try a single resolve to surface the resolved path for the response.
    let probed = "";
    try {
      const r = await sshExec(
        input.serverId,
        `readlink -f ${shQuote(input.remotePath)} 2>/dev/null || realpath ${shQuote(input.remotePath)} 2>/dev/null`,
      );
      probed = r.stdout.trim();
    } catch {
      /* keep empty */
    }
    return {
      kind: "target_path_jail_violation",
      resolvedPath: probed || input.remotePath,
      allowedRoots: [...(scanRoots.length > 0 ? scanRoots : ["/opt", "/srv", "/var/www", "/home"])],
    };
  }

  // 2. SSH `test -d` validation.
  try {
    const t = await sshPool.exec(
      input.serverId,
      `test -d ${shQuote(input.remotePath)} && echo OK || echo FAIL`,
      10_000,
    );
    if (t.exitCode !== 0 || !t.stdout.includes("OK")) {
      return { kind: "target_path_invalid", reason: "not_a_directory" };
    }
  } catch (err) {
    logger.warn({ ctx: "migration-toolkit", err }, "SSH test -d failed");
    return { kind: "target_path_invalid", reason: "ssh_unreachable" };
  }

  // 3. Cross-server domain check + typed-confirm.
  let domainAuditEvent: "app.cross_server_domain_confirmed" | null = null;
  let domainConflictsForAudit: ReadonlyArray<{ appId: string; appName: string; serverId: string; serverLabel: string; domain: string; certStatus: string | null }> = [];
  if (input.domain) {
    const verdict = await validateDomainAttach(
      input.domain,
      "__pending__", // no app id yet — exclude none
      input.domainTypedConfirmation ?? null,
    );
    if (!verdict.ok) {
      return { kind: "domain_confirmation_required", conflicts: verdict.conflicts };
    }
    domainAuditEvent = verdict.auditEvent;
    domainConflictsForAudit = verdict.conflicts;
  }

  // 4. Collision query on (server_id, remote_path).
  const [existing] = await db
    .select({
      id: applications.id,
      name: applications.name,
      createdVia: applications.createdVia,
      healthUrl: applications.healthUrl,
      domain: applications.domain,
      composePath: applications.composePath,
    })
    .from(applications)
    .where(
      and(
        eq(applications.serverId, input.serverId),
        eq(applications.remotePath, input.remotePath),
      ),
    )
    .limit(1);

  // Detect repoUrl via remote `git config --get remote.origin.url`.
  let detectedRepoUrl: string | null = null;
  try {
    const g = await sshPool.exec(
      input.serverId,
      `cd ${shQuote(input.remotePath)} && git config --get remote.origin.url 2>/dev/null`,
      10_000,
    );
    if (g.exitCode === 0 && g.stdout.trim() !== "") {
      detectedRepoUrl = g.stdout.trim();
    }
  } catch {
    /* not a git repo — leave null */
  }

  const composePath = input.composePath ?? "docker-compose.yml";

  if (existing) {
    if (existing.createdVia !== "scan") {
      return {
        kind: "path_already_managed",
        existing: { id: existing.id, name: existing.name, createdVia: existing.createdVia },
      };
    }
    // PATCH-promote a scan row: fill missing fields only, preserve created_via='scan'.
    const patches: Record<string, string | null> = {};
    const addedFields: string[] = [];
    if (!existing.healthUrl && input.healthUrl) {
      patches.healthUrl = input.healthUrl;
      addedFields.push("healthUrl");
    }
    if (!existing.domain && input.domain) {
      patches.domain = input.domain;
      addedFields.push("domain");
    }
    if (existing.composePath === "docker-compose.yml" && composePath !== "docker-compose.yml") {
      patches.composePath = composePath;
      addedFields.push("composePath");
    }
    if (Object.keys(patches).length > 0) {
      await db.update(applications).set(patches).where(eq(applications.id, existing.id));
    }
    const [updated] = await db
      .select()
      .from(applications)
      .where(eq(applications.id, existing.id))
      .limit(1);
    if (!updated) {
      return { kind: "target_path_invalid", reason: "ssh_unreachable" };
    }
    await db.insert(auditEntries).values({
      id: randomUUID(),
      userId,
      action: "app.migrated_from_scan",
      targetType: "application",
      targetId: existing.id,
      details: JSON.stringify({
        appId: existing.id,
        originServerId: input.serverId,
        originRemotePath: input.remotePath,
        addedFields,
      }),
      result: "success",
      timestamp: new Date().toISOString(),
    });
    if (domainAuditEvent) {
      await db.insert(auditEntries).values({
        id: randomUUID(),
        userId,
        action: domainAuditEvent,
        targetType: "application",
        targetId: existing.id,
        details: JSON.stringify({
          domain: input.domain,
          conflicts: domainConflictsForAudit,
        }),
        result: "success",
        timestamp: new Date().toISOString(),
      });
    }
    return {
      kind: "patch_promote",
      appId: existing.id,
      app: updated,
      addedFields,
      preservedCreatedVia: "scan",
    };
  }

  // INSERT new row with created_via='migrate'.
  const newId = randomUUID();
  const slug = input.remotePath.split("/").filter(Boolean).pop() ?? `app-${newId.slice(0, 8)}`;
  await db.insert(applications).values({
    id: newId,
    serverId: input.serverId,
    name: slug,
    repoUrl: detectedRepoUrl ?? "",
    branch: "main",
    remotePath: input.remotePath,
    composePath,
    domain: input.domain ?? null,
    healthUrl: input.healthUrl ?? null,
    createdVia: "migrate",
    skipInitialClone: detectedRepoUrl !== null,
    createdAt: new Date().toISOString(),
  });

  const [inserted] = await db
    .select()
    .from(applications)
    .where(eq(applications.id, newId))
    .limit(1);
  if (!inserted) {
    return { kind: "target_path_invalid", reason: "ssh_unreachable" };
  }
  await db.insert(auditEntries).values({
    id: randomUUID(),
    userId,
    action: "app.migrated",
    targetType: "application",
    targetId: newId,
    details: JSON.stringify({
      appId: newId,
      serverId: input.serverId,
      remotePath: input.remotePath,
      repoUrl: detectedRepoUrl,
      composePath,
    }),
    result: "success",
    timestamp: new Date().toISOString(),
  });
  if (domainAuditEvent) {
    await db.insert(auditEntries).values({
      id: randomUUID(),
      userId,
      action: domainAuditEvent,
      targetType: "application",
      targetId: newId,
      details: JSON.stringify({
        domain: input.domain,
        conflicts: domainConflictsForAudit,
      }),
      result: "success",
      timestamp: new Date().toISOString(),
    });
  }
  return {
    kind: "insert",
    appId: newId,
    app: inserted,
    detected: { repoUrl: detectedRepoUrl },
  };
}
