/**
 * Feature 008 T013 — client-side domain validator.
 *
 * Byte-for-byte mirror of `server/lib/domain-validator.ts`. Parity asserted
 * by `tests/unit/domain-validator-parity.test.ts` (T014).
 */

export type ValidateResult =
  | { ok: true; value: string }
  | { ok: true; value: null }
  | { ok: false; error: string };

const DOMAIN_REGEX =
  /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

const MAX_TOTAL = 253;
const MAX_LABEL = 63;

export function validateDomain(raw: string | null | undefined): ValidateResult {
  if (raw === null || raw === undefined) return { ok: true, value: null };
  if (typeof raw !== "string") {
    return { ok: false, error: "Domain must be a string" };
  }
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: true, value: null };

  if (trimmed.startsWith("*.")) {
    return {
      ok: false,
      error: "Wildcards (*.) are not supported in v1 — DNS-01 challenge required",
    };
  }
  if (trimmed !== trimmed.toLowerCase()) {
    return { ok: false, error: "Domain must be lowercase" };
  }
  if (trimmed.endsWith(".")) {
    return { ok: false, error: "Domain must not end with a dot" };
  }
  if (trimmed.length > MAX_TOTAL) {
    return { ok: false, error: `Domain exceeds ${MAX_TOTAL} characters` };
  }
  for (const label of trimmed.split(".")) {
    if (label.length === 0) {
      return { ok: false, error: "Empty label (consecutive dots)" };
    }
    if (label.length > MAX_LABEL) {
      return { ok: false, error: `Label exceeds ${MAX_LABEL} characters: ${label}` };
    }
  }
  // Reject IPv4 addresses — they syntactically match the regex but are not domains.
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(trimmed)) {
    return { ok: false, error: "IP addresses are not valid domain names" };
  }
  if (!DOMAIN_REGEX.test(trimmed)) {
    return {
      ok: false,
      error:
        "Domain must be lowercase alphanumeric labels with hyphens (no underscores, no leading/trailing hyphen, must contain at least one dot)",
    };
  }
  return { ok: true, value: trimmed };
}
