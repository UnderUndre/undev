/**
 * Feature 006 T009 + T053 + T057 — HTTP probe runner.
 *
 * - FR-004: 10s timeout via AbortController.
 * - FR-005: 2xx/3xx → healthy, 4xx/5xx → unhealthy.
 * - FR-029: redirect: "manual" — never follow cross-host.
 * - FR-029a: SSRF block list applied to every probe (DNS-rebinding-resistant).
 * - FR-030: User-Agent: devops-dashboard-probe/1.0.
 * - FR-032: 1 MB body cap (status code is the only signal we need).
 */
import { logger } from "../../lib/logger.js";
import { validateUrlForProbe } from "../../lib/ssrf-guard.js";
import type { AppProbeRow, ProbeOutcome } from "./types.js";

const TIMEOUT_MS = 10_000;
const BODY_CAP_BYTES = 1024 * 1024;
const PROBE_USER_AGENT = "devops-dashboard-probe/1.0";

function res(patch: Partial<ProbeOutcome> & { outcome: ProbeOutcome["outcome"] }): ProbeOutcome {
  return {
    probeType: "http",
    latencyMs: null,
    statusCode: null,
    containerStatus: null,
    errorMessage: null,
    ...patch,
  };
}

async function drainCappedBody(
  body: ReadableStream<Uint8Array> | null,
  controller: AbortController,
): Promise<void> {
  if (body === null) return;
  const reader = body.getReader();
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value) {
        total += value.byteLength;
        if (total >= BODY_CAP_BYTES) {
          // FR-032: status code already captured upstream; abort the stream.
          controller.abort();
          return;
        }
      }
    }
  } catch {
    // Reader cancellation / abort surfaces here; swallow.
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // already released
    }
  }
}

export async function runHttpProbe(app: AppProbeRow): Promise<ProbeOutcome> {
  if (app.healthUrl === null || app.healthUrl === "") {
    return res({
      outcome: "error",
      errorMessage: "no health URL configured",
    });
  }

  // FR-029a — authoritative SSRF gate at probe time.
  const ssrf = await validateUrlForProbe(app.healthUrl);
  if (!ssrf.ok) {
    return res({
      outcome: "error",
      errorMessage:
        ssrf.code === "private_ip"
          ? "URL resolves to private/internal IP, blocked by SSRF policy"
          : ssrf.code === "nxdomain"
            ? "DNS resolution failed (NXDOMAIN)"
            : "invalid URL",
    });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const t0 = Date.now();
  try {
    const resp = await fetch(app.healthUrl, {
      method: "GET",
      redirect: "manual",
      headers: { "User-Agent": PROBE_USER_AGENT },
      signal: controller.signal,
    });
    const latencyMs = Date.now() - t0;
    const code = resp.status;
    // Drain (cap-bounded) to free the socket; status code is what we keep.
    await drainCappedBody(resp.body, controller);
    if (code >= 200 && code < 400) {
      return res({ outcome: "healthy", statusCode: code, latencyMs });
    }
    return res({
      outcome: "unhealthy",
      statusCode: code,
      latencyMs,
      errorMessage: `HTTP ${code}`,
    });
  } catch (err) {
    const latencyMs = Date.now() - t0;
    const name = err instanceof Error ? err.name : "Error";
    const msg = err instanceof Error ? err.message : String(err);
    if (name === "AbortError") {
      return res({
        outcome: "error",
        latencyMs,
        errorMessage: `timeout after ${TIMEOUT_MS / 1000}s`,
      });
    }
    logger.debug({ ctx: "probe-http", appId: app.id, err }, "HTTP probe failed");
    return res({ outcome: "error", latencyMs, errorMessage: msg });
  } finally {
    clearTimeout(timer);
  }
}

export const HTTP_PROBE_USER_AGENT = PROBE_USER_AGENT;
export const HTTP_PROBE_BODY_CAP = BODY_CAP_BYTES;
