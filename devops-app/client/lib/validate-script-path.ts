/**
 * Feature 007: shared client-side validator for `applications.scriptPath`.
 *
 * Mirrors `server/lib/validate-script-path.ts` byte-for-byte. Parity test
 * `tests/unit/validate-script-path-parity.test.ts` enforces drift detection.
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
  if (raw === null || raw === undefined) return { ok: true, value: null };

  const trimmed = raw.trim();
  if (trimmed === "") return { ok: true, value: null };

  if (trimmed.length > 256) {
    return { ok: false, error: "Path must be ≤256 characters" };
  }

  if (!PRINTABLE_ASCII_RE.test(trimmed)) {
    return { ok: false, error: "Path must be printable ASCII" };
  }

  if (trimmed.startsWith("/")) {
    return { ok: false, error: "Must be a relative path inside the repo" };
  }

  const segments = trimmed.split("/");
  if (segments.includes("..")) {
    return {
      ok: false,
      error: "Path cannot contain parent-directory traversal",
    };
  }

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
