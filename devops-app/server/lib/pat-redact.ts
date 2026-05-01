/**
 * Feature 009 FR-015 / FR-017: pino redact paths and helpers for PAT
 * scrubbing across the bootstrap pipeline.
 *
 * Three layers of defence (see plan.md § PAT scrubbing pipeline):
 *
 *   1. Manifest schema marks `pat: z.string().describe("secret")`. Feature
 *      005's `serialiseParams` already routes `secret`-marked fields
 *      through env-var transport; this module exports the redact paths
 *      pino should mask.
 *   2. pino redact paths — extend the existing logger config with
 *      `BOOTSTRAP_REDACT_PATHS` so every log line scrubs PAT fields
 *      before bytes leave the process.
 *   3. `scrubPatFromText` — last-resort pattern scrubber for free-form
 *      stderr capture (git's `Authentication failed for 'https://...'`
 *      message can include the PAT in some old git versions).
 */

export const BOOTSTRAP_REDACT_PATHS: readonly string[] = [
  "req.body.pat",
  "request.body.pat",
  "params.pat",
  "scriptRun.params.pat",
  "auditEntry.details.pat",
  'res.headers["set-cookie"]',
];

const GHP_TOKEN_RE = /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}\b/g;
const URL_EMBEDDED_TOKEN_RE = /https:\/\/oauth2:[^@\s]+@/g;

export class PatRedactionError extends Error {
  override readonly name = "PatRedactionError";
  constructor(public readonly leakedAt: string) {
    super(`PAT pattern leaked past redaction at ${leakedAt}`);
  }
}

export function scrubPatFromText(input: string): string {
  if (typeof input !== "string" || input.length === 0) return input;
  return input
    .replace(URL_EMBEDDED_TOKEN_RE, "https://oauth2:***@")
    .replace(GHP_TOKEN_RE, "***");
}

export function containsPatPattern(input: string): boolean {
  if (typeof input !== "string" || input.length === 0) return false;
  // Reset regex state — the global flags above are stateful when .test()'d.
  return (
    new RegExp(GHP_TOKEN_RE.source).test(input) ||
    new RegExp(URL_EMBEDDED_TOKEN_RE.source).test(input)
  );
}
