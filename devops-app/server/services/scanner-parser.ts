/**
 * Scanner output parser — converts line-tagged stdout from scanner-command.ts
 * into typed partial candidates. The orchestrator (scanner.ts) merges these
 * with the running-containers list and performs dedup.
 */

import { z } from "zod";

export type DirtyState = "clean" | "dirty" | "unknown";

export interface PartialGitCandidate {
  path: string;
  branch: string;
  detached: boolean;
  commitSha: string | null;
  commitSubject: string | null;
  commitDate: string | null;
  remoteUrl: string | null;
  dirty: DirtyState;
}

export interface PartialComposeCandidate {
  primaryPath: string;
  extraPaths: string[];
  services: Array<{ name: string; image: string }>;
}

export interface DockerContainer {
  name: string;
  image: string;
  state: string; // "running" / "exited" / etc.
  labels: Record<string, string>;
}

export interface ParsedScan {
  gitAvailable: boolean;
  dockerAvailable: boolean;
  git: PartialGitCandidate[];
  compose: PartialComposeCandidate[];
  containers: DockerContainer[];
}

// Docker ps --format '{{json .}}' shape (loose — we only read a few fields).
const DockerPsRow = z
  .object({
    Names: z.string().default(""),
    Image: z.string().default(""),
    State: z.string().default(""),
    Status: z.string().default(""),
    Labels: z.string().default(""),
  })
  .passthrough();

// docker compose config --format json — services section.
const ComposeConfig = z
  .object({
    services: z
      .record(z.string(), z.object({ image: z.string().optional() }).passthrough())
      .optional()
      .default({}),
  })
  .passthrough();

function parseDockerLabels(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  for (const pair of raw.split(",")) {
    const eq = pair.indexOf("=");
    if (eq > 0) out[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return out;
}

function decodeBase64(value: string): string | null {
  try {
    return Buffer.from(value, "base64").toString("utf8");
  } catch {
    return null;
  }
}

export function parseScanOutput(stdout: string): ParsedScan {
  const byPath = new Map<string, PartialGitCandidate>();
  const composeByPrimary = new Map<string, PartialComposeCandidate>();
  const containers: DockerContainer[] = [];
  // FR-021: tri-state tracking. A git candidate is "clean" by default once we
  // have seen any successful field for it; "unknown" sticks when we saw a
  // GIT_ERROR for `status`; "dirty" wins on GIT_DIRTY.
  const statusErrored = new Set<string>();

  let gitAvailable = false;
  let dockerAvailable = false;

  const lines = stdout.split(/\r?\n/);
  for (const raw of lines) {
    if (!raw) continue;
    const parts = raw.split("\t");
    const tag = parts[0];

    switch (tag) {
      case "TOOL": {
        const [, tool, status] = parts;
        if (tool === "git") gitAvailable = status === "yes";
        if (tool === "docker") dockerAvailable = status === "yes";
        break;
      }

      case "GIT_BRANCH": {
        const [, path, value] = parts;
        if (!path || !value) break;
        const c = ensureCandidate(byPath, path);
        if (value === "DETACHED") {
          c.detached = true;
          c.branch = "";
        } else {
          c.branch = value;
        }
        break;
      }

      case "GIT_SHA": {
        const [, path, sha] = parts;
        if (!path || !sha) break;
        ensureCandidate(byPath, path).commitSha = sha;
        break;
      }

      case "GIT_REMOTE": {
        const [, path, url] = parts;
        if (!path || !url) break;
        ensureCandidate(byPath, path).remoteUrl = url;
        break;
      }

      case "GIT_DIRTY": {
        const [, path] = parts;
        if (!path) break;
        ensureCandidate(byPath, path).dirty = "dirty";
        break;
      }

      case "GIT_ERROR": {
        const [, path, field] = parts;
        if (!path) break;
        const c = ensureCandidate(byPath, path);
        if (field === "status") {
          c.dirty = "unknown";
          statusErrored.add(path);
        }
        break;
      }

      case "GIT_HEAD": {
        // Format: "<iso-date>\t<subject>" but since the outer line is already
        // tab-split, the subject is parts[3] onward joined back together.
        const path = parts[1];
        const date = parts[2];
        const subject = parts.slice(3).join("\t");
        if (!path) break;
        const c = ensureCandidate(byPath, path);
        if (date) c.commitDate = date;
        if (subject) c.commitSubject = subject;
        break;
      }

      case "COMPOSE": {
        const [, primary, extrasCsv] = parts;
        if (!primary) break;
        const extras = extrasCsv ? extrasCsv.split(",").filter(Boolean) : [];
        composeByPrimary.set(primary, {
          primaryPath: primary,
          extraPaths: extras,
          services: [],
        });
        break;
      }

      case "COMPOSE_CONFIG": {
        const [, primary, b64] = parts;
        if (!primary || !b64) break;
        const json = decodeBase64(b64);
        if (!json) break;
        let parsed: unknown;
        try {
          parsed = JSON.parse(json);
        } catch {
          break;
        }
        const result = ComposeConfig.safeParse(parsed);
        if (!result.success) break;
        const target = composeByPrimary.get(primary);
        if (!target) break;
        target.services = Object.entries(result.data.services ?? {}).map(
          ([name, def]) => ({ name, image: def.image ?? "" }),
        );
        break;
      }

      case "CONTAINER": {
        // Tab-separated: CONTAINER\t<json>. The JSON may itself contain tabs,
        // though docker ps output is clean in practice. Rejoin to be safe.
        const json = parts.slice(1).join("\t");
        if (!json) break;
        try {
          const parsed = DockerPsRow.parse(JSON.parse(json));
          containers.push({
            name: parsed.Names,
            image: parsed.Image,
            state: parsed.State || parsed.Status.split(" ")[0] || "unknown",
            labels: parseDockerLabels(parsed.Labels),
          });
        } catch {
          // malformed line — skip silently
        }
        break;
      }

      default:
        // Unknown tag or non-tagged line (stderr bleed) — ignore.
        break;
    }
  }

  // Normalise dirty: candidates without a GIT_DIRTY line and without a status
  // error are "clean". Candidates whose status command errored remain "unknown".
  for (const [path, c] of byPath) {
    if (c.dirty === "unknown" && !statusErrored.has(path)) {
      c.dirty = "clean";
    }
  }

  return {
    gitAvailable,
    dockerAvailable,
    git: Array.from(byPath.values()),
    compose: Array.from(composeByPrimary.values()),
    containers,
  };
}

function ensureCandidate(
  map: Map<string, PartialGitCandidate>,
  path: string,
): PartialGitCandidate {
  let c = map.get(path);
  if (!c) {
    c = {
      path,
      branch: "",
      detached: false,
      commitSha: null,
      commitSubject: null,
      commitDate: null,
      remoteUrl: null,
      // Start as "unknown" — flipped to "clean" at end if no error/dirty was seen.
      dirty: "unknown",
    };
    map.set(path, c);
  }
  return c;
}
