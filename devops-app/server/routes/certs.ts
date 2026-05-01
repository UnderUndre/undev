/**
 * Feature 008 — cert routes (T032/T033/T054/T058/T067).
 *
 *   POST   /api/applications/:id/certs/issue           — explicit issuance
 *   GET    /api/applications/:id/certs                  — list certs + events
 *   POST   /api/applications/:id/certs/:certId/renew    — force renew (US5)
 *   POST   /api/applications/:id/certs/:certId/revoke   — explicit revoke (hard delete)
 *   DELETE /api/applications/:id/certs/:certId/dns-recheck — cancel DNS recheck wait (FR-014a)
 */

import { Router } from "express";
import type { Request } from "express";
import { z } from "zod";
import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { appCerts, appCertEvents, applications, appSettings } from "../db/schema.js";
import { validateBody } from "../middleware/validate.js";
import { resolveAcmeEmail } from "../services/acme-email-resolver.js";
import { checkRateLimit } from "../services/rate-limit-guard.js";
import {
  applyTransition,
  createPendingCert,
  getActiveCertForApp,
  getCertById,
} from "../services/cert-store.js";
import { reconcile } from "../services/caddy-reconciler.js";
import { caddyAdminClient, CaddyAdminError } from "../services/caddy-admin-client.js";
import { cancelDnsRecheck } from "../services/dns-recheck-scheduler.js";
import { logger } from "../lib/logger.js";

export const certsRouter = Router();

// ── POST /issue ────────────────────────────────────────────────────────────
certsRouter.post("/applications/:id/certs/issue", async (req, res) => {
  const appId = req.params.id as string;
  const userId = (req as Request & { userId?: string }).userId ?? "system";
  const [app] = await db.select().from(applications).where(eq(applications.id, appId)).limit(1);
  if (!app) {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "Application not found" } });
    return;
  }
  if (app.domain === null) {
    res.status(400).json({ error: { code: "NO_DOMAIN_SET", message: "Application has no domain set" } });
    return;
  }
  const existing = await getActiveCertForApp(appId);
  if (existing && existing.domain === app.domain) {
    res.status(409).json({
      error: {
        code: "CERT_ALREADY_EXISTS",
        message: "Cert already exists for this domain",
        details: { certId: existing.id, status: existing.status },
      },
    });
    return;
  }
  const [globalEmail] = await db
    .select()
    .from(appSettings)
    .where(eq(appSettings.key, "acme_email"))
    .limit(1);
  const effectiveEmail = resolveAcmeEmail(
    { acmeEmail: app.acmeEmail ?? null },
    { acmeEmail: globalEmail?.value ?? null },
  );
  if (effectiveEmail === null) {
    res.status(412).json({
      error: {
        code: "ACME_EMAIL_REQUIRED",
        message: "Set ACME email in Settings before issuing certs",
        details: { settingsUrl: "/settings/tls" },
      },
    });
    return;
  }
  const rl = await checkRateLimit(app.domain);
  if (rl.kind === "block") {
    res.status(429).json({
      error: {
        code: "RATE_LIMIT_BLOCKED",
        message: "Let's Encrypt rate limit",
        details: { registeredDomain: rl.registered, count: rl.count },
      },
    });
    return;
  }
  const cert = await createPendingCert({
    appId,
    domain: app.domain,
    acmeEmail: effectiveEmail,
    actor: userId,
  });
  void reconcile(app.serverId).catch((err) => {
    logger.error({ ctx: "certs-issue-reconcile", err }, "reconcile failed");
  });
  res.status(201).json({
    certId: cert.id,
    appId,
    domain: cert.domain,
    status: cert.status,
  });
});

// ── GET / ──────────────────────────────────────────────────────────────────
const listQuerySchema = z.object({
  includeEvents: z.union([z.literal("true"), z.literal("false")]).optional(),
  status: z
    .union([z.string(), z.array(z.string())])
    .optional(),
});

certsRouter.get("/applications/:id/certs", async (req, res) => {
  const appId = req.params.id as string;
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({
      error: { code: "VALIDATION_ERROR", message: "Bad query params" },
    });
    return;
  }
  const includeEvents = parsed.data.includeEvents === "true";
  const statusFilter = Array.isArray(parsed.data.status)
    ? parsed.data.status
    : parsed.data.status !== undefined
      ? [parsed.data.status]
      : null;

  const where = statusFilter
    ? and(eq(appCerts.appId, appId), inArray(appCerts.status, statusFilter))
    : eq(appCerts.appId, appId);

  const certs = await db.select().from(appCerts).where(where).orderBy(desc(appCerts.createdAt));

  if (!includeEvents) {
    res.json({ certs });
    return;
  }

  const ids = certs.map((c) => c.id);
  const events =
    ids.length > 0
      ? await db
          .select()
          .from(appCertEvents)
          .where(inArray(appCertEvents.certId, ids))
          .orderBy(desc(appCertEvents.occurredAt))
      : [];
  const byCert = new Map<string, typeof events>();
  for (const e of events) {
    const arr = byCert.get(e.certId) ?? [];
    if (arr.length < 50) arr.push(e);
    byCert.set(e.certId, arr);
  }
  res.json({
    certs: certs.map((c) => ({ ...c, events: byCert.get(c.id) ?? [] })),
  });
});

