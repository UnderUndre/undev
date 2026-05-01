/**
 * Feature 008 — cert persistence + WS event helper.
 *
 * Centralises the "write a cert lifecycle transition + emit ws event" pattern
 * used by routes/domain.ts, routes/certs.ts, and the reconciler.
 */

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { appCerts, appCertEvents, applications } from "../db/schema.js";
import {
  transition,
  type AppCert,
  type CertEvent,
} from "./cert-lifecycle.js";
import { channelManager } from "../ws/channels.js";
import { logger } from "../lib/logger.js";

export async function getCertById(certId: string): Promise<AppCert | null> {
  const [row] = await db.select().from(appCerts).where(eq(appCerts.id, certId)).limit(1);
  if (!row) return null;
  return rowToCert(row);
}

export async function getActiveCertForApp(appId: string): Promise<AppCert | null> {
  const rows = await db.select().from(appCerts).where(eq(appCerts.appId, appId));
  // Most recent non-orphaned cert wins.
  const live = rows.filter((r) => r.status !== "orphaned" && r.status !== "revoked");
  if (live.length === 0) return null;
  live.sort((a, b) => (b.createdAt < a.createdAt ? -1 : 1));
  const first = live[0];
  if (!first) return null;
  return rowToCert(first);
}

export async function listCertsForApp(appId: string): Promise<AppCert[]> {
  const rows = await db.select().from(appCerts).where(eq(appCerts.appId, appId));
  return rows.map(rowToCert);
}

export interface CreatePendingArgs {
  appId: string;
  domain: string;
  acmeEmail: string;
  actor: string;
}

export async function createPendingCert(args: CreatePendingArgs): Promise<AppCert> {
  const id = randomUUID();
  const now = new Date().toISOString();
  const row = {
    id,
    appId: args.appId,
    domain: args.domain,
    issuer: "letsencrypt",
    status: "pending" as const,
    issuedAt: null,
    expiresAt: null,
    lastRenewAt: null,
    lastRenewOutcome: null,
    errorMessage: null,
    retryAfter: null,
    orphanedAt: null,
    orphanReason: "",
    acmeAccountEmail: args.acmeEmail,
    pendingDnsRecheckUntil: null,
    createdAt: now,
  };
  await db.insert(appCerts).values(row);
  await db.insert(appCertEvents).values({
    id: randomUUID(),
    certId: id,
    eventType: "force_renew_requested",
    eventData: { issuanceTrigger: true },
    actor: args.actor,
    occurredAt: now,
  });
  const cert = rowToCert(row);
  emitCertStateChanged({ cert, previousStatus: null, actor: args.actor });
  return cert;
}

export async function applyTransition(
  cert: AppCert,
  event: CertEvent,
): Promise<AppCert | null> {
  const result = transition(cert, event);
  const previousStatus = cert.status;
  if (result.next === "delete") {
    await db.delete(appCerts).where(eq(appCerts.id, cert.id));
    await db.insert(appCertEvents).values({
      id: randomUUID(),
      certId: cert.id,
      eventType: result.eventToWrite.eventType,
      eventData: result.eventToWrite.eventData ?? null,
      actor: result.eventToWrite.actor,
      occurredAt: new Date().toISOString(),
    });
    return null;
  }
  await db
    .update(appCerts)
    .set({
      status: result.next.status,
      issuedAt: result.next.issuedAt,
      expiresAt: result.next.expiresAt,
      lastRenewAt: result.next.lastRenewAt,
      lastRenewOutcome: result.next.lastRenewOutcome,
      errorMessage: result.next.errorMessage,
      retryAfter: result.next.retryAfter,
      orphanedAt: result.next.orphanedAt,
      orphanReason: result.next.orphanReason,
      acmeAccountEmail: result.next.acmeAccountEmail,
      pendingDnsRecheckUntil: result.next.pendingDnsRecheckUntil,
    })
    .where(eq(appCerts.id, cert.id));
  await db.insert(appCertEvents).values({
    id: randomUUID(),
    certId: cert.id,
    eventType: result.eventToWrite.eventType,
    eventData: result.eventToWrite.eventData ?? null,
    actor: result.eventToWrite.actor,
    occurredAt: new Date().toISOString(),
  });
  emitCertStateChanged({
    cert: result.next,
    previousStatus,
    actor: result.eventToWrite.actor,
  });
  return result.next;
}

interface EmitArgs {
  cert: AppCert;
  previousStatus: string | null;
  actor: string;
}

export function emitCertStateChanged(args: EmitArgs): void {
  try {
    channelManager.broadcast(`app:${args.cert.appId}`, {
      type: "cert.state-changed",
      data: {
        certId: args.cert.id,
        appId: args.cert.appId,
        domain: args.cert.domain,
        previousStatus: args.previousStatus,
        status: args.cert.status,
        expiresAt: args.cert.expiresAt,
        errorMessage: args.cert.errorMessage,
        actor: args.actor,
        occurredAt: new Date().toISOString(),
      },
    });
  } catch (err) {
    logger.warn({ ctx: "cert-store-ws", err }, "WS broadcast failed");
  }
}

function rowToCert(row: typeof appCerts.$inferSelect): AppCert {
  return {
    id: row.id,
    appId: row.appId,
    domain: row.domain,
    status: row.status as AppCert["status"],
    issuer: row.issuer,
    issuedAt: row.issuedAt,
    expiresAt: row.expiresAt,
    lastRenewAt: row.lastRenewAt,
    lastRenewOutcome: (row.lastRenewOutcome ?? null) as AppCert["lastRenewOutcome"],
    errorMessage: row.errorMessage,
    retryAfter: row.retryAfter,
    orphanedAt: row.orphanedAt,
    orphanReason: row.orphanReason as AppCert["orphanReason"],
    acmeAccountEmail: row.acmeAccountEmail,
    pendingDnsRecheckUntil: row.pendingDnsRecheckUntil,
    createdAt: row.createdAt,
  };
}

export { rowToCert };

/** Test helper: get application by id (used by route tests). */
export async function getApplicationById(appId: string): Promise<typeof applications.$inferSelect | null> {
  const [row] = await db.select().from(applications).where(eq(applications.id, appId)).limit(1);
  return row ?? null;
}
