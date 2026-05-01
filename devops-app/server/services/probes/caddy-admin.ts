/**
 * Feature 006 T011 — Caddy admin API probe.
 *
 * SSH-tunnels a local ephemeral port → remote 127.0.0.1:2019, GETs /config/.
 * Per-server (NOT per-app — Caddy is shared infra). Tunnel always closed in
 * `finally`. Per FR-006b: HTTP 200 → healthy, otherwise unhealthy.
 */
import { sshPool } from "../ssh-pool.js";
import { logger } from "../../lib/logger.js";
import type { ProbeOutcome, ServerProbeRow } from "./types.js";

const CADDY_REMOTE_PORT = 2019;
const PROBE_TIMEOUT_MS = 5_000;

export async function runCaddyAdminProbe(
  server: ServerProbeRow,
): Promise<ProbeOutcome> {
  const t0 = Date.now();
  let tunnel: { localPort: number; close: () => void } | null = null;
  try {
    tunnel = await sshPool.openTunnel(server.id, {
      remoteHost: "127.0.0.1",
      remotePort: CADDY_REMOTE_PORT,
    });
  } catch (err) {
    logger.debug(
      { ctx: "probe-caddy-admin", serverId: server.id, err },
      "tunnel open failed",
    );
    return {
      outcome: "error",
      probeType: "caddy_admin",
      latencyMs: Date.now() - t0,
      statusCode: null,
      containerStatus: null,
      errorMessage:
        err instanceof Error ? err.message : "tunnel open failed",
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const resp = await fetch(`http://127.0.0.1:${tunnel.localPort}/config/`, {
      method: "GET",
      signal: controller.signal,
      headers: { "User-Agent": "devops-dashboard-probe/1.0" },
    });
    const latencyMs = Date.now() - t0;
    if (resp.status === 200) {
      return {
        outcome: "healthy",
        probeType: "caddy_admin",
        latencyMs,
        statusCode: 200,
        containerStatus: null,
        errorMessage: null,
      };
    }
    return {
      outcome: "unhealthy",
      probeType: "caddy_admin",
      latencyMs,
      statusCode: resp.status,
      containerStatus: null,
      errorMessage: `HTTP ${resp.status}`,
    };
  } catch (err) {
    const name = err instanceof Error ? err.name : "Error";
    const msg = err instanceof Error ? err.message : String(err);
    return {
      outcome: "error",
      probeType: "caddy_admin",
      latencyMs: Date.now() - t0,
      statusCode: null,
      containerStatus: null,
      errorMessage: name === "AbortError" ? "timeout after 5s" : msg,
    };
  } finally {
    clearTimeout(timer);
    tunnel.close();
  }
}
