import { describe, it, expect } from "vitest";
import {
  transition,
  IllegalTransitionError,
  type AppCert,
} from "../../server/services/cert-lifecycle.js";

function cert(over: Partial<AppCert> = {}): AppCert {
  return {
    id: "c1",
    appId: "a1",
    domain: "foo.example.com",
    status: "pending",
    issuer: "letsencrypt",
    issuedAt: null,
    expiresAt: null,
    lastRenewAt: null,
    lastRenewOutcome: null,
    errorMessage: null,
    retryAfter: null,
    orphanedAt: null,
    orphanReason: "",
    acmeAccountEmail: null,
    pendingDnsRecheckUntil: null,
    createdAt: new Date().toISOString(),
    ...over,
  };
}

describe("cert-lifecycle.transition (T025)", () => {
  it("issue_requested → pending", () => {
    const r = transition(cert({ status: "failed" }), { kind: "issue_requested", actor: "u1" });
    expect(r.next).not.toBe("delete");
    if (r.next !== "delete") expect(r.next.status).toBe("pending");
  });

  it("pending → caddy_active → active", () => {
    const r = transition(cert(), {
      kind: "caddy_active",
      issuedAt: "2026-04-28T12:00:00Z",
      expiresAt: "2026-07-27T12:00:00Z",
      acmeEmail: "ops@x.com",
    });
    if (r.next !== "delete") {
      expect(r.next.status).toBe("active");
      expect(r.next.expiresAt).toBe("2026-07-27T12:00:00Z");
    }
  });

  it("pending → caddy_failed → failed with errorMessage preserved", () => {
    const r = transition(cert(), { kind: "caddy_failed", errorMessage: "DNS issue" });
    if (r.next !== "delete") {
      expect(r.next.status).toBe("failed");
      expect(r.next.errorMessage).toBe("DNS issue");
    }
  });

  it("pending → acme_rate_limit → rate_limited with retry_after", () => {
    const r = transition(cert(), { kind: "acme_rate_limit", retryAfter: "2026-05-05T12:00:00Z" });
    if (r.next !== "delete") {
      expect(r.next.status).toBe("rate_limited");
      expect(r.next.retryAfter).toBe("2026-05-05T12:00:00Z");
    }
  });

  it("active → expiry_probe_passed updates expiresAt only", () => {
    const r = transition(cert({ status: "active" }), {
      kind: "expiry_probe_passed",
      expiresAt: "2026-08-01T00:00:00Z",
      lastRenewAt: "2026-05-02T00:00:00Z",
    });
    if (r.next !== "delete") {
      expect(r.next.status).toBe("active");
      expect(r.next.expiresAt).toBe("2026-08-01T00:00:00Z");
    }
  });

  it("active → expires_at_in_past → expired", () => {
    const r = transition(cert({ status: "active" }), { kind: "expires_at_in_past" });
    if (r.next !== "delete") expect(r.next.status).toBe("expired");
  });

  it("active → domain_changed → orphaned with reason", () => {
    const r = transition(cert({ status: "active" }), {
      kind: "domain_changed",
      orphanReason: "domain_change",
    });
    if (r.next !== "delete") {
      expect(r.next.status).toBe("orphaned");
      expect(r.next.orphanReason).toBe("domain_change");
      expect(r.next.orphanedAt).not.toBeNull();
    }
  });

  it("active → app_soft_deleted → orphaned", () => {
    const r = transition(cert({ status: "active" }), { kind: "app_soft_deleted" });
    if (r.next !== "delete") {
      expect(r.next.orphanReason).toBe("app_soft_delete");
    }
  });

  it("active → force_revoke → revoked", () => {
    const r = transition(cert({ status: "active" }), { kind: "force_revoke", actor: "u1" });
    if (r.next !== "delete") expect(r.next.status).toBe("revoked");
  });

  it("failed → force_renew_requested → pending", () => {
    const r = transition(cert({ status: "failed" }), { kind: "force_renew_requested", actor: "u1" });
    if (r.next !== "delete") expect(r.next.status).toBe("pending");
  });

  it("expired → force_renew_requested → pending", () => {
    const r = transition(cert({ status: "expired" }), { kind: "force_renew_requested", actor: "u1" });
    if (r.next !== "delete") expect(r.next.status).toBe("pending");
  });

  it("rate_limited + retry_after past → force_renew ok", () => {
    const r = transition(
      cert({ status: "rate_limited", retryAfter: "2020-01-01T00:00:00Z" }),
      { kind: "force_renew_requested", actor: "u1" },
    );
    if (r.next !== "delete") expect(r.next.status).toBe("pending");
  });

  it("rate_limited + retry_after future → throws", () => {
    expect(() =>
      transition(
        cert({ status: "rate_limited", retryAfter: new Date(Date.now() + 60_000).toISOString() }),
        { kind: "force_renew_requested", actor: "u1" },
      ),
    ).toThrow(IllegalTransitionError);
  });

  it("orphaned → retention_window_elapsed → delete", () => {
    const r = transition(
      cert({ status: "orphaned", orphanReason: "domain_change", orphanedAt: new Date().toISOString() }),
      { kind: "retention_window_elapsed" },
    );
    expect(r.next).toBe("delete");
  });

  it("revoked → active is illegal", () => {
    expect(() =>
      transition(
        cert({ status: "revoked" }),
        { kind: "force_renew_requested", actor: "u1" },
      ),
    ).toThrow(IllegalTransitionError);
  });
});
