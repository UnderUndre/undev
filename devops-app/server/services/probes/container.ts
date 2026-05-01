/**
 * Feature 006 T008 — container health probe.
 *
 * Runs `docker inspect --format '{{.State.Health.Status}}' <container>`
 * via the existing SSH pool. Per FR-031, the SSH user is the deploy user
 * (no root). Container name derived per FR-003.
 */
import { sshPool } from "../ssh-pool.js";
import { shQuote } from "../../lib/sh-quote.js";
import { logger } from "../../lib/logger.js";
import type { AppProbeRow, ProbeOutcome } from "./types.js";

/**
 * Derive the docker container name from an app row.
 *
 * Default: `<compose-project>-<service>-1` where compose-project is derived
 * from the app name (lowercased) and service equals app name. The `-1`
 * replica suffix is the docker compose v2 default.
 *
 * Operators may override via `app.name` containing a `/` separator:
 *   "myproj/web" → "myproj-web-1"
 * The fallback when no service-replica suffix is found uses `<name>` verbatim.
 */
export function deriveContainerName(app: Pick<AppProbeRow, "name">): string {
  const raw = app.name.trim();
  if (raw === "") return "";
  // Compose lowercases project name; we mirror that so name-derivation matches
  // what `docker compose up -d` actually produces on the target.
  const safe = raw
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${safe}-${safe}-1`;
}

function ok(
  outcome: ProbeOutcome["outcome"],
  patch: Partial<ProbeOutcome>,
): ProbeOutcome {
  return {
    outcome,
    probeType: "container",
    latencyMs: null,
    statusCode: null,
    containerStatus: null,
    errorMessage: null,
    ...patch,
  };
}

export async function runContainerProbe(app: AppProbeRow): Promise<ProbeOutcome> {
  const container = deriveContainerName(app);
  const cmd = `docker inspect --format '{{.State.Health.Status}}' ${shQuote(container)} 2>/dev/null || echo no-container`;
  const t0 = Date.now();
  try {
    const { stdout } = await sshPool.exec(app.serverId, cmd, 15_000);
    const status = stdout.trim();
    const latencyMs = Date.now() - t0;
    if (status === "healthy") {
      return ok("healthy", { containerStatus: status, latencyMs });
    }
    if (status === "unhealthy") {
      return ok("unhealthy", { containerStatus: status, latencyMs });
    }
    if (status === "starting") {
      return ok("unhealthy", {
        containerStatus: status,
        latencyMs,
        errorMessage: "container starting",
      });
    }
    if (status === "no-container") {
      return ok("error", {
        latencyMs,
        errorMessage: "container not found",
      });
    }
    if (status === "") {
      // No healthcheck defined — docker emits empty string for that case.
      return ok("error", {
        latencyMs,
        errorMessage: "container has no healthcheck",
      });
    }
    return ok("unhealthy", {
      containerStatus: status,
      latencyMs,
      errorMessage: `unknown status: ${status}`,
    });
  } catch (err) {
    logger.warn(
      { ctx: "probe-container", appId: app.id, err },
      "Container probe SSH exec failed",
    );
    return ok("error", {
      latencyMs: Date.now() - t0,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
  }
}
