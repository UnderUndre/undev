/**
 * Feature 008 T008 — Caddy admin API client over SSH tunnel (R-001).
 *
 * Per-request fresh tunnel (low call volume — drift cron ≤1 req per 5 min per
 * server). Uses `sshPool.openTunnel` then issues HTTP via Node `http.request`
 * against `127.0.0.1:<localPort>`.
 *
 * Errors normalised to `CaddyAdminError { kind: 'timeout' | 'http' | 'ssh', cause }`.
 */

import http from "node:http";
import { sshPool } from "./ssh-pool.js";
import { logger } from "../lib/logger.js";

const ADMIN_PORT = 2019;
const TIMEOUT_MS = 8_000;

// ── Discriminated-union types for Caddy config ─────────────────────────────
export interface ReverseProxyHandler {
  handler: "reverse_proxy";
  upstreams: { dial: string }[];
}

export interface SubrouteHandler {
  handler: "subroute";
  routes: CaddyRoute[];
}

export type CaddyHandler = ReverseProxyHandler | SubrouteHandler;

export interface CaddyRoute {
  match: { host: string[] }[];
  handle: CaddyHandler[];
  terminal: boolean;
}

export interface HttpServer {
  listen: string[];
  routes: CaddyRoute[];
}

export interface AcmeIssuer {
  module: "acme";
  email: string;
}

export interface TlsAutomationPolicy {
  subjects: string[];
  issuers: AcmeIssuer[];
}

export interface CaddyConfig {
  admin: { listen: string };
  apps: {
    http: { servers: Record<string, HttpServer> };
    tls?: { automation: { policies: TlsAutomationPolicy[] } };
  };
}

export type CaddyAdminErrorKind = "timeout" | "http" | "ssh";

export class CaddyAdminError extends Error {
  readonly kind: CaddyAdminErrorKind;
  readonly status?: number;
  readonly cause: unknown;
  constructor(kind: CaddyAdminErrorKind, message: string, cause: unknown, status?: number) {
    super(message);
    this.name = "CaddyAdminError";
    this.kind = kind;
    this.cause = cause;
    this.status = status;
  }
}

interface TunnelOpener {
  open(serverId: string): Promise<{ localPort: number; close: () => void }>;
}

const defaultTunnelOpener: TunnelOpener = {
  async open(serverId) {
    const t = await sshPool.openTunnel(serverId, {
      remoteHost: "127.0.0.1",
      remotePort: ADMIN_PORT,
    });
    return { localPort: t.localPort, close: t.close };
  },
};

export class CaddyAdminClient {
  constructor(private readonly tunnel: TunnelOpener = defaultTunnelOpener) {}

  async load(serverId: string, config: CaddyConfig): Promise<void> {
    await this.request<void>(serverId, "POST", "/load", config);
  }

  async getConfig(serverId: string): Promise<CaddyConfig> {
    const res = await this.request<unknown>(serverId, "GET", "/config/", null);
    if (typeof res !== "object" || res === null) {
      throw new CaddyAdminError("http", "malformed config", res);
    }
    return res as CaddyConfig;
  }

  async revokeCert(serverId: string, identifier: string): Promise<void> {
    // Caddy 2.7 admin API: POST /pki/ca/local/certificates/<id>/revoke
    // For ACME-issued certs the server-side automation handles the revocation.
    await this.request<void>(
      serverId,
      "POST",
      `/pki/ca/local/certificates/${encodeURIComponent(identifier)}/revoke`,
      null,
    );
  }

  /**
   * Force renew is a no-op at the admin-API level — Caddy's automation app
   * decides when to re-attempt issuance based on its own state. The route
   * handler triggers a fresh `reconcile()` (which calls `load()` with the
   * current desired config) — that is what actually causes Caddy to retry
   * the ACME challenge for any pending/failed cert.
   *
   * Earlier drafts hit `/load/apps/tls/automation/policies` with a
   * `{identifier}` body, which is not a real Caddy admin endpoint
   * (gemini-code-assist review). Removed to avoid a guaranteed 404/4xx.
   *
   * Kept as an explicit method to preserve the public surface of the client;
   * callers can rely on `reconcile()` from `caddy-reconciler` for the actual
   * force-renew behaviour.
   *
   * @deprecated call `reconcile(serverId)` instead.
   */
  async renewCert(_serverId: string, _identifier: string): Promise<void> {
    // intentional no-op — see doc above
  }

  // ── Internals ──────────────────────────────────────────────────────────
  private async request<T>(
    serverId: string,
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    body: unknown,
  ): Promise<T> {
    let tunnel: { localPort: number; close: () => void };
    try {
      tunnel = await this.tunnel.open(serverId);
    } catch (err) {
      throw new CaddyAdminError("ssh", `ssh tunnel failed: ${(err as Error).message}`, err);
    }
    try {
      logger.debug({ ctx: "caddy-admin-client", serverId, method, path }, "request");
      return await this.send<T>(tunnel.localPort, method, path, body);
    } finally {
      tunnel.close();
    }
  }

  private send<T>(
    port: number,
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    body: unknown,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const payload =
        body === null || body === undefined
          ? null
          : Buffer.from(JSON.stringify(body), "utf8");
      const req = http.request(
        {
          host: "127.0.0.1",
          port,
          method,
          path,
          headers:
            payload === null
              ? { Accept: "application/json" }
              : {
                  Accept: "application/json",
                  "Content-Type": "application/json",
                  "Content-Length": String(payload.byteLength),
                },
          timeout: TIMEOUT_MS,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            const status = res.statusCode ?? 0;
            if (status < 200 || status >= 300) {
              reject(
                new CaddyAdminError(
                  "http",
                  `caddy admin HTTP ${status}: ${text.slice(0, 256)}`,
                  text,
                  status,
                ),
              );
              return;
            }
            if (text === "") {
              resolve(undefined as T);
              return;
            }
            try {
              resolve(JSON.parse(text) as T);
            } catch (err) {
              reject(new CaddyAdminError("http", "malformed JSON response", err));
            }
          });
        },
      );
      req.on("timeout", () => {
        req.destroy(new Error("timeout"));
      });
      req.on("error", (err) => {
        if (err.message === "timeout") {
          reject(new CaddyAdminError("timeout", `caddy admin timeout after ${TIMEOUT_MS}ms`, err));
        } else {
          reject(new CaddyAdminError("http", `caddy admin transport: ${err.message}`, err));
        }
      });
      if (payload !== null) req.write(payload);
      req.end();
    });
  }
}

export const caddyAdminClient = new CaddyAdminClient();
