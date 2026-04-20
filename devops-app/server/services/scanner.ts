/**
 * Scanner orchestration: runs the command from scanner-command.ts over SSH,
 * parses the output, matches containers to compose projects, dedups against
 * existing applications, and enforces the per-server concurrency lock
 * (FR-074).
 */

import { sshPool } from "./ssh-pool.js";
import { db } from "../db/index.js";
import { applications, servers } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { logger } from "../lib/logger.js";
import { buildScanCommand } from "./scanner-command.js";
import {
  parseScanOutput,
  type DirtyState,
  type DockerContainer,
} from "./scanner-parser.js";
import {
  markGitImported,
  markComposeImported,
  normalisePath,
} from "./scanner-dedup.js";
import { githubRepoFromUrl } from "./scanner-github.js";

const SCAN_NODE_TIMEOUT_MS = 62_000; // server-side `timeout 60`, Node-side safety margin

export interface GitCandidate {
  path: string;
  remoteUrl: string | null;
  githubRepo: string | null;
  branch: string;
  detached: boolean;
  commitSha: string | null;
  commitSubject: string | null;
  commitDate: string | null;
  dirty: DirtyState;
  suggestedDeployScripts: string[]; // Empty in v1 — not emitted by pipeline yet.
  alreadyImported: boolean;
  existingApplicationId: string | null;
}

export interface DockerCandidate {
  kind: "compose" | "container";
  path: string | null;
  extraComposeFiles: string[];
  name: string;
  services: Array<{ name: string; image: string; running: boolean }>;
  alreadyImported: boolean;
  existingApplicationId: string | null;
}

export interface ScanResult {
  gitCandidates: GitCandidate[];
  dockerCandidates: DockerCandidate[];
  gitAvailable: boolean;
  dockerAvailable: boolean;
  partial: boolean;
  durationMs: number;
}

export class ScanInProgressError extends Error {
  readonly since: Date;
  readonly byUserId: string;
  constructor(since: Date, byUserId: string) {
    super("Another scan is already running on this server");
    this.name = "ScanInProgressError";
    this.since = since;
    this.byUserId = byUserId;
  }
}

interface LockEntry {
  since: Date;
  userId: string;
  abort: () => void;
}

// Module-scoped per-server scan lock (FR-074). Single-instance only.
const locks = new Map<string, LockEntry>();

/** Visible for testing — clears the lock table between tests. */
export function __resetScanLocks(): void {
  for (const [, entry] of locks) entry.abort();
  locks.clear();
}

