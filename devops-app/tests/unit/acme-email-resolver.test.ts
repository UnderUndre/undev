import { describe, it, expect } from "vitest";
import { resolveAcmeEmail } from "../../server/services/acme-email-resolver.js";

describe("resolveAcmeEmail (T019)", () => {
  it("both null → null", () => {
    expect(resolveAcmeEmail({ acmeEmail: null }, { acmeEmail: null })).toBeNull();
  });
  it("app-only → app", () => {
    expect(resolveAcmeEmail({ acmeEmail: "app@x.com" }, { acmeEmail: null })).toBe("app@x.com");
  });
  it("settings-only → settings", () => {
    expect(resolveAcmeEmail({ acmeEmail: null }, { acmeEmail: "ops@x.com" })).toBe("ops@x.com");
  });
  it("both set → app wins", () => {
    expect(resolveAcmeEmail({ acmeEmail: "app@x.com" }, { acmeEmail: "ops@x.com" })).toBe("app@x.com");
  });
  it("empty string app → fall through to settings", () => {
    expect(resolveAcmeEmail({ acmeEmail: "" }, { acmeEmail: "ops@x.com" })).toBe("ops@x.com");
  });
});
