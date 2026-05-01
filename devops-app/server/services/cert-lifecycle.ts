/**
 * Feature 008 T024 — pure cert-lifecycle state machine (plan.md §Cert lifecycle).
 *
 * `transition(cert, event)` returns the next-state cert plus the event row
 * to append. Side effects (Caddy calls, file deletion) are performed by the
 * caller — this module is pure.
 */

export type CertStatus =
  | "pending"
  | "active"
  | "expired"
  | "revoked"
  | "rate_limited"
  | "failed"
  | "orphaned"
  | "pending_reconcile";

export type OrphanReason = "" | "domain_change" | "app_soft_delete" | "manual_orphan";

export interface AppCert {
  id: string;
  appId: string;
  domain: string;
  status: CertStatus;
  issuer: string;
  issuedAt: string | null;
  expiresAt: string | null;
  lastRenewAt: string | null;
  lastRenewOutcome: "success" | "failure" | null;
  errorMessage: string | null;
  retryAfter: string | null;
  orphanedAt: string | null;
  orphanReason: OrphanReason;
  acmeAccountEmail: string | null;
  pendingDnsRecheckUntil: string | null;
  createdAt: string;
}

export type CertEvent =
  | { kind: "issue_requested"; actor: string }
  | { kind: "caddy_active"; issuedAt: string; expiresAt: string; acmeEmail: string }
  | { kind: "caddy_failed"; errorMessage: string }
  | { kind: "acme_rate_limit"; retryAfter: string }
  | { kind: "expiry_probe_passed"; expiresAt: string; lastRenewAt: string }
  | { kind: "expires_at_in_past" }
  | { kind: "domain_changed"; orphanReason: "domain_change" }
  | { kind: "app_soft_deleted" }
  | { kind: "force_revoke"; actor: string }
  | { kind: "force_renew_requested"; actor: string }
  | { kind: "retention_window_elapsed" };

export interface AppCertEventRecord {
  eventType: string;
  eventData: Record<string, unknown> | null;
  actor: string;
}

export type TransitionResult =
  | { next: AppCert; eventToWrite: AppCertEventRecord }
  | { next: "delete"; eventToWrite: AppCertEventRecord };

export class IllegalTransitionError extends Error {
  readonly from: CertStatus;
  readonly event: CertEvent["kind"];
  constructor(from: CertStatus, event: CertEvent["kind"]) {
    super(`illegal transition: ${from} via ${event}`);
    this.name = "IllegalTransitionError";
    this.from = from;
    this.event = event;
  }
}

function clone(c: AppCert): AppCert {
  return { ...c };
}