function composeProjectName(primaryPath: string): string {
  // Default docker-compose project name = parent directory basename.
  const dir = primaryPath.replace(/\/+[^/]+$/, "");
  const base = dir.replace(/^.*\//, "");
  return base || "compose";
}

function containerBelongsTo(
  container: DockerContainer,
  composeName: string,
  serviceNames: Set<string>,
): boolean {
  // docker compose v2 uses `<project>-<service>-<replica>` (dash-separated).
  // Legacy v1 uses `<project>_<service>_<replica>` (underscore).
  const composeLabel = container.labels["com.docker.compose.project"];
  if (composeLabel) return composeLabel === composeName;
  const namePatterns = [
    new RegExp(`^${escapeRegex(composeName)}[-_]([A-Za-z0-9._-]+)[-_]\\d+$`),
  ];
  for (const rx of namePatterns) {
    const m = container.name.match(rx);
    if (m && m[1] && serviceNames.has(m[1])) return true;
  }
  return false;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildDockerCandidates(
  compose: ReturnType<typeof markComposeImported>,
  containers: DockerContainer[],
): DockerCandidate[] {
  const claimed = new Set<string>(); // container names consumed by compose candidates

  const composeCandidates: DockerCandidate[] = compose.map((c) => {
    const name = composeProjectName(c.primaryPath);
    const serviceSet = new Set(c.services.map((s) => s.name));
    const services = c.services.map((svc) => {
      const running = containers.some((ct) => {
        const match = containerBelongsTo(ct, name, serviceSet);
        if (match && ct.state.toLowerCase().startsWith("running")) {
          claimed.add(ct.name);
          return true;
        }
        if (match) claimed.add(ct.name);
        return false;
      });
      return { name: svc.name, image: svc.image, running };
    });
    return {
      kind: "compose" as const,
      path: c.primaryPath,
      extraComposeFiles: c.extraPaths,
      name,
      services,
      alreadyImported: c.alreadyImported,
      existingApplicationId: c.existingApplicationId,
    };
  });

  // Any container not claimed by a compose candidate becomes a standalone.
  const standalone: DockerCandidate[] = containers
    .filter((ct) => !claimed.has(ct.name))
    .map((ct) => ({
      kind: "container" as const,
      path: ct.labels["com.docker.compose.project.working_dir"] ?? null,
      extraComposeFiles: [],
      name: ct.name,
      services: [
        {
          name: ct.name,
          image: ct.image,
          running: ct.state.toLowerCase().startsWith("running"),
        },
      ],
      alreadyImported: false,
      existingApplicationId: null,
    }));

  return [...composeCandidates, ...standalone];
}

export async function scan(
  serverId: string,
  userId: string,
): Promise<ScanResult> {
  if (locks.has(serverId)) {
    const existing = locks.get(serverId)!;
    throw new ScanInProgressError(existing.since, existing.userId);
  }

  const [serverRow] = await db
    .select()
    .from(servers)
    .where(eq(servers.id, serverId));
  if (!serverRow) throw new Error(`Server not found: ${serverId}`);

  const scanRoots = (serverRow.scanRoots ?? []) as string[];
  if (scanRoots.length === 0) {
    throw new Error("Server has no scanRoots configured");
  }

  const command = buildScanCommand(scanRoots);

  const startedAt = Date.now();
  let killed = false;
  let stream: { kill: () => void } | null = null;
  const lockEntry: LockEntry = {
    since: new Date(startedAt),
    userId,
    abort: () => {
      killed = true;
      stream?.kill();
    },
  };
  locks.set(serverId, lockEntry);
  logger.info(
    {
      ctx: "scanner-start",
      serverId,
      userId,
      scanRootsCount: scanRoots.length,
    },
    "Scan started",
  );

  try {
    await sshPool.connect({
      id: serverRow.id,
      host: serverRow.host,
      port: serverRow.port,
      sshUser: serverRow.sshUser,
      sshAuthMethod: (serverRow.sshAuthMethod as "key" | "password") ?? "key",
      sshPrivateKey: serverRow.sshPrivateKey,
      sshPassword: serverRow.sshPassword,
    });
    const handle = await sshPool.execStream(serverId, command);
    stream = handle;

    let stdout = "";
    let stderr = "";

    const output = await new Promise<{ stdout: string; stderr: string; timedOut: boolean }>(
      (resolve, reject) => {
        const timer = setTimeout(() => {
          killed = true;
          handle.kill();
          resolve({ stdout, stderr, timedOut: true });
        }, SCAN_NODE_TIMEOUT_MS);

        handle.stream.on("data", (buf: Buffer) => {
          stdout += buf.toString();
        });
        handle.stream.stderr.on("data", (buf: Buffer) => {
          stderr += buf.toString();
        });
        handle.stream.on("close", () => {
          clearTimeout(timer);
          resolve({ stdout, stderr, timedOut: killed });
        });
        handle.stream.on("error", (err: Error) => {
          clearTimeout(timer);
          reject(err);
        });
      },
    );

    // FR-072 visibility: log start/finish with counts (no paths — may leak
     // project names). Bound to console per house style (see notifier.ts, ssh-pool.ts).
    const parsed = parseScanOutput(output.stdout);

    const existingApps = await db
      .select({
        id: applications.id,
        remotePath: applications.remotePath,
        repoUrl: applications.repoUrl,
      })
      .from(applications)
      .where(eq(applications.serverId, serverId));

    const gitMarked = markGitImported(parsed.git, existingApps);
    const composeMarked = markComposeImported(parsed.compose, existingApps);

    const gitCandidates: GitCandidate[] = gitMarked.map((g) => ({
      path: g.path,
      remoteUrl: g.remoteUrl,
      githubRepo: githubRepoFromUrl(g.remoteUrl),
      branch: g.branch,
      detached: g.detached,
      commitSha: g.commitSha,
      commitSubject: g.commitSubject,
      commitDate: g.commitDate,
      dirty: g.dirty,
      suggestedDeployScripts: [],
      alreadyImported: g.alreadyImported,
      existingApplicationId: g.existingApplicationId,
    }));

    const dockerCandidates = buildDockerCandidates(composeMarked, parsed.containers);

    const result = {
      gitCandidates,
      dockerCandidates,
      gitAvailable: parsed.gitAvailable,
      dockerAvailable: parsed.dockerAvailable,
      partial: output.timedOut,
      durationMs: Date.now() - startedAt,
    };

    logger.info(
      {
        ctx: "scanner-complete",
        serverId,
        durationMs: result.durationMs,
        gitCandidates: result.gitCandidates.length,
        dockerCandidates: result.dockerCandidates.length,
        partial: result.partial,
        gitAvailable: result.gitAvailable,
        dockerAvailable: result.dockerAvailable,
      },
      "Scan complete",
    );
    return result;
  } finally {
    locks.delete(serverId);
  }
}

/** Test/route helper — check if a server currently has an active scan. */
export function getActiveScan(serverId: string): LockEntry | null {
  return locks.get(serverId) ?? null;
}

// Re-export normalisePath so consumers (routes/apps.ts) import from one place.
export { normalisePath } from "./scanner-dedup.js";
