/**
 * Feature 010 T034 — shared cross-server domain typed-confirm logic.
 *
 * Used by 3 routes:
 *   - POST /api/applications/:id/domain (T066, feature 008 endpoint)
 *   - POST /api/applications/migrate     (T051, this feature)
 *   - POST /api/applications/bootstrap   (T067, feature 009 endpoint)
 *
 * Per Session 2026-05-05 GE-5: emits the `app.cross_server_domain_confirmed`
 * audit event ONLY when conflicts are ACTUALLY found at write time. No
 * false-positive audits when conflicts resolved between dialog and submit.
 */

import {
  findCrossServerConflicts,
  type DomainConflict,
} from "../services/cross-server-domain-check.js";

export type DomainAttachValidationResult =
  | { ok: true; conflicts: ReadonlyArray<DomainConflict>; auditEvent: "app.cross_server_domain_confirmed" | null }
  | { ok: false; error: "domain_confirmation_required"; conflicts: ReadonlyArray<DomainConflict> };

/**
 * Server re-checks conflicts at write time and decides whether the
 * operator's `typedConfirmation` is sufficient.
 *
 *   - No conflicts → ok, no audit event.
 *   - Conflicts + matching confirmation → ok, audit event.
 *   - Conflicts + missing/mismatched confirmation → 400-equivalent.
 */
export async function validateDomainAttach(
  domain: string,
  excludeAppId: string,
  typedConfirmation: string | null,
): Promise<DomainAttachValidationResult> {
  const conflicts = await findCrossServerConflicts(domain, excludeAppId);
  if (conflicts.length === 0) {
    return { ok: true, conflicts: [], auditEvent: null };
  }
  if (typedConfirmation === null || typedConfirmation !== domain) {
    return { ok: false, error: "domain_confirmation_required", conflicts };
  }
  return { ok: true, conflicts, auditEvent: "app.cross_server_domain_confirmed" };
}
