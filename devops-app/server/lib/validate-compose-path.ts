/**
 * Feature 009 FR-020a: shared server-side validator for compose paths.
 *
 * Mirrors `validate-script-path.ts` (feature 007) but with stricter end-of-
 * path rules — the file MUST end in `.yml` or `.yaml`. Used at three layers
 * per the TOCTOU defence-in-depth pattern:
 *   1. POST /api/applications/bootstrap Zod refinement
 *   2. PATCH /api/applications/:id/bootstrap/config Zod refinement
 *   3. Runner-side re-validation immediately before SSH command construction
 */

export type ValidateComposePathResult =
  | { ok: true; value: string }
  | {
      ok: false;
      code: "unsafe_path" | "wrong_extension" | "too_long";
      message: string;
    };

const PRINTABLE_ASCII_RE = /^[\x20-\x7E]+$/;

export function validateComposePath(input: unknown): ValidateComposePathResult {
  if (typeof input !== "string") {
    return {
      ok: false,
      code: "unsafe_path",
      message: "Compose path must be a string",
    };
  }
  const trimmed = input.trim();
  if (trimmed === "") {
    return {
      ok: false,
      code: "unsafe_path",
      message: "Compose path cannot be empty",
    };
  }
  if (trimmed.length > 256) {
    return {
      ok: false,
      code: "too_long",
      message: "Compose path must be ≤256 characters",
    };
  }
  if (!PRINTABLE_ASCII_RE.test(trimmed)) {
    return {
      ok: false,
      code: "unsafe_path",
      message: "Compose path must be printable ASCII",
    };
  }
  if (trimmed.startsWith("/")) {
    return {
      ok: false,
      code: "unsafe_path",
      message: "Compose path must be relative to the repo root",
    };
  }
  if (trimmed.includes("..")) {
    return {
      ok: false,
      code: "unsafe_path",
      message: "Compose path cannot contain `..`",
    };
  }
  if (trimmed.includes("\\")) {
    return {
      ok: false,
      code: "unsafe_path",
      message: "Compose path cannot contain backslashes",
    };
  }
  if (!trimmed.endsWith(".yml") && !trimmed.endsWith(".yaml")) {
    return {
      ok: false,
      code: "wrong_extension",
      message: "Compose path must end in .yml or .yaml",
    };
  }
  return { ok: true, value: trimmed };
}
