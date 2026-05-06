/** Feature 011 T012 — event catalogue invariants. */
import { describe, it, expect } from "vitest";
import {
  EVENT_CATALOGUE,
  catalogueGet,
  catalogueHas,
} from "../../server/lib/event-catalogue.js";

describe("event-catalogue", () => {
  it("every entry has required fields populated", () => {
    for (const e of EVENT_CATALOGUE) {
      expect(typeof e.type).toBe("string");
      expect(e.type.length).toBeGreaterThan(0);
      expect(typeof e.description).toBe("string");
      expect(e.description.length).toBeGreaterThan(0);
      expect(typeof e.defaultEnabled).toBe("boolean");
      expect(["failure", "security", "success", "operational"]).toContain(
        e.category,
      );
    }
  });

  it("event types are unique", () => {
    const types = EVENT_CATALOGUE.map((e) => e.type);
    expect(new Set(types).size).toBe(EVENT_CATALOGUE.length);
  });

  it("event types match canonical regex (lowercase dot-separated)", () => {
    const re = /^[a-z][a-z_]*(\.[a-z][a-z_]*)+$/;
    for (const e of EVENT_CATALOGUE) {
      expect(e.type, `bad type: ${e.type}`).toMatch(re);
    }
  });

  it("contains the 15 events declared in data-model.md", () => {
    expect(EVENT_CATALOGUE.length).toBe(15);
    const failure = EVENT_CATALOGUE.filter((e) => e.category === "failure");
    const security = EVENT_CATALOGUE.filter((e) => e.category === "security");
    const success = EVENT_CATALOGUE.filter((e) => e.category === "success");
    const operational = EVENT_CATALOGUE.filter(
      (e) => e.category === "operational",
    );
    expect(failure.length).toBe(6);
    expect(security.length).toBe(4);
    expect(success.length).toBe(4);
    expect(operational.length).toBe(1);
  });

  it("catalogueHas / catalogueGet helpers", () => {
    expect(catalogueHas("deploy.failed")).toBe(true);
    expect(catalogueHas("not.a.real.event")).toBe(false);
    expect(catalogueGet("deploy.failed")?.defaultEnabled).toBe(true);
    expect(catalogueGet("deploy.succeeded")?.defaultEnabled).toBe(false);
    expect(catalogueGet("missing")).toBeUndefined();
  });
});
