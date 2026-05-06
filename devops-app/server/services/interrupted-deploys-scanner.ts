/**
 * Feature 012 T027 — boot-time scan for interrupted blue/green deploys.
 *
 * Per research.md R-006, runs ONCE at server start. Queries
 * `applications WHERE deploy_state IS NOT NULL`; for each row, probes
 * candidate + outgoing container state via `docker inspect` over SSH
 * (parallel with Promise.all). Result cached in-memory; UI fetches via
 * `GET /api/applications/interrupted-deploys`.
 */

import { isNotNull } from "drizzle-orm";
import { db } from "../db/index.js";
import { applications, servers } from "../db/schema.js";
import { sshPool } from "./ssh-pool.js";
import { shQuote } from "../lib/sh-quote.js";
import { logger } from "../lib/logger.js";
import { eq } from "drizzle-orm";

export type CandidateState = "running" | "exited" | "missing" | "unhealthy";
export type OutgoingState = "running" | "exited" | "missing";

export interface InterruptedDeployRow {
  appId: string;
  appName: string;
  serverId: string;
  serverLabel: string;
  lastPhase: string;
  lastPhaseStartedAt: string;
  activeColor: "blue" | "green" | null;
  candidate: {
    name: string;
    state: CandidateState;
    exitCode?: number;
  };
  outgoing: {
    name: string;
    state: OutgoingState;
  };
}

class InterruptedDeploysCache {
  private rows: InterruptedDeployRow[] = [];

  set(rows: InterruptedDeployRow[]): void {
    this.rows = rows;
  }

  get(): ReadonlyArray<InterruptedDeployRow> {
    return this.rows;
  }

  removeForApp(appId: string): void {
    this.rows = this.rows.filter((r) => r.appId !== appId);
  }
}

export const interruptedDeploysCache = new InterruptedDeploysCache();

function oppositeColor(c: "blue" | "green" | null): "blue" | "green" {
  return c === "blue" ? "green" : "blue";
}

async function probeContainerState(
  serverId: string,
  containerName: string,
): Promise<{ state: CandidateState; exitCode?: number }> {
  // docker inspect — single shell-out, format gives state + exit code.
  const cmd = `docker inspect --format '{{.State.Status}}|{{.State.ExitCode}}|{{.State.Health.Status}}' ${shQuote(
    containerName,
  )} 2>/dev/null || echo missing`;
  try {
    const result = await sshPool.exec(serverId, cmd, 10_000);
    const out = result.stdout.trim();
    if (!out || out === "missing") return { state: "missing" };
    const [status, exitCodeStr, healthStatus] = out.split("|");
    if (status === "running") {
      if (healthStatus === "unhealthy") return { state: "unhealthy" };
      return { state: "running" };
    }
    if (status === "exited") {
      const exitCode = exitCodeStr ? Number(exitCodeStr) : undefined;
      return { state: "exited", exitCode };
    }
    return { state: "missing" };
  } catch (err) {
    logger.warn(
      { ctx: "interrupted-deploys-scanner", serverId, containerName, err },
      "probe failed",
    );
    return { state: "missing" };
  }
}

export async function scanAtBoot(): Promise<InterruptedDeployRow[]> {
  const rows = await db
    .select()
    .from(applications)
    .where(isNotNull(applications.deployState));

  if (rows.length === 0) return [];

  const enriched = await Promise.all(
    rows.map(async (row): Promise<InterruptedDeployRow | null> => {
      const [server] = await db
        .select()
        .from(servers)
        .where(eq(servers.id, row.serverId))
        .limit(1);
      const upstreamService = row.upstreamService ?? "app";
      const candidateColor = oppositeColor(row.activeColor as "blue" | "green" | null);
      const outgoingColor: "blue" | "green" =
        row.activeColor === "blue" || row.activeColor === "green"
          ? (row.activeColor as "blue" | "green")
          : "blue";
      const candidateName = `${upstreamService}-${candidateColor}`;
      const outgoingName = `${upstreamService}-${outgoingColor}`;
      const [candidateProbe, outgoingProbe] = await Promise.all([
        probeContainerState(row.serverId, candidateName),
        probeContainerState(row.serverId, outgoingName),
      ]);
      const outgoingState: OutgoingState =
        outgoingProbe.state === "unhealthy" ? "running" : outgoingProbe.state;
      return {
        appId: row.id,
        appName: row.name,
        serverId: row.serverId,
        serverLabel: server?.label ?? row.serverId,
        lastPhase: row.deployState ?? "",
        lastPhaseStartedAt: row.deployStateStartedAt ?? "",
        activeColor: (row.activeColor as "blue" | "green" | null) ?? null,
        candidate: {
          name: candidateName,
          state: candidateProbe.state,
          exitCode: candidateProbe.exitCode,
        },
        outgoing: {
          name: outgoingName,
          state: outgoingState,
        },
      };
    }),
  );

  return enriched.filter((r): r is InterruptedDeployRow => r !== null);
}

/**
 * Wires into server bootstrap (T058). Failures are logged but do NOT
 * block boot.
 */
export async function initInterruptedDeploysCache(): Promise<void> {
  try {
    const rows = await scanAtBoot();
    interruptedDeploysCache.set(rows);
    logger.info(
      { ctx: "interrupted-deploys-scanner", count: rows.length },
      "boot scan complete",
    );
  } catch (err) {
    logger.warn(
      { ctx: "interrupted-deploys-scanner", err },
      "boot scan failed; panel will be empty until manual refresh",
    );
    interruptedDeploysCache.set([]);
  }
}
