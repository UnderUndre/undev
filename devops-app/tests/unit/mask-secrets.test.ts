import { describe, it, expect } from "vitest";
import { z } from "zod";
import { maskSecrets } from "../../server/lib/mask-secrets.js";

describe("maskSecrets (feature 005 T021)", () => {
  it("replaces secret-marked fields with '***'", () => {
    const s = z.object({
      name: z.string(),
      token: z.string().describe("secret"),
    });
    const masked = maskSecrets(s, { name: "mydb", token: "s3cret" });
    expect(masked).toEqual({ name: "mydb", token: "***" });
  });

  it("passes non-secret fields through untouched", () => {
    const s = z.object({ a: z.string(), b: z.number() });
    const masked = maskSecrets(s, { a: "x", b: 42 });
    expect(masked).toEqual({ a: "x", b: 42 });
  });

  it("returns empty for empty schema + values", () => {
    const s = z.object({});
    expect(maskSecrets(s, {})).toEqual({});
  });

  it("does NOT recurse into nested objects (v1 flat only)", () => {
    const s = z.object({ nested: z.unknown() });
    const masked = maskSecrets(s, { nested: { token: "x" } });
    expect(masked).toEqual({ nested: { token: "x" } });
  });
});
