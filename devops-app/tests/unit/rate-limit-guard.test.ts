import { describe, it, expect } from "vitest";
import { checkRateLimit } from "../../server/services/rate-limit-guard.js";

function deps(count: number) {
  return { count: async () => count };
}

describe("rate-limit-guard (T023)", () => {
  it.each([
    [0, "ok"],
    [2, "ok"],
    [3, "warn"],
    [4, "warn"],
    [5, "block"],
    [6, "block"],
  ])("count %i → %s", async (count, expected) => {
    const r = await checkRateLimit("foo.example.com", deps(count));
    expect(r.kind).toBe(expected);
  });

  it("registered domain rolls up subdomains (.co.uk)", async () => {
    const r = await checkRateLimit("foo.bar.co.uk", deps(0));
    expect(r.registered).toBe("bar.co.uk");
  });

  it("registered domain for plain .com", async () => {
    const r = await checkRateLimit("foo.example.com", deps(0));
    expect(r.registered).toBe("example.com");
  });

  it("returns count for diagnostic", async () => {
    const r = await checkRateLimit("foo.example.com", deps(4));
    expect(r.count).toBe(4);
  });
});
