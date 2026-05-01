import { describe, it, expect } from "vitest";
import { validateDomain } from "../../server/lib/domain-validator.js";

describe("validateDomain (server) — Feature 008 T014", () => {
  describe("valid", () => {
    it.each([
      ["foo.example.com"],
      ["a.b.c.example.co.uk"],
      ["1foo.com"],
      ["foo-bar.example.com"],
      ["xn--mnchen-3ya.de"],
      ["a-b-c.d-e-f.example.io"],
    ])("%s → ok", (d) => {
      const r = validateDomain(d);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toBe(d);
    });
  });

  describe("normalises null/empty/whitespace to null", () => {
    it.each([null, undefined, "", "   "])("%s → ok null", (v) => {
      const r = validateDomain(v as string | null | undefined);
      expect(r).toEqual({ ok: true, value: null });
    });
  });

  describe("rejected", () => {
    it.each([
      ["*.foo.com", /wildcard/i],
      ["Foo.Example.Com", /lowercase/i],
      ["_dmarc.foo.com", /alphanumeric|underscore/i],
      ["foo.com.", /dot/i],
      ["foo..bar", /empty label/i],
      ["-foo.com", /alphanumeric|hyphen/i],
      ["foo-.com", /alphanumeric|hyphen/i],
      ["a".repeat(64) + ".com", /Label exceeds/i],
      ["localhost", /alphanumeric|dot/i],
      ["192.168.1.1", /IP/i],
      ["foo bar.com", /alphanumeric/i],
      ["foo.com/extra", /alphanumeric/i],
    ])("%s → not ok", (d, msgRe) => {
      const r = validateDomain(d as string);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(msgRe);
    });
  });

  it("rejects total length > 253", () => {
    const big = (("a".repeat(60) + ".").repeat(5) + "com");
    if (big.length <= 253) return; // safety
    const r = validateDomain(big);
    expect(r.ok).toBe(false);
  });

  it("rejects non-string input shape", () => {
    const r = validateDomain(123 as unknown as string);
    expect(r.ok).toBe(false);
  });
});
