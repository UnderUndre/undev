/**
 * T027 — assert manifest registers the new server-ops/install-caddy entry.
 */
import { describe, it, expect } from "vitest";
import { manifest } from "../../server/scripts-manifest.js";

describe("scripts-manifest install-caddy (T027)", () => {
  const entry = manifest.find((e) => e.id === "server-ops/install-caddy");

  it("entry exists", () => {
    expect(entry).toBeDefined();
  });

  it("category is server-ops, locus target", () => {
    expect(entry?.category).toBe("server-ops");
    expect(entry?.locus).toBe("target");
  });

  it("requiresLock is false (Caddy install is host-level, no app)", () => {
    expect(entry?.requiresLock).toBe(false);
  });

  it("dangerLevel low", () => {
    expect(entry?.dangerLevel).toBe("low");
  });

  it("params is strict empty object", () => {
    const parsed = entry?.params.safeParse({});
    expect(parsed?.success).toBe(true);
    const rejected = entry?.params.safeParse({ extra: 1 });
    expect(rejected?.success).toBe(false);
  });
});