export function transition(cert: AppCert, event: CertEvent): TransitionResult {
  switch (event.kind) {
    case "issue_requested": {
      const next = clone(cert);
      next.status = "pending";
      return {
        next,
        eventToWrite: {
          eventType: "force_renew_requested",
          eventData: null,
          actor: event.actor,
        },
      };
    }
    case "caddy_active": {
      if (cert.status !== "pending" && cert.status !== "pending_reconcile") {
        throw new IllegalTransitionError(cert.status, event.kind);
      }
      const next = clone(cert);
      next.status = "active";
      next.issuedAt = next.issuedAt ?? event.issuedAt;
      next.expiresAt = event.expiresAt;
      next.acmeAccountEmail = event.acmeEmail;
      next.errorMessage = null;
      next.retryAfter = null;
      next.pendingDnsRecheckUntil = null;
      return {
        next,
        eventToWrite: {
          eventType: "issued",
          eventData: { issuedAt: event.issuedAt, expiresAt: event.expiresAt },
          actor: "system",
        },
      };
    }
    case "caddy_failed": {
      if (cert.status !== "pending" && cert.status !== "pending_reconcile") {
        throw new IllegalTransitionError(cert.status, event.kind);
      }
      const next = clone(cert);
      next.status = "failed";
      next.errorMessage = event.errorMessage;
      next.pendingDnsRecheckUntil = null;
      return {
        next,
        eventToWrite: {
          eventType: "failed",
          eventData: { errorMessage: event.errorMessage },
          actor: "system",
        },
      };
    }
    case "acme_rate_limit": {
      if (cert.status !== "pending" && cert.status !== "pending_reconcile") {
        throw new IllegalTransitionError(cert.status, event.kind);
      }
      const next = clone(cert);
      next.status = "rate_limited";
      next.retryAfter = event.retryAfter;
      return {
        next,
        eventToWrite: {
          eventType: "rate_limited",
          eventData: { retryAfter: event.retryAfter },
          actor: "system",
        },
      };
    }
    case "expiry_probe_passed": {
      if (cert.status !== "active") {
        throw new IllegalTransitionError(cert.status, event.kind);
      }
      const next = clone(cert);
      next.expiresAt = event.expiresAt;
      next.lastRenewAt = event.lastRenewAt;
      next.lastRenewOutcome = "success";
      return {
        next,
        eventToWrite: {
          eventType: "renewed",
          eventData: { expiresAt: event.expiresAt },
          actor: "system",
        },
      };
    }
    case "expires_at_in_past": {
      if (cert.status !== "active") {
        throw new IllegalTransitionError(cert.status, event.kind);
      }
      const next = clone(cert);
      next.status = "expired";
      return {
        next,
        eventToWrite: { eventType: "failed", eventData: { reason: "expired" }, actor: "system" },
      };
    }
    case "domain_changed": {
      if (cert.status === "orphaned" || cert.status === "revoked") {
        throw new IllegalTransitionError(cert.status, event.kind);
      }
      const next = clone(cert);
      next.status = "orphaned";
      next.orphanReason = event.orphanReason;
      next.orphanedAt = new Date().toISOString();
      return {
        next,
        eventToWrite: { eventType: "orphaned", eventData: { reason: "domain_change" }, actor: "system" },
      };
    }
    case "app_soft_deleted": {
      if (cert.status === "orphaned" || cert.status === "revoked") {
        throw new IllegalTransitionError(cert.status, event.kind);
      }
      const next = clone(cert);
      next.status = "orphaned";
      next.orphanReason = "app_soft_delete";
      next.orphanedAt = new Date().toISOString();
      return {
        next,
        eventToWrite: { eventType: "orphaned", eventData: { reason: "app_soft_delete" }, actor: "system" },
      };
    }
    case "force_revoke": {
      if (cert.status === "revoked") {
        throw new IllegalTransitionError(cert.status, event.kind);
      }
      const next = clone(cert);
      next.status = "revoked";
      return {
        next,
        eventToWrite: { eventType: "revoked", eventData: null, actor: event.actor },
      };
    }
    case "force_renew_requested": {
      if (cert.status !== "failed" && cert.status !== "expired" && cert.status !== "rate_limited") {
        throw new IllegalTransitionError(cert.status, event.kind);
      }
      if (cert.status === "rate_limited" && cert.retryAfter !== null) {
        const ra = new Date(cert.retryAfter).getTime();
        if (Number.isFinite(ra) && ra > Date.now()) {
          throw new IllegalTransitionError(cert.status, event.kind);
        }
      }
      const next = clone(cert);
      next.status = "pending";
      next.retryAfter = null;
      return {
        next,
        eventToWrite: {
          eventType: "force_renew_requested",
          eventData: null,
          actor: event.actor,
        },
      };
    }
    case "retention_window_elapsed": {
      if (cert.status !== "orphaned") {
        throw new IllegalTransitionError(cert.status, event.kind);
      }
      return {
        next: "delete",
        eventToWrite: { eventType: "orphan_cleaned", eventData: null, actor: "system" },
      };
    }
    default: {
      const _exhaustive: never = event;
      throw new Error(`unknown event: ${JSON.stringify(_exhaustive)}`);
    }
  }
}
