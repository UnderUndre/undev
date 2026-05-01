/**
 * Feature 009 FR-016a: classify git-clone stderr into actionable PAT-error
 * categories. Pure function — no I/O, no logging.
 *
 * Patterns derived from observed `git clone` over HTTPS failure modes:
 *
 *   401 → `fatal: Authentication failed for 'https://github.com/...'`
 *         (PAT expired/revoked or scope insufficient — same surface)
 *   403 → `remote: Permission to <owner>/<repo>.git denied to <user>.`
 *         (PAT scope OK on read but write denied — for our clone-only flow
 *         this means scope mismatch on private repo)
 *   SSO → `remote: Repository not found.` + telltale SSO redirect string,
 *         OR the org-SSO challenge embeds "single sign-on" / "SSO" keyword.
 *
 * Everything else falls through to `other` — the route layer surfaces the
 * raw stderr in that case.
 */

export type PatErrorKind =
  | "pat_expired"
  | "sso_required"
  | "permission_denied"
  | "other";

export interface PatErrorInput {
  stderr: string;
  exitCode: number;
}

export interface PatErrorClassification {
  kind: PatErrorKind;
  message: string;
}

const SSO_RE = /single[- ]sign[- ]on|\bSSO\b/i;
const AUTH_FAILED_RE =
  /fatal:\s*Authentication failed for ['"]?https:\/\/github\.com/i;
const PERMISSION_DENIED_RE =
  /remote:\s*Permission to .+? denied to /i;

export function classifyPatError(
  input: PatErrorInput,
): PatErrorClassification {
  const stderr = typeof input.stderr === "string" ? input.stderr : "";

  if (SSO_RE.test(stderr)) {
    return {
      kind: "sso_required",
      message:
        "GitHub organization requires SSO authorization for this PAT. Reauthorize the PAT for the org and retry.",
    };
  }
  if (AUTH_FAILED_RE.test(stderr)) {
    return {
      kind: "pat_expired",
      message:
        "GitHub authentication failed. The connection's PAT may be expired, revoked, or have changed scopes.",
    };
  }
  if (PERMISSION_DENIED_RE.test(stderr)) {
    return {
      kind: "permission_denied",
      message:
        "GitHub denied access to the repository. The PAT likely lacks the `repo` scope for this private repository.",
    };
  }
  return {
    kind: "other",
    message: stderr.trim() || `git clone failed (exit ${input.exitCode})`,
  };
}
