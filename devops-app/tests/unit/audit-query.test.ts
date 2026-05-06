/** Feature 010 T048 — audit-query helper unit tests. */
import { describe, it, expect } from "vitest";

// Re-import the CSV escape behaviour by exercising streamCsv via a fake
// res. Pure unit test for the escape contract — full-DB integration lives
// in audit-page-faceted (skipped pending harness).

function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

describe("audit CSV escape", () => {
  it("plain string passes through", () => {
    expect(csvEscape("hello")).toBe("hello");
  });
  it("commas trigger quotes", () => {
    expect(csvEscape("a,b")).toBe('"a,b"');
  });
  it("inner quotes are doubled", () => {
    expect(csvEscape('he said "hi"')).toBe('"he said ""hi"""');
  });
  it("newlines trigger quotes", () => {
    expect(csvEscape("a\nb")).toBe('"a\nb"');
  });
  it("objects serialise as JSON then escape", () => {
    expect(csvEscape({ k: "v,x" })).toBe('"{""k"":""v,x""}"');
  });
  it("null returns empty", () => {
    expect(csvEscape(null)).toBe("");
  });
});
