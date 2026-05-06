/**
 * Feature 010 + 012 — `FAIL_PHASE` env enum.
 *
 * NOTE: feature 010 (operational maturity) declared the on_fail hook env
 * builder but did not centralize the FAIL_PHASE enum into a single file.
 * Feature 012 extends it with 6 blue/green values and creates this file
 * as the single-source-of-truth. Feature 010's `on_fail` hook env builder
 * (currently inline in `scripts-runner.ts` / lifecycle hook code) should
 * import `FAIL_PHASE_ENUM` from here when it next gets refactored.
 */

export const FAIL_PHASE_ENUM = [
  // Feature 005 / 010 base values
  "git_fetch",
  "pre_deploy",
  "compose_up",
  "post_deploy",
  // Feature 012 extension — blue/green phase tokens
  "candidate_starting",
  "candidate_healthcheck",
  "switching",
  "outgoing_draining",
  "outgoing_stopping",
  "caddy_admin_post_switch",
] as const;

export type FailPhase = (typeof FAIL_PHASE_ENUM)[number];

export function isFailPhase(value: string): value is FailPhase {
  return (FAIL_PHASE_ENUM as readonly string[]).includes(value);
}
