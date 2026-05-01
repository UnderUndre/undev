/** Feature 008 T047 — pure cert-expiry-alerter unit tests. */
import { describe, it, expect } from "vitest";
import { evaluateAlertWindows } from "../../server/services/cert-expiry-alerter.js";

const NOW = new Date("2026-04-28T12:00:00Z");

function expIn(days: number): string {
  return new Date(NOW.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
}

describe("cert-expiry-alerter (T047)", () => {
  it("daysLeft > 14 → no window", () => {
    const r = evaluateAlertWindows({ status: "active", expiresAt: expIn(20) }, NOW, new Set());
    expect(r.windowsToFire).toEqual([]);
  });

  it("daysLeft ≈ 14 (within window) → fires 14d", () => {
    const r = evaluateAlertWindows({ status: "active", expiresAt: expIn(13.5) }, NOW, new Set());
    expect(r.windowsToFire).toContain("14d");
  });

  it("daysLeft 7 → fires 7d (and 14d if not yet)", () => {
    const r = evaluateAlertWindows({ status: "active", expiresAt: expIn(6.5) }, NOW, new Set());
    expect(r.windowsToFire).toContain("7d");
    expect(r.windowsToFire).toContain("14d");
  });

  it("already-fired windows are silent", () => {
    const r = evaluateAlertWindows(
      { status: "active", expiresAt: expIn(13) },
      NOW,
      new Set(["14d"]),
    );
    expect(r.windowsToFire).toEqual([]);
  });

  it("multiple windows crossed at once (30d → 2d), 1d still future", () => {
    const r = evaluateAlertWindows({ status: "active", expiresAt: expIn(2) }, NOW, new Set());
    expect(r.windowsToFire).toContain("14d");
    expect(r.windowsToFire).toContain("7d");
    expect(r.windowsToFire).toContain("3d");
    expect(r.windowsToFire).not.toContain("1d");
  });

  it("daysLeft 0 or negative → no fire (cert already expired, different alert path)", () => {
    const r = evaluateAlertWindows(
      { status: "active", expiresAt: expIn(-1) },
      NOW,
      new Set(),
    );
    expect(r.windowsToFire).toEqual([]);
  });

  it("non-active status → no fire", () => {
    const r = evaluateAlertWindows(
      { status: "pending", expiresAt: expIn(5) },
      NOW,
      new Set(),
    );
    expect(r.windowsToFire).toEqual([]);
  });

  it("null expiresAt → no fire", () => {
    const r = evaluateAlertWindows(
      { status: "active", expiresAt: null },
      NOW,
      new Set(),
    );
    expect(r.windowsToFire).toEqual([]);
  });

  it("malformed expiresAt → no fire", () => {
    const r = evaluateAlertWindows(
      { status: "active", expiresAt: "not-a-date" },
      NOW,
      new Set(),
    );
    expect(r.windowsToFire).toEqual([]);
  });

  it("renewal: lifecycle resets, 14d fires again", () => {
    // Caller passes empty firedWindows for the new lifecycle.
    const r = evaluateAlertWindows({ status: "active", expiresAt: expIn(13) }, NOW, new Set());
    expect(r.windowsToFire).toContain("14d");
  });

  it("daysLeft exactly 1 → 1d window included", () => {
    const r = evaluateAlertWindows(
      { status: "active", expiresAt: expIn(0.99) },
      NOW,
      new Set(["14d", "7d", "3d"]),
    );
    expect(r.windowsToFire).toEqual(["1d"]);
  });

  it("daysLeft 3 → only 3d if higher windows already fired", () => {
    const r = evaluateAlertWindows(
      { status: "active", expiresAt: expIn(2.9) },
      NOW,
      new Set(["14d", "7d"]),
    );
    expect(r.windowsToFire).toEqual(["3d"]);
  });

  it("returns daysLeft in output", () => {
    const r = evaluateAlertWindows(
      { status: "active", expiresAt: expIn(5) },
      NOW,
      new Set(),
    );
    expect(r.daysLeft).toBeCloseTo(5, 1);
  });
});
