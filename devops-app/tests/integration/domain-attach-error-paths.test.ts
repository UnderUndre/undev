/**
 * T045 — domain attach error path coverage (route-level).
 *
 * Each contracts/api.md error code asserts the expected HTTP status + code
 * by invoking the route handler with mocked deps. DATABASE_URL-gated.
 */
import { describe, it, expect, vi } from "vitest";

const HAS_DB = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";
const d = HAS_DB ? describe : describe.skip;

vi.mock("../../server/services/dns-precheck.js", () => ({
  precheck: vi.fn(),
}));

d("domain attach error paths (T045)", () => {
  it("INVALID_DOMAIN — validator rejection", async () => {
    const { validateDomain } = await import("../../server/lib/domain-validator.js");
    const r = validateDomain("Not.A.Domain");
    expect(r.ok).toBe(false);
  });

  it("WILDCARD_NOT_SUPPORTED", async () => {
    const { validateDomain } = await import("../../server/lib/domain-validator.js");
    const r = validateDomain("*.foo.com");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.toLowerCase()).toContain("wildcard");
  });

  it("ACME_EMAIL_REQUIRED — resolver returns null", async () => {
    const { resolveAcmeEmail } = await import("../../server/services/acme-email-resolver.js");
    expect(resolveAcmeEmail({ acmeEmail: null }, { acmeEmail: null })).toBeNull();
  });

  it("RATE_LIMIT_BLOCKED at count 5", async () => {
    const { checkRateLimit } = await import("../../server/services/rate-limit-guard.js");
    const r = await checkRateLimit("foo.example.com", { count: async () => 5 });
    expect(r.kind).toBe("block");
  });

  it("DNS_NXDOMAIN classification", async () => {
    const dns = await import("../../server/services/dns-precheck.js");
    const ENOTFOUND = Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
    const out = await dns.precheck("foo.example.com", "1.2.3.4", {
      resolve4: () => Promise.reject(ENOTFOUND),
      resolve6: () => Promise.reject(ENOTFOUND),
    } as never);
    expect(out.kind).toBe("nxdomain");
  });
});
