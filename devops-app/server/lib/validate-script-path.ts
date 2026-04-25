/**
 * Feature 007: shared server-side validator for `applications.scriptPath`.
 *
 * Single source of truth for FR-003 (path safety). Mirrors
 * `client/lib/validate-script-path.ts` byte-for-byte; parity test
 * `tests/unit/validate-script-path-parity.test.ts` enforces drift detection.
 *
 * Input is STRICT (`string | null | undefined`) per Clarifications Session
 * 2026-04-24 (GPT review). The route schema's `z.union([z.string(), z.null()])
 * .optional()` rejects non-string non-null non-absent values BEFORE this
 * validator sees them. No `unknown`, no coercion.
 */

export type ValidateResult =
  | { ok: true; value: null }
  | { ok: true; value: string }
  | { ok: false; error: string };

const PRINTABLE_ASCII_RE = /^[\x20-\x7E]+$/;
const FORBIDDEN_CHARS = new Set([
  " ",
  "\\",
  ";",
  "|",
  "&",
  "$",
  "(",
  ")",
  "`",
  "<",
  ">",
  '"',
  "'",
]);

export function validateScriptPath(
  raw: string | null | undefined,
): ValidateResult {
  // Rule 1: null/undefined → normalised null
  if (raw === null || raw === undefined) return { ok: true, value: null };

  // Rule 2: trim, empty → normalised null
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: true, value: null };

  // Rule 3: length cap (chars == bytes after rule 4 enforces ASCII)
  if (trimmed.length > 256) {
    return { ok: false, error: "Path must be ≤256 characters" };
  }

  // Rule 4: printable-ASCII only — non-ASCII fails before metachar rule fires
  if (!PRINTABLE_ASCII_RE.test(trimmed)) {
    return { ok: false, error: "Path must be printable ASCII" };
  }

  // Rule 5: must be relative
  if (trimmed.startsWith("/")) {
    return { ok: false, error: "Must be a relative path inside the repo" };
  }

  // Rule 6: no parent-directory traversal
  const segments = trimmed.split("/");
  if (segments.includes("..")) {
    return {
      ok: false,
      error: "Path cannot contain parent-directory traversal",
    };
  }

  // Rule 7: forbidden characters (shell metachars + space + backslash)
  for (const ch of trimmed) {
    if (FORBIDDEN_CHARS.has(ch)) {
      return {
        ok: false,
        error: "Path contains characters that are not allowed",
      };
    }
  }

  return { ok: true, value: trimmed };
}
