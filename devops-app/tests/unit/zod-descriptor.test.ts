import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  extractFieldDescriptors,
  isSecretField,
} from "../../server/lib/zod-descriptor.js";

describe("extractFieldDescriptors (feature 005 T019)", () => {
  it("maps z.string() → string required", () => {
    const [d] = extractFieldDescriptors(z.object({ name: z.string() }));
    expect(d).toMatchObject({ name: "name", type: "string", required: true });
  });

  it("z.string().optional() → not required", () => {
    const [d] = extractFieldDescriptors(z.object({ name: z.string().optional() }));
    expect(d.required).toBe(false);
  });

  it("z.string().default('x') → not required + default", () => {
    const [d] = extractFieldDescriptors(z.object({ name: z.string().default("x") }));
    expect(d.required).toBe(false);
    expect(d.default).toBe("x");
  });

  it("z.number() → type number", () => {
    const [d] = extractFieldDescriptors(z.object({ n: z.number() }));
    expect(d.type).toBe("number");
  });

  it("z.boolean() → type boolean", () => {
    const [d] = extractFieldDescriptors(z.object({ b: z.boolean() }));
    expect(d.type).toBe("boolean");
  });

  it("z.enum([...]) → type enum + enumValues", () => {
    const [d] = extractFieldDescriptors(z.object({ e: z.enum(["a", "b"]) }));
    expect(d.type).toBe("enum");
    expect(d.enumValues).toEqual(["a", "b"]);
  });

  it(".describe('secret') → isSecret true", () => {
    const [d] = extractFieldDescriptors(
      z.object({ token: z.string().describe("secret") }),
    );
    expect(d.isSecret).toBe(true);
  });

  it("kebab-cases field names in the descriptor", () => {
    const [d] = extractFieldDescriptors(
      z.object({ databaseName: z.string() }),
    );
    expect(d.name).toBe("database-name");
  });

  it("isSecretField() returns true for .describe('secret')", () => {
    expect(isSecretField(z.string().describe("secret"))).toBe(true);
    expect(isSecretField(z.string().describe("human readable"))).toBe(false);
    expect(isSecretField(z.string())).toBe(false);
  });
});
