import { describe, it, expect } from "vitest";
import { resolveContainerName } from "../../server/services/slot-namer.js";

describe("slot-namer", () => {
  it("resolveContainerName produces <service>-<color>", () => {
    expect(resolveContainerName("api", "blue")).toBe("api-blue");
    expect(resolveContainerName("api", "green")).toBe("api-green");
  });
});
