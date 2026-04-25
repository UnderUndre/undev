/**
 * Feature 007: pure helper. Builds the SSH-transported command string for
 * `deploy/project-local-deploy` per FR-013.
 *
 * Every value is single-quoted via `shQuote`. Env-var prefix is unconditional
 * (Clarifications Session 2026-04-25 / Gemini-review P1-3) — closes the
 * "interactive script burns 30-min timeout" failure mode for tools that honour
 * NON_INTERACTIVE / DEBIAN_FRONTEND / CI.
 */

import { shQuote } from "../lib/sh-quote.js";

export interface ProjectLocalParams {
  appDir: string;
  scriptPath: string;
  branch: string;
  commit?: string;
  noCache?: boolean;
  skipCleanup?: boolean;
}

export const NON_INTERACTIVE_ENV_PREFIX =
  "NON_INTERACTIVE=1 DEBIAN_FRONTEND=noninteractive CI=true bash";

export function buildProjectLocalCommand(p: ProjectLocalParams): string {
  const parts: string[] = [
    NON_INTERACTIVE_ENV_PREFIX,
    `${shQuote(p.appDir)}/${shQuote(p.scriptPath)}`,
    `--app-dir=${shQuote(p.appDir)}`,
    `--branch=${shQuote(p.branch)}`,
  ];
  if (p.commit) parts.push(`--commit=${shQuote(p.commit)}`);
  if (p.noCache) parts.push("--no-cache");
  if (p.skipCleanup) parts.push("--skip-cleanup");
  return parts.join(" ");
}
