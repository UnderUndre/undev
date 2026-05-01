/** T060 — force renew gate states. */
import { describe, it, expect } from "vitest";
import { transition, IllegalTransitionError } from "../../server/services/cert-lifecycle.js";

function cert(status: string, retryAfter: string | null = null) {
  return {
    id: "c", appId: "a", domain: "d", status, issuer: "letsencrypt",
    issuedAt: null, expiresAt: null, lastRenewAt: null, lastRenewOutcome: null,
    errorMessage: null, retryAfter, orphanedAt: null, orphanReason: "",
    acmeAccountEmail: null, pendingDnsRecheckUntil: null,
    createdAt: new Date().toISOString(),
  } as Parameters<typeof transition>[0];
}

describe("force-renew gate (T060)", () => {
  it.each(["failed", "expired", "rate_limited"])("%s → pending", (s) => {
    if (s === "rate_limited") {
      const r = transition(cert(s, "2020-01-01T00:00:00Z"), { kind: "force_renew_requested", actor: "u" });
      if (r.next !== "delete") expect(r.next.status).toBe("pending");
    } else {
      const r = transition(cert(s), { kind: "force_renew_requested", actor: "u" });
      if (r.next !== "delete") expect(r.next.status).toBe("pending");
    }
  });

  it.each(["active", "pending", "orphaned", "revoked", "pending_reconcile"])("%s rejected", (s) => {
    expect(() => transition(cert(s), { kind: "force_renew_requested", actor: "u" })).toThrow(
      IllegalTransitionError,
    );
  });

  it("rate_limited + future retry_after rejected", () => {
    const future = new Date(Date.now() + 3600_000).toISOString();
    expect(() =>
      transition(cert("rate_limited", future), { kind: "force_renew_requested", actor: "u" }),
    ).toThrow(IllegalTransitionError);
  });
});
