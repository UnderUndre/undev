/**
 * Feature 008 T031 — PATCH /api/applications/:id/domain.
 *
 * Single-shot domain set/change/clear. Runs:
 *   1. Zod validation + validateDomain
 *   2. Cross-server advisory check (FR-001a)
 *   3. DNS pre-check (T020) — nxdomain blocks, mismatch/cloudflare warns
 *   4. ACME email resolve (T018)
 *   5. Rate-limit guard (T022)
 *   6. Orphan old cert (if any)
 *   7. INSERT new pending cert
 *   8. UPDATE applications.domain
 *   9. Reconcile (T028)
 *   10. (FR-014a) Schedule T+120s DNS recheck if mismatch + tryAnyway
 *   11. Respond 200
 */

import { Router } from "express";
import type { Request } from "express";
import { z } from "zod";
import { and, eq, ne } from "drizzle-orm";
import { db } from "../db/index.js";
import { applications, appCerts, appSettings, servers } from "../db/schema.js";
import { validateBody } from "../middleware/validate.js";
import { validateDomain } from "../lib/domain-validator.js";
import { precheck } from "../services/dns-precheck.js";
import { resolveAcmeEmail } from "../services/acme-email-resolver.js";
import { checkRateLimit } from "../services/rate-limit-guard.js";
import {
  applyTransition,
  createPendingCert,
  getActiveCertForApp,
} from "../services/cert-store.js";
import { reconcile } from "../services/caddy-reconciler.js";
import { scheduleDnsRecheck } from "../services/dns-recheck-scheduler.js";
import { writeOrRemoveOverride } from "../services/caddy-override-writer.js";
import { sshPool } from "../services/ssh-pool.js";
import { shQuote } from "../lib/sh-quote.js";
import { logger } from "../lib/logger.js";

export const domainRouter = Router();

const patchDomainSchema = z
  .object({
    domain: z.union([z.string(), z.null()]).optional(),
    acmeEmail: z.union([z.string().email(), z.null()]).optional(),
    confirmDnsWarning: z.boolean().optional().default(false),
    confirmCrossServer: z.boolean().optional().default(false),
  })
  .strict();

