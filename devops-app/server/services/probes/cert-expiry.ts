/**
 * Feature 006 T010 — TLS certificate-expiry probe.
 *
 * Native `tls.connect` (R-004; never `openssl s_client`). Reads
 * peerCertificate.valid_to. FR-006a thresholds:
 *   daysLeft > 14   → healthy
 *   daysLeft <  7   → unhealthy
 *   otherwise       → warning
 *
 * `app_certs` table is owned by feature 008. This probe is the periodic
 * observer: it WRITES `expires_at` always on success, and `last_renew_at`
 * only when the new notAfter is strictly later than the previous one
 * (forward-moving expiry = Caddy auto-renewal succeeded).
 *
 * The `app_certs` write is guarded against the table not existing (feature
 * 008 may not have shipped yet) — failure to write is logged but does NOT
 * fail the probe outcome.
 */
import { connect } from "node:tls";
import { logger } from "../../lib/logger.js";
import type { AppProbeRow, ProbeOutcome } from "./types.js";

const HANDSHAKE_TIMEOUT_MS = 15_000;
const WARNING_DAYS = 14;
const UNHEALTHY_DAYS = 7;
const MS_PER_DAY = 86_400_000;

interface PeerCertExpiry {
  validTo: Date;
}

function readCert(host: string): Promise<PeerCertExpiry> {
  return new Promise((resolve, reject) => {
    const socket = connect({
      host,
      port: 443,
      servername: host,
      rejectUnauthorized: false, // we want to read expired/self-signed certs too
    });
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      try {
        socket.end();
      } catch {
        // ignore
      }
      fn();
    };
    socket.once("secureConnect", () => {
      const cert = socket.getPeerCertificate(false);
      if (!cert || !cert.valid_to) {
        settle(() => reject(new Error("cert had no notAfter")));
        return;
      }
      const validTo = new Date(cert.valid_to);
      if (Number.isNaN(validTo.getTime())) {
        settle(() => reject(new Error("invalid notAfter format")));
        return;
      }
      settle(() => resolve({ validTo }));
    });
    socket.once("error", (err: Error) => settle(() => reject(err)));
    socket.setTimeout(HANDSHAKE_TIMEOUT_MS, () => {
      settle(() => reject(new Error("tls handshake timeout")));
    });
  });
}

export interface CertExpiryDeps {
  /** Probe-time hook for persisting cert observations into feature 008's
   *  `app_certs` table. Implementation lives in the poller wiring; the probe
   *  itself is pure compute. Returns silently on failure. */
  recordCertObservation?: (input: {
    appId: string;
    domain: string;
    validTo: Date;
  }) => Promise<void>;
  now?: () => Date;
}

export async function runCertExpiryProbe(
  app: AppProbeRow,
  deps: CertExpiryDeps = {},
): Promise<ProbeOutcome> {
  const now = deps.now ?? (() => new Date());
  const domain = app.domain ?? null;
  if (domain === null || domain === "") {
    return {
      outcome: "error",
      probeType: "cert_expiry",
      latencyMs: null,
      statusCode: null,
      containerStatus: null,
      errorMessage: "no domain configured",
    };
  }

  const t0 = Date.now();
  try {
    const { validTo } = await readCert(domain);
    const latencyMs = Date.now() - t0;
    const daysLeft = (validTo.getTime() - now().getTime()) / MS_PER_DAY;

    // Persist via the deps hook (R-006 — feature 008 owns the table).
    if (deps.recordCertObservation) {
      try {
        await deps.recordCertObservation({ appId: app.id, domain, validTo });
      } catch (err) {
        logger.warn(
          { ctx: "probe-cert-expiry", appId: app.id, err },
          "cert observation persist failed (feature 008 table may be absent)",
        );
      }
    }

    let outcome: ProbeOutcome["outcome"];
    if (daysLeft > WARNING_DAYS) outcome = "healthy";
    else if (daysLeft < UNHEALTHY_DAYS) outcome = "unhealthy";
    else outcome = "warning";
    return {
      outcome,
      probeType: "cert_expiry",
      latencyMs,
      statusCode: null,
      containerStatus: null,
      errorMessage: null,
    };
  } catch (err) {
    return {
      outcome: "error",
      probeType: "cert_expiry",
      latencyMs: Date.now() - t0,
      statusCode: null,
      containerStatus: null,
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }
}

export const CERT_WARNING_DAYS = WARNING_DAYS;
export const CERT_UNHEALTHY_DAYS = UNHEALTHY_DAYS;
