/**
 * Feature 008 T010 — pure DB → Caddy config builder (R-002 / R-012).
 *
 * Inputs: server row (for reference) + applications array. Outputs the full
 * Caddy admin-API config JSON. Pure — no I/O, no logging.
 *
 * Apps with `proxy_type !== 'caddy'` are excluded entirely (FR-011).
 * Apps with `domain === null` are excluded — feature 008 owns no Caddy site
 * for a domain-less app (FR-017a — caller signals removal via reconciler).
 *
 * Phase 5 (T050) extends this to also emit routes for orphaned certs in the
 * 7-day grace window (`orphan_reason='domain_change'`).
 */

import type { CaddyConfig, HttpServer, CaddyRoute } from "./caddy-admin-client.js";

export interface AppForCaddy {
  id: string;
  name: string;
  remotePath: string;
  domain: string | null;
  proxyType: string;
  acmeEmail: string | null;
  upstreamService: string | null;
  upstreamPort: number | null;
}

export interface OrphanGraceCert {
  appId: string;
  domain: string;
  orphanReason: string;
  orphanedAt: string | null;
}

export interface BuilderInput {
  apps: AppForCaddy[];
  globalAcmeEmail: string | null;
  /** Phase 5 T050: orphaned certs still inside the 7d grace window. */
  graceCerts?: OrphanGraceCert[];
  /** Phase 5 T050: now() for the grace-window comparison. */
  now?: Date;
}

export class AcmeEmailRequiredError extends Error {
  readonly domain: string;
  constructor(domain: string) {
    super(`ACME email required to issue cert for ${domain}`);
    this.name = "AcmeEmailRequiredError";
    this.domain = domain;
  }
}

const GRACE_MS = 7 * 24 * 60 * 60 * 1000;

function deriveComposeProject(remotePath: string, name: string): string {
  // Docker Compose v2 default project = basename of remote_path, lowercased,
  // non-alnum stripped. Fall back to app name.
  const base = remotePath.split(/[/\\]/).filter((s) => s !== "").pop() ?? name;
  return base.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function buildCaddyConfig(input: BuilderInput): CaddyConfig {
  const apps = input.apps.filter((a) => a.proxyType === "caddy" && a.domain !== null);
  const now = input.now ?? new Date();

  const routes: CaddyRoute[] = [];
  const policies: { subjects: string[]; email: string }[] = [];

  for (const app of apps) {
    if (app.domain === null) continue;
    const email = app.acmeEmail ?? input.globalAcmeEmail;
    if (email === null) {
      throw new AcmeEmailRequiredError(app.domain);
    }
    const project = deriveComposeProject(app.remotePath, app.name);
    const service = app.upstreamService ?? "app";
    const port = app.upstreamPort ?? 3000;
    const upstream = `${project}-${service}-1:${port}`;
    routes.push({
      match: [{ host: [app.domain] }],
      handle: [{ handler: "reverse_proxy", upstreams: [{ dial: upstream }] }],
      terminal: true,
    });
    policies.push({ subjects: [app.domain], email });
  }

  // Phase 5 T050 — also serve orphaned domains in the 7-day grace window.
  if (input.graceCerts) {
    for (const orph of input.graceCerts) {
      if (orph.orphanReason !== "domain_change") continue;
      if (orph.orphanedAt === null) continue;
      const orphanedAt = new Date(orph.orphanedAt).getTime();
      if (Number.isNaN(orphanedAt)) continue;
      if (now.getTime() - orphanedAt > GRACE_MS) continue;
      const owner = apps.find((a) => a.id === orph.appId);
      if (!owner) continue;
      const project = deriveComposeProject(owner.remotePath, owner.name);
      const service = owner.upstreamService ?? "app";
      const port = owner.upstreamPort ?? 3000;
      const upstream = `${project}-${service}-1:${port}`;
      routes.push({
        match: [{ host: [orph.domain] }],
        handle: [{ handler: "reverse_proxy", upstreams: [{ dial: upstream }] }],
        terminal: true,
      });
      const email = owner.acmeEmail ?? input.globalAcmeEmail;
      if (email !== null) {
        policies.push({ subjects: [orph.domain], email });
      }
    }
  }

  const servers: Record<string, HttpServer> =
    routes.length === 0
      ? {}
      : {
          srv0: {
            listen: [":80", ":443"],
            routes,
          },
        };

  const cfg: CaddyConfig = {
    admin: { listen: "127.0.0.1:2019" },
    apps: {
      http: { servers },
    },
  };

  if (policies.length > 0) {
    cfg.apps.tls = {
      automation: {
        policies: policies.map((p) => ({
          subjects: p.subjects,
          issuers: [{ module: "acme", email: p.email }],
        })),
      },
    };
  }

  return cfg;
}
