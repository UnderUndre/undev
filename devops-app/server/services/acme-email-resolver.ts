/**
 * Feature 008 T018 — pure ACME email resolver (FR-016).
 *
 * Per-app override → global → null. 4-line body per plan.md spec.
 * Caller maps `null → 412 ACME_EMAIL_REQUIRED`.
 */

export function resolveAcmeEmail(
  app: { acmeEmail: string | null },
  settings: { acmeEmail: string | null },
): string | null {
  if (app.acmeEmail !== null && app.acmeEmail !== "") return app.acmeEmail;
  if (settings.acmeEmail !== null && settings.acmeEmail !== "") return settings.acmeEmail;
  return null;
}
