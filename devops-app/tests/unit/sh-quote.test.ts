import { describe, it, expect } from "vitest";
import { shQuote } from "../../server/lib/sh-quote.js";

describe("shQuote (feature 005 T017)", () => {
  it("wraps ordinary strings in single quotes", () => {
    expect(shQuote("hello")).toBe("'hello'");
  });

  it("escapes single quotes with the '\\'' sequence", () => {
    expect(shQuote("O'Hara")).toBe("'O'\\''Hara'");
  });

  it("handles empty string", () => {
    expect(shQuote("")).toBe("''");
  });

  it("preserves newlines (bash handles inside single quotes)", () => {
    expect(shQuote("a\nb")).toBe("'a\nb'");
  });

  it("quotes shell metacharacters safely", () => {
    expect(shQuote(";")).toBe("';'");
    expect(shQuote("`whoami`")).toBe("'`whoami`'");
    expect(shQuote("$HOME")).toBe("'$HOME'");
    expect(shQuote("|")).toBe("'|'");
    expect(shQuote("&&")).toBe("'&&'");
    expect(shQuote(">>")).toBe("'>>'");
  });

  it("handles long strings (8KB+)", () => {
    const big = "x".repeat(8192);
    const q = shQuote(big);
    expect(q.startsWith("'")).toBe(true);
    expect(q.endsWith("'")).toBe(true);
    expect(q.length).toBe(big.length + 2);
  });
});
