/**
 * T014 parity test — server validator and client validator must produce
 * byte-identical outputs across a representative fixtures array.
 */
import { describe, it, expect } from "vitest";
import { validateDomain as serverValidate } from "../../server/lib/domain-validator.js";
import { validateDomain as clientValidate } from "../../client/lib/domain-validator.js";

const FIXTURES: (string | null | undefined)[] = [
  null,
  undefined,
  "",
  "   ",
  "foo.example.com",
  "a.b.c.example.co.uk",
  "1foo.com",
  "*.foo.com",
  "Foo.Example.Com",
  "_dmarc.foo.com",
  "foo.com.",
  "foo..bar",
  "-foo.com",
  "foo-.com",
  "a".repeat(64) + ".com",
  "localhost",
  "192.168.1.1",
  "xn--mnchen-3ya.de",
  "foo bar.com",
];

describe("domain-validator parity (T014)", () => {
  it("server and client return the exact same shape for every fixture", () => {
    for (const f of FIXTURES) {
      const s = serverValidate(f);
      const c = clientValidate(f);
      expect(c).toEqual(s);
    }
  });
});
