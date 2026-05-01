import { describe, it, expect } from "vitest";
import { getRegisteredDomain } from "../../server/lib/psl.js";

describe("psl.getRegisteredDomain (T016)", () => {
  it.each([
    ["foo.example.com", "example.com"],
    ["foo.bar.example.com", "example.com"],
    ["foo.bar.co.uk", "bar.co.uk"],
    ["a.b.c.example.co.uk", "example.co.uk"],
    ["foo.bar.amazonaws.com", "bar.amazonaws.com"],
    ["foo.github.io", "foo.github.io"],
    ["xn--80aaxitdbjk.xn--p1ai", "xn--80aaxitdbjk.xn--p1ai"],
    ["bar.com", "bar.com"],
    ["co.uk", "co.uk"],
  ])("%s → %s", (input, expected) => {
    expect(getRegisteredDomain(input)).toBe(expected);
  });

  it("falls back to last-two-labels for unknown TLDs", () => {
    expect(getRegisteredDomain("a.b.unknownsuffix")).toBe("b.unknownsuffix");
  });

  it("handles single label / empty input gracefully", () => {
    expect(getRegisteredDomain("localhost")).toBe("localhost");
    expect(getRegisteredDomain("")).toBe("");
  });
});
