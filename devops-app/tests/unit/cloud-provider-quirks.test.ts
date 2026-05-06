/** Feature 011 T055 — provider quirks table invariants. */
import { describe, it, expect } from "vitest";
import {
  PROVIDER_QUIRKS,
  type CloudProvider,
} from "../../server/lib/cloud-provider-quirks.js";

describe("cloud-provider-quirks", () => {
  const providers: CloudProvider[] = ["gcp", "aws", "do", "hetzner", "vanilla"];

  it("table has an entry list for every provider enum value", () => {
    for (const p of providers) {
      expect(Array.isArray(PROVIDER_QUIRKS[p])).toBe(true);
    }
  });

  it("vanilla has no quirks (clean baseline)", () => {
    expect(PROVIDER_QUIRKS.vanilla).toEqual([]);
  });

  it("GCP entry mentions use_pty (regression guard against renames)", () => {
    const gcp = PROVIDER_QUIRKS.gcp;
    expect(gcp.length).toBeGreaterThan(0);
    expect(gcp.some((q) => q.banner.includes("use_pty"))).toBe(true);
  });

  it("every quirk entry has typed shape", () => {
    for (const p of providers) {
      for (const q of PROVIDER_QUIRKS[p]) {
        expect(typeof q.id).toBe("string");
        expect(q.id.length).toBeGreaterThan(0);
        expect(typeof q.banner).toBe("string");
        expect(["auto", "manual"]).toContain(q.remediation);
        if (q.remediation === "auto") {
          expect(typeof q.appliedBy).toBe("string");
        }
      }
    }
  });

  it("quirk ids are unique within each provider", () => {
    for (const p of providers) {
      const ids = PROVIDER_QUIRKS[p].map((q) => q.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });
});
