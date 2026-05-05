/**
 * Feature 009 — pure state-machine table for the bootstrap chain.
 *
 * Lives in `lib/` (no I/O imports) so unit tests can exercise transitions
 * without dragging in the DB-bound orchestrator. The orchestrator service
 * re-exports `canTransition` for downstream callers.
 */

export type BootstrapState =
  | "init"
  | "cloning"
  | "compose_up"
  | "healthcheck"
  | "proxy_applied"
  | "cert_issued"
  | "active"
  | "failed_clone"
  | "failed_clone_pat_expired"
  | "failed_compose"
  | "failed_healthcheck"
  | "failed_proxy"
  | "failed_cert";

export type BootstrapStep =
  | "cloning"
  | "compose_up"
  | "healthcheck"
  | "proxy_applied"
  | "cert_issued";

export const ALLOWED_TRANSITIONS: Record<BootstrapState, ReadonlyArray<BootstrapState>> = {
  init: ["cloning"],
  cloning: ["compose_up", "failed_clone", "failed_clone_pat_expired"],
  compose_up: ["healthcheck", "failed_compose"],
  healthcheck: ["proxy_applied", "active", "failed_healthcheck"],
  proxy_applied: ["cert_issued", "failed_proxy"],
  cert_issued: ["active", "failed_cert"],
  active: [],
  failed_clone: ["cloning"],
  failed_clone_pat_expired: ["cloning"],
  failed_compose: ["cloning", "compose_up"],
  failed_healthcheck: ["compose_up", "healthcheck"],
  failed_proxy: ["proxy_applied"],
  failed_cert: ["cert_issued"],
};

export function canTransition(from: BootstrapState, to: BootstrapState): boolean {
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}
