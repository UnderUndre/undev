import { describe, it, expect } from "vitest";
import { z } from "zod";
import { serialiseParams } from "../../server/lib/serialise-params.js";

describe("serialiseParams (feature 005 T020)", () => {
  it("single-quotes string values in argv", () => {
    const s = z.object({ name: z.string() });
    const r = serialiseParams(s, { name: "mydb" });
    expect(r.args).toEqual(["--name='mydb'"]);
    expect(r.envExports).toEqual({});
  });

  it("stringifies + quotes numbers", () => {
    const s = z.object({ retentionDays: z.number() });
    const r = serialiseParams(s, { retentionDays: 30 });
    expect(r.args).toEqual(["--retention-days='30'"]);
  });

  it("boolean true → flag present; false → omitted", () => {
    const s = z.object({ skipClone: z.boolean() });
    expect(serialiseParams(s, { skipClone: true }).args).toEqual(["--skip-clone"]);
    expect(serialiseParams(s, { skipClone: false }).args).toEqual([]);
  });

  it("arrays → repeated --flag=val", () => {
    const s = z.object({ tags: z.array(z.string()) });
    const r = serialiseParams(s, { tags: ["a", "b"] });
    expect(r.args).toEqual(["--tags='a'", "--tags='b'"]);
  });

  it("skips null and undefined", () => {
    const s = z.object({ x: z.string().optional() });
    expect(serialiseParams(s, { x: null }).args).toEqual([]);
    expect(serialiseParams(s, { x: undefined }).args).toEqual([]);
  });

  it("routes secret fields into envExports, NOT argv", () => {
    const s = z.object({ adminKey: z.string().describe("secret") });
    const r = serialiseParams(s, { adminKey: "s3cret" });
    expect(r.args).toEqual([]);
    expect(r.envExports).toEqual({ SECRET_ADMIN_KEY: "s3cret" });
  });

  it("transforms camelCase → UPPER_SNAKE for secret env var names", () => {
    const s = z.object({
      s3SecretAccessKey: z.string().describe("secret"),
    });
    const r = serialiseParams(s, { s3SecretAccessKey: "abc" });
    expect(Object.keys(r.envExports)).toEqual(["SECRET_S3_SECRET_ACCESS_KEY"]);
  });

  it("single-quote-escapes values with embedded quotes", () => {
    const s = z.object({ name: z.string() });
    const r = serialiseParams(s, { name: "O'Hara" });
    expect(r.args).toEqual(["--name='O'\\''Hara'"]);
  });
});
