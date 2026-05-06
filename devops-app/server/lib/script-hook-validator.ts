/**
 * Feature 010 T006 — single source of truth for hook field validation.
 *
 * FR-013 + FR-013a layers 1-3:
 *   - Per-field regex (no leading `/`, no `..`, no shell metachars, must end .sh)
 *   - Length cap 256 chars
 *   - NULL normalisation (empty string → null)
 *   - Cross-field mutual exclusion vs `script_path`
 *
 * Layer 4 (DB CHECK) lives in 0011_operational_maturity.sql.
 *
 * Pure function. Returns discriminated union; no `as any`, no
 * `throw new Error()` for operator input — only `ok: false` returns.
 */

export interface HookFields {
  scriptPath: string | null;
  preDeployScriptPath: string | null;
  postDeployScriptPath: string | null;
  onFailScriptPath: string | null;
  preDestroyScriptPath: string | null;
}

export type HookValidationError =
  | { code: "invalid_path"; field: keyof HookFields; reason: string }
  | { code: "script_path_hooks_mutually_exclusive"; setHooks: ReadonlyArray<keyof HookFields> };

export type HookValidationResult =
  | { ok: true; value: HookFields }
  | { ok: false; error: HookValidationError };

/** Reused from feature 007 — see `validate-script-path.ts`. */
const SCRIPT_PATH_REGEX = /^(?!\/)(?!.*\.\.)(?!.*[;|&$()<>{}[\]\\]).*\.sh$/;
const MAX_LEN = 256;

const HOOK_FIELDS: ReadonlyArray<keyof HookFields> = [
  "preDeployScriptPath",
  "postDeployScriptPath",
  "onFailScriptPath",
  "preDestroyScriptPath",
];

function normaliseField(input: unknown): string | null {
  if (input === null || input === undefined) return null;
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (trimmed === "") return null;
  return trimmed;
}

function validateOne(field: keyof HookFields, value: string): HookValidationError | null {
  if (value.length > MAX_LEN) {
    return { code: "invalid_path", field, reason: `≤ ${MAX_LEN} characters` };
  }
  if (!SCRIPT_PATH_REGEX.test(value)) {
    return {
      code: "invalid_path",
      field,
      reason:
        "must end .sh, no leading slash, no `..`, no shell metachars",
    };
  }
  return null;
}

export function validateHookFields(input: Partial<Record<keyof HookFields, unknown>>): HookValidationResult {
  const value: HookFields = {
    scriptPath: normaliseField(input.scriptPath),
    preDeployScriptPath: normaliseField(input.preDeployScriptPath),
    postDeployScriptPath: normaliseField(input.postDeployScriptPath),
    onFailScriptPath: normaliseField(input.onFailScriptPath),
    preDestroyScriptPath: normaliseField(input.preDestroyScriptPath),
  };

  // Per-field regex check.
  for (const f of [...HOOK_FIELDS, "scriptPath" as const]) {
    const v = value[f];
    if (v !== null) {
      const err = validateOne(f, v);
      if (err !== null) return { ok: false, error: err };
    }
  }

  // FR-013a — script_path AND any hook simultaneously is forbidden.
  if (value.scriptPath !== null) {
    const setHooks = HOOK_FIELDS.filter((f) => value[f] !== null);
    if (setHooks.length > 0) {
      return {
        ok: false,
        error: { code: "script_path_hooks_mutually_exclusive", setHooks },
      };
    }
  }

  return { ok: true, value };
}
