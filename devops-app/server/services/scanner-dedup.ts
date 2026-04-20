/**
 * Path normalisation and candidate deduplication against existing applications.
 *
 * normalisePath collapses `//` → `/` and strips trailing `/` (FR-040 guard).
 * Symlinks are deliberately not resolved — that would need an extra SSH round
 * trip per dedup check (see data-model.md).
 */

import type { PartialGitCandidate, PartialComposeCandidate } from "./scanner-parser.js";

export function normalisePath(input: string): string {
  if (!input) return input;
  const collapsed = input.replace(/\/{2,}/g, "/").replace(/\/+$/, "");
  return collapsed === "" ? "/" : collapsed;
}

export interface ExistingApp {
  id: string;
  remotePath: string;
  repoUrl: string;
}

export interface DedupMarkedGit extends PartialGitCandidate {
  alreadyImported: boolean;
  existingApplicationId: string | null;
}

export interface DedupMarkedCompose extends PartialComposeCandidate {
  alreadyImported: boolean;
  existingApplicationId: string | null;
}

function buildLookup(apps: ExistingApp[]): {
  byPath: Map<string, string>;
  byRepoUrl: Map<string, string>;
} {
  const byPath = new Map<string, string>();
  const byRepoUrl = new Map<string, string>();
  for (const app of apps) {
    byPath.set(normalisePath(app.remotePath), app.id);
    if (app.repoUrl) byRepoUrl.set(app.repoUrl, app.id);
  }
  return { byPath, byRepoUrl };
}

export function markGitImported(
  candidates: PartialGitCandidate[],
  apps: ExistingApp[],
): DedupMarkedGit[] {
  const { byPath, byRepoUrl } = buildLookup(apps);
  return candidates.map((c) => {
    const normPath = normalisePath(c.path);
    const idByPath = byPath.get(normPath);
    const idByRepo = c.remoteUrl ? byRepoUrl.get(c.remoteUrl) : undefined;
    const id = idByPath ?? idByRepo ?? null;
    return {
      ...c,
      path: normPath,
      alreadyImported: id !== null,
      existingApplicationId: id,
    };
  });
}

function composeDirectory(primary: string): string {
  const idx = primary.lastIndexOf("/");
  return idx <= 0 ? "/" : primary.slice(0, idx);
}

export function markComposeImported(
  candidates: PartialComposeCandidate[],
  apps: ExistingApp[],
): DedupMarkedCompose[] {
  const { byPath } = buildLookup(apps);
  return candidates.map((c) => {
    const dir = normalisePath(composeDirectory(c.primaryPath));
    const id = byPath.get(dir) ?? null;
    return {
      ...c,
      alreadyImported: id !== null,
      existingApplicationId: id,
    };
  });
}
