/**
 * Phase 3 — write or remove `docker-compose.dashboard.yml` on target via SSH.
 *
 * Called from the deploy route just before `scriptsRunner.runScript`. Writes
 * a labels-bearing override file when the app has a domain + global edge
 * network is configured; otherwise removes any leftover file (cleanup when
 * operator clears the domain in the UI).
 *
 * Pure-ish: reuses sshPool.exec (already pinned + retrying); structured pino
 * logging; never throws on best-effort cleanup. Returns a small status
 * descriptor for the caller to log into the deployment record.
 */

import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { appSettings } from "../db/schema.js";
import { sshPool } from "./ssh-pool.js";
import { shQuote } from "../lib/sh-quote.js";
import { generateCaddyOverride } from "./caddy-override-generator.js";
import { logger } from "../lib/logger.js";

export interface AppShape {
  domain: string | null;
  upstreamService: string | null;
  upstreamPort: number | null;
  remotePath: string;
  name: string;
}

export type OverrideOutcome =
  | { kind: "written"; path: string; edgeNetwork: string }
  | { kind: "removed"; path: string }
  | { kind: "skipped"; reason: string };

const OVERRIDE_FILENAME = "docker-compose.dashboard.yml";

export async function loadEdgeNetwork(): Promise<string | null> {
  const [row] = await db
    .select()
    .from(appSettings)
    .where(eq(appSettings.key, "caddy_edge_network"))
    .limit(1);
  const v = row?.value;
  return v && v !== "" ? v : null;
}

export async function writeOrRemoveOverride(
  serverId: string,
  app: AppShape,
): Promise<OverrideOutcome> {
  const overridePath = `${app.remotePath.replace(/\/+$/, "")}/${OVERRIDE_FILENAME}`;
  const edgeNetwork = await loadEdgeNetwork();

  // Cleanup path — domain was cleared OR edge network not configured.
  if (!app.domain || !edgeNetwork) {
    try {
      await sshPool.exec(serverId, `rm -f ${shQuote(overridePath)}`, 10_000);
      logger.info(
        { ctx: "caddy-override-writer", serverId, app: app.name, path: overridePath },
        "removed override (no domain or no edge network)",
      );
      return { kind: "removed", path: overridePath };
    } catch (err) {
      logger.warn({ ctx: "caddy-override-writer", err, serverId }, "rm failed (best-effort)");
      return { kind: "skipped", reason: "rm failed" };
    }
  }

  if (!app.upstreamService || app.upstreamService === "") {
    return {
      kind: "skipped",
      reason: "upstreamService not set on application — cannot inject labels (operator must specify which compose service receives the domain)",
    };
  }
  if (!app.upstreamPort) {
    return { kind: "skipped", reason: "upstreamPort not set on application" };
  }

  const yaml = generateCaddyOverride({
    serviceName: app.upstreamService,
    domain: app.domain,
    upstreamPort: app.upstreamPort,
    edgeNetwork,
  });

  // Write via heredoc through SSH. Single-quoted heredoc — no shell expansion.
  // mkdir -p covers first-deploy case where remotePath doesn't exist yet
  // (server-deploy.sh creates it later, but we may run before that on a fresh app).
  const cmd = [
    `mkdir -p ${shQuote(app.remotePath)}`,
    `cat > ${shQuote(overridePath)} <<'DASHBOARD_OVERRIDE_EOF'`,
    yaml.trimEnd(),
    `DASHBOARD_OVERRIDE_EOF`,
  ].join("\n");

  try {
    const result = await sshPool.exec(serverId, cmd, 15_000);
    if (result.exitCode !== 0) {
      logger.warn(
        { ctx: "caddy-override-writer", serverId, exit: result.exitCode, stderr: result.stderr.slice(0, 200) },
        "write override returned non-zero",
      );
      return { kind: "skipped", reason: `write failed exit=${result.exitCode}` };
    }
    logger.info(
      { ctx: "caddy-override-writer", serverId, app: app.name, domain: app.domain, edgeNetwork, path: overridePath },
      "override written",
    );
    return { kind: "written", path: overridePath, edgeNetwork };
  } catch (err) {
    logger.error({ ctx: "caddy-override-writer", err, serverId }, "ssh write failed");
    return { kind: "skipped", reason: `ssh exec failed: ${(err as Error).message}` };
  }
}
