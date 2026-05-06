/**
 * Feature 012 T024 — atomic upstream switcher per research.md R-001.
 *
 * Wraps `CaddyAdminClient` (feature 008). Reads current Caddy config,
 * locates the target app's route by its domain, rewrites the dial address
 * of every `reverse_proxy` upstream to `<service>-<newColor>:<port>`,
 * and POSTs the full config back via `/load` (atomic config replace).
 *
 * Returns a discriminated union: `{ ok: true, switchedAt }` on success
 * or `{ ok: false, reason }` on failure. Never throws — caller handles
 * the failure path explicitly.
 */

import {
  CaddyAdminClient,
  CaddyAdminError,
  type CaddyConfig,
  type CaddyRoute,
  type CaddyHandler,
} from "./caddy-admin-client.js";
import { logger } from "../lib/logger.js";

export type SwitchReason =
  | "caddy_admin_unreachable"
  | "caddy_admin_rejected_config"
  | "domain_route_not_found"
  | "no_reverse_proxy_handler";

export type SwitchResult =
  | { ok: true; switchedAt: string; previousUpstream: string; newUpstream: string }
  | { ok: false; reason: SwitchReason; detail?: string };

export interface SwitchInput {
  serverId: string;
  appDomain: string;
  upstreamService: string;
  upstreamPort: number;
  newColor: "blue" | "green";
}

export class CaddyUpstreamSwitcher {
  constructor(private readonly admin: CaddyAdminClient = new CaddyAdminClient()) {}

  async switchUpstream(input: SwitchInput): Promise<SwitchResult> {
    const newDial = `${input.upstreamService}-${input.newColor}:${input.upstreamPort}`;

    let config: CaddyConfig;
    try {
      config = await this.admin.getConfig(input.serverId);
    } catch (err) {
      const reason: SwitchReason =
        err instanceof CaddyAdminError && err.kind !== "http"
          ? "caddy_admin_unreachable"
          : "caddy_admin_unreachable";
      logger.warn(
        { ctx: "caddy-upstream-switcher", serverId: input.serverId, err },
        "getConfig failed",
      );
      return { ok: false, reason, detail: (err as Error).message };
    }

    const rewriteResult = rewriteUpstream(config, input.appDomain, newDial);
    if (!rewriteResult.ok) {
      return { ok: false, reason: rewriteResult.reason };
    }

    try {
      await this.admin.load(input.serverId, config);
    } catch (err) {
      logger.warn(
        { ctx: "caddy-upstream-switcher", serverId: input.serverId, err },
        "POST /load failed",
      );
      return {
        ok: false,
        reason: "caddy_admin_rejected_config",
        detail: (err as Error).message,
      };
    }

    return {
      ok: true,
      switchedAt: new Date().toISOString(),
      previousUpstream: rewriteResult.previousUpstream,
      newUpstream: newDial,
    };
  }
}

interface RewriteOk {
  ok: true;
  previousUpstream: string;
}
interface RewriteErr {
  ok: false;
  reason: "domain_route_not_found" | "no_reverse_proxy_handler";
}
type RewriteResult = RewriteOk | RewriteErr;

/**
 * Mutates `config` in place: locates the route matching `appDomain` and
 * rewrites every `reverse_proxy.upstreams[].dial` to `newDial`. Returns
 * the previously observed dial value (for audit).
 */
export function rewriteUpstream(
  config: CaddyConfig,
  appDomain: string,
  newDial: string,
): RewriteResult {
  const servers = config.apps?.http?.servers ?? {};
  let foundRoute: CaddyRoute | null = null;
  for (const srv of Object.values(servers)) {
    for (const route of srv.routes ?? []) {
      const hosts = (route.match ?? []).flatMap((m) => m.host ?? []);
      if (hosts.includes(appDomain)) {
        foundRoute = route;
        break;
      }
    }
    if (foundRoute) break;
  }
  if (!foundRoute) {
    return { ok: false, reason: "domain_route_not_found" };
  }
  const proxies = collectReverseProxies(foundRoute.handle ?? []);
  if (proxies.length === 0) {
    return { ok: false, reason: "no_reverse_proxy_handler" };
  }
  const previousUpstream = proxies[0]?.upstreams?.[0]?.dial ?? "";
  for (const p of proxies) {
    p.upstreams = [{ dial: newDial }];
  }
  return { ok: true, previousUpstream };
}

function collectReverseProxies(handlers: CaddyHandler[]): {
  handler: "reverse_proxy";
  upstreams: { dial: string }[];
}[] {
  const out: { handler: "reverse_proxy"; upstreams: { dial: string }[] }[] = [];
  for (const h of handlers) {
    if (h.handler === "reverse_proxy") {
      out.push(h);
    } else if (h.handler === "subroute") {
      for (const r of h.routes) {
        out.push(...collectReverseProxies(r.handle));
      }
    }
  }
  return out;
}

export const caddyUpstreamSwitcher = new CaddyUpstreamSwitcher();