domainRouter.patch(
  "/applications/:id/domain",
  validateBody(patchDomainSchema),
  async (req, res) => {
    const appId = req.params.id as string;
    const userId = (req as Request & { userId?: string }).userId ?? "system";
    const body = req.body as z.infer<typeof patchDomainSchema>;

    // 1. validate domain
    const v = validateDomain(body.domain ?? null);
    if (!v.ok) {
      const code = v.error.toLowerCase().includes("wildcard")
        ? "WILDCARD_NOT_SUPPORTED"
        : "INVALID_DOMAIN";
      res.status(400).json({
        error: { code, message: v.error, details: { fieldErrors: { domain: [v.error] } } },
      });
      return;
    }
    const newDomain: string | null = v.value;

    // 2. load app + server
    const [app] = await db.select().from(applications).where(eq(applications.id, appId)).limit(1);
    if (!app) {
      res.status(404).json({ error: { code: "NOT_FOUND", message: "Application not found" } });
      return;
    }
    const [srv] = await db.select().from(servers).where(eq(servers.id, app.serverId)).limit(1);
    if (!srv) {
      res.status(500).json({ error: { code: "SERVER_NOT_FOUND", message: "Owning server missing" } });
      return;
    }

    // 3. same-server uniqueness — let DB index throw, surface as DOMAIN_IN_USE
    if (newDomain !== null) {
      const conflict = await db
        .select({ id: applications.id, name: applications.name })
        .from(applications)
        .where(
          and(
            eq(applications.serverId, app.serverId),
            eq(applications.domain, newDomain),
            ne(applications.id, appId),
          ),
        );
      if (conflict.length > 0) {
        res.status(409).json({
          error: {
            code: "DOMAIN_IN_USE",
            message: "Domain already used by another app on this server",
            details: {
              conflictingAppId: conflict[0]?.id,
              conflictingAppName: conflict[0]?.name,
            },
          },
        });
        return;
      }

      // 3b. cross-server collision (FR-001a) — advisory
      if (!body.confirmCrossServer) {
        const others = await db
          .select({ appId: applications.id, appName: applications.name, serverId: applications.serverId })
          .from(applications)
          .where(
            and(eq(applications.domain, newDomain), ne(applications.serverId, app.serverId)),
          );
        if (others.length > 0) {
          res.status(409).json({
            error: {
              code: "DOMAIN_CROSS_SERVER",
              message: "Domain already configured on another server",
              details: {
                otherServers: others,
                remediation: "Confirm to proceed if you intentionally want HA / round-robin.",
              },
            },
          });
          return;
        }
      }

      // 4. DNS pre-check
      const dns = await precheck(newDomain, srv.host);
      if (dns.kind === "nxdomain") {
        res.status(400).json({
          error: {
            code: "DNS_NXDOMAIN",
            message: "Domain has no DNS record",
            details: { domain: newDomain, resolvedIps: [] },
          },
        });
        return;
      }
      if ((dns.kind === "mismatch" || dns.kind === "cloudflare") && !body.confirmDnsWarning) {
        res.status(409).json({
          error: {
            code: "DNS_WARNING_REQUIRES_CONFIRM",
            message: "DNS pre-check warning",
            details: {
              kind: dns.kind,
              resolvedIps: dns.resolvedIps,
              serverIp: dns.kind === "mismatch" ? dns.serverIp : null,
              cfRanges: dns.kind === "cloudflare" ? dns.cfRanges : null,
              remediation:
                dns.kind === "cloudflare"
                  ? "Disable Cloudflare orange cloud OR use DNS-01 challenge (v2)."
                  : "If your server is behind a Load Balancer or NAT, this is expected.",
            },
          },
        });
        return;
      }

      // 5. ACME email resolve
      const [globalEmail] = await db
        .select()
        .from(appSettings)
        .where(eq(appSettings.key, "acme_email"))
        .limit(1);
      const effectiveEmail = resolveAcmeEmail(
        { acmeEmail: body.acmeEmail ?? app.acmeEmail ?? null },
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

      // 6. rate-limit guard
      const rl = await checkRateLimit(newDomain);
      if (rl.kind === "block") {
        res.status(429).json({
          error: {
            code: "RATE_LIMIT_BLOCKED",
            message: "Let's Encrypt rate limit: 5 issuances per registered domain per week",
            details: {
              registeredDomain: rl.registered,
              count: rl.count,
              nextSlotEstimate: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
            },
          },
        });
        return;
      }

      // 7. orphan old cert
      const old = await getActiveCertForApp(appId);
      let orphanedCertId: string | null = null;
      if (old !== null && old.domain !== newDomain) {
        await applyTransition(old, { kind: "domain_changed", orphanReason: "domain_change" });
        orphanedCertId = old.id;
      }

      // 8. UPDATE applications.domain + acme_email
      await db
        .update(applications)
        .set({
          domain: newDomain,
          acmeEmail: body.acmeEmail === undefined ? app.acmeEmail : body.acmeEmail,
        })
        .where(eq(applications.id, appId));

      // 9. INSERT new pending cert (idempotent — skip if active+matching exists)
      let newCert = await getActiveCertForApp(appId);
      if (newCert === null || newCert.domain !== newDomain) {
        newCert = await createPendingCert({
          appId,
          domain: newDomain,
          acmeEmail: effectiveEmail,
          actor: userId,
        });
      }

      // 10. reconcile
      void reconcile(app.serverId).catch((err) => {
        logger.error({ ctx: "domain-reconcile", err, serverId: app.serverId }, "post-write reconcile failed");
      });

      // 11. FR-014a — schedule T+120s recheck on mismatch+tryAnyway
      if (dns.kind === "mismatch" && body.confirmDnsWarning) {
        const until = new Date(Date.now() + 120_000).toISOString();
        await db
          .update(appCerts)
          .set({ pendingDnsRecheckUntil: until })
          .where(eq(appCerts.id, newCert.id));
        const certId = newCert.id;
        scheduleDnsRecheck(certId, 120_000, () => {
          void (async () => {
            try {
              const second = await precheck(newDomain, srv.host);
              const fresh = await getActiveCertForApp(appId);
              if (!fresh || fresh.id !== certId) return;
              if (second.kind === "match" || second.kind === "cloudflare") {
                await db
                  .update(appCerts)
                  .set({ pendingDnsRecheckUntil: null })
                  .where(eq(appCerts.id, certId));
                logger.info(
                  { ctx: "dns-precheck-recheck", certId },
                  "DNS confirmed after wait",
                );
              } else {
                await applyTransition(fresh, {
                  kind: "caddy_failed",
                  errorMessage: "DNS still mismatched after 2-minute propagation wait",
                });
              }
            } catch (err) {
              logger.error({ ctx: "dns-precheck-recheck", err, certId }, "recheck failed");
            }
          })();
        });
      }

      res.json({
        applicationId: appId,
        domain: newDomain,
        acmeEmail: body.acmeEmail ?? app.acmeEmail ?? null,
        newCertId: newCert.id,
        orphanedCertId,
        reconcileDispatched: true,
      });
      return;
    }

    // domain = null path (FR-017a)
    const old = await getActiveCertForApp(appId);
    let orphanedCertId: string | null = null;
    if (old !== null) {
      await applyTransition(old, { kind: "domain_changed", orphanReason: "domain_change" });
      orphanedCertId = old.id;
    }
    await db.update(applications).set({ domain: null }).where(eq(applications.id, appId));
    void reconcile(app.serverId).catch((err) => {
      logger.error({ ctx: "domain-reconcile-null", err, serverId: app.serverId }, "reconcile failed");
    });
    res.json({
      applicationId: appId,
      domain: null,
      acmeEmail: app.acmeEmail,
      newCertId: null,
      orphanedCertId,
      reconcileDispatched: true,
    });
  },
);

/**
 * POST /api/applications/:id/promote-tls
 *
 * One-shot "make this app reachable via HTTPS through caddy-docker-proxy".
 * Bootstrap edge case: dashboard up via docker compose without labels →
 * operator sets domain in UI → clicks Promote-to-TLS → labels written +
 * container recreated WITHOUT going through full server-deploy.sh.
 *
 * For self-promote (this dashboard recreating itself) the recreate is
 * detached via setsid+nohup so the API request can flush its response
 * before the container dies.
 */
domainRouter.post("/applications/:id/promote-tls", async (req, res) => {
  const appId = req.params.id as string;
  const [app] = await db.select().from(applications).where(eq(applications.id, appId)).limit(1);
  if (!app) {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "Application not found" } });
    return;
  }
  if (!app.domain || !app.upstreamService || !app.upstreamPort) {
    res.status(412).json({
      error: {
        code: "PROMOTE_REQUIREMENTS_UNMET",
        message: "App needs domain + upstream service + upstream port set before promoting to TLS",
        details: {
          domain: app.domain,
          upstreamService: app.upstreamService,
          upstreamPort: app.upstreamPort,
        },
      },
    });
    return;
  }

  const outcome = await writeOrRemoveOverride(app.serverId, {
    domain: app.domain,
    upstreamService: app.upstreamService,
    upstreamPort: app.upstreamPort,
    remotePath: app.remotePath,
    name: app.name,
  });

  if (outcome.kind !== "written") {
    res.status(500).json({
      error: {
        code: "PROMOTE_OVERRIDE_FAILED",
        message: outcome.kind === "skipped" ? outcome.reason : "Override write failed",
        details: outcome,
      },
    });
    return;
  }

  const recreateCmd =
    `cd ${shQuote(app.remotePath)} && ` +
    `docker compose -f docker-compose.yml -f docker-compose.dashboard.yml up -d --force-recreate --no-deps ${shQuote(app.upstreamService)}`;

  // Self-promote heuristic: recreating dashboard itself would kill the
  // request mid-flight. Detach via setsid+nohup, sleep 3s for response
  // to flush, then run recreate.
  const isSelfPromote =
    app.upstreamService === "dashboard" && /devops-?app/i.test(app.remotePath);

  if (isSelfPromote) {
    const detached = `setsid nohup bash -c ${shQuote(`sleep 3 && ${recreateCmd}`)} >/dev/null 2>&1 &`;
    void sshPool.exec(app.serverId, detached, 5_000).catch((err) => {
      logger.error({ ctx: "promote-tls-self", err }, "detach failed");
    });
    res.json({
      kind: "self-promote-scheduled",
      overridePath: outcome.path,
      edgeNetwork: outcome.edgeNetwork,
      note: "Dashboard recreate scheduled in 3s. This connection will drop briefly.",
    });
    return;
  }

  try {
    const result = await sshPool.exec(app.serverId, recreateCmd, 60_000);
    if (result.exitCode !== 0) {
      res.status(502).json({
        error: {
          code: "RECREATE_FAILED",
          message: `docker compose up returned ${result.exitCode}`,
          details: { stderr: result.stderr.slice(0, 500) },
        },
      });
      return;
    }
    res.json({
      kind: "promoted",
      overridePath: outcome.path,
      edgeNetwork: outcome.edgeNetwork,
      stdout: result.stdout.slice(0, 500),
    });
  } catch (err) {
    res.status(502).json({
      error: { code: "SSH_EXEC_FAILED", message: (err as Error).message },
    });
  }
});
