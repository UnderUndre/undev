import { describe, it, expect } from "vitest";
import {
  generateOverride,
  overridePath,
} from "../../server/lib/compose-override-generator.js";

describe("compose-override-generator", () => {
  it("generates override with container_name for blue slot", () => {
    const yml = generateOverride("api", "blue");
    expect(yml).toContain("services:");
    expect(yml).toContain("  api:");
    expect(yml).toContain("    container_name: api-blue");
  });

  it("generates override with container_name for green slot", () => {
    const yml = generateOverride("api", "green");
    expect(yml).toContain("    container_name: api-green");
  });

  it("is deterministic for same inputs (idempotent on re-write)", () => {
    expect(generateOverride("svc", "blue")).toBe(generateOverride("svc", "blue"));
  });

  it("overridePath is under .dashboard/", () => {
    expect(overridePath("/opt/myapp")).toBe(
      "/opt/myapp/.dashboard/docker-compose.bg-override.yml",
    );
  });
});