// ── POST /:certId/renew ────────────────────────────────────────────────────
certsRouter.post("/applications/:id/certs/:certId/renew", async (req, res) => {
  const userId = (req as Request & { userId?: string }).userId ?? "system";
  const cert = await getCertById(req.params.certId as string);
  if (!cert) {
    res.status(404).json({ error: { code: "CERT_NOT_FOUND", message: "Cert not found" } });
    return;
  }
  if (cert.appId !== (req.params.id as string)) {
    res.status(404).json({ error: { code: "CERT_NOT_FOUND", message: "Cert not on this app" } });
    return;
  }
  if (!["failed", "expired", "rate_limited"].includes(cert.status)) {
    res.status(409).json({
      error: {
        code: "RENEW_NOT_ALLOWED",
        message: "Cert cannot be force-renewed in current state",
        details: { currentStatus: cert.status, allowedStates: ["failed", "expired", "rate_limited"] },
      },
    });
    return;
  }
  if (cert.status === "rate_limited" && cert.retryAfter !== null) {
    const ra = new Date(cert.retryAfter).getTime();
    if (Number.isFinite(ra) && ra > Date.now()) {
      res.status(409).json({
        error: {
          code: "RETRY_AFTER_NOT_ELAPSED",
          message: `Cert is rate-limited until ${cert.retryAfter}`,
          details: { retryAfter: cert.retryAfter },
        },
      });
      return;
    }
  }
  const previous = cert.status;
  const next = await applyTransition(cert, { kind: "force_renew_requested", actor: userId });
  if (next === null) {
    res.status(500).json({ error: { code: "INTERNAL", message: "Cert was deleted unexpectedly" } });
    return;
  }
  const [app] = await db.select().from(applications).where(eq(applications.id, req.params.id as string)).limit(1);
  if (app) {
    // Force-renew is driven by reconcile(): pushing the desired config via
    // POST /load makes Caddy re-attempt issuance for any non-active cert.
    // No separate Caddy admin call needed.
    void reconcile(app.serverId).catch((err) => {
      logger.warn({ ctx: "certs-renew", err, certId: cert.id }, "renew reconcile failed");
    });
  }
  res.json({
    certId: cert.id,
    previousStatus: previous,
    status: next.status,
    reconcileDispatched: true,
  });
});

// ── POST /:certId/revoke ───────────────────────────────────────────────────
const revokeBodySchema = z.object({ confirmName: z.string().optional() }).strict();

certsRouter.post(
  "/applications/:id/certs/:certId/revoke",
  validateBody(revokeBodySchema),
  async (req, res) => {
    const userId = (req as Request & { userId?: string }).userId ?? "system";
    const body = req.body as z.infer<typeof revokeBodySchema>;
    const cert = await getCertById(req.params.certId as string);
    if (!cert) {
      res.status(404).json({ error: { code: "CERT_NOT_FOUND", message: "Cert not found" } });
      return;
    }
    if (cert.appId !== (req.params.id as string)) {
      res.status(404).json({ error: { code: "CERT_NOT_FOUND", message: "Cert not on this app" } });
      return;
    }
    const [app] = await db
      .select()
      .from(applications)
      .where(eq(applications.id, req.params.id as string))
      .limit(1);
    if (!app) {
      res.status(404).json({ error: { code: "NOT_FOUND", message: "App not found" } });
      return;
    }
    if (body.confirmName !== undefined && body.confirmName !== app.name) {
      res.status(400).json({
        error: {
          code: "HARD_DELETE_NAME_MISMATCH",
          message: "Application name does not match confirmation",
          details: { expected: app.name, got: body.confirmName },
        },
      });
      return;
    }
    const previous = cert.status;
    try {
      await caddyAdminClient.revokeCert(app.serverId, cert.domain);
    } catch (err) {
      if (err instanceof CaddyAdminError) {
        res.status(502).json({
          error: {
            code: "CADDY_UNREACHABLE",
            message: "Failed to reach Caddy admin API on target",
            details: { kind: err.kind, cause: err.message },
          },
        });
        return;
      }
      throw err;
    }
    const next = await applyTransition(cert, { kind: "force_revoke", actor: userId });
    if (next === null) {
      res.status(500).json({ error: { code: "INTERNAL", message: "Cert was deleted" } });
      return;
    }
    res.json({
      certId: cert.id,
      previousStatus: previous,
      status: next.status,
      caddyRevokeOutcome: "success",
    });
  },
);

// ── DELETE /:certId/dns-recheck (T067) ─────────────────────────────────────
certsRouter.delete("/applications/:id/certs/:certId/dns-recheck", async (req, res) => {
  const userId = (req as Request & { userId?: string }).userId ?? "system";
  const cert = await getCertById(req.params.certId as string);
  if (!cert) {
    res.status(404).json({ error: { code: "CERT_NOT_FOUND", message: "Cert not found" } });
    return;
  }
  if (cert.appId !== (req.params.id as string)) {
    res.status(404).json({ error: { code: "CERT_NOT_FOUND", message: "Cert not on this app" } });
    return;
  }
  const wasPending = cancelDnsRecheck(cert.id);
  if (cert.status !== "pending" || cert.pendingDnsRecheckUntil === null || !wasPending) {
    res.status(200).json({ ok: true, cancelled: false, reason: "no-active-recheck" });
    return;
  }
  await applyTransition(cert, {
    kind: "caddy_failed",
    errorMessage: "cancelled by operator during DNS revalidation",
  });
  res.status(200).json({ ok: true, cancelled: true, actor: userId });
});
