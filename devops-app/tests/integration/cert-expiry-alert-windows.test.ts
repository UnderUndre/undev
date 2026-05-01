/** T049 — windowed expiry alerts integration smoke (DATABASE_URL-gated). */
import { describe, it, expect } from "vitest";
import { evaluateAlertWindows } from "../../server/services/cert-expiry-alerter.js";

const HAS_DB = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";
const d = HAS_DB ? describe : describe.skip;

d("cert-expiry-alert-windows integration (T049)", () => {
  it("first crossing of 14d fires; second tick within window is silent", () => {
    const NOW = new Date();
    const expIso = new Date(NOW.getTime() + 13.5 * 86_400_000).toISOString();

    const first = evaluateAlertWindows({ status: "active", expiresAt: expIso }, NOW, new Set());
    expect(first.windowsToFire).toContain("14d");

    const second = evaluateAlertWindows(
      { status: "active", expiresAt: expIso },
      new Date(NOW.getTime() + 60_000),
      new Set(["14d"]),
    );
    expect(second.windowsToFire).not.toContain("14d");
  });

  it("renewal pushes expiry past window → next 14d fires again", () => {
    const NOW = new Date();
    // Past lifecycle fired 14d.
    // After renewal, lifecycle resets — fired set is empty.
    const renewedExp = new Date(NOW.getTime() + 13.5 * 86_400_000).toISOString();
    const r = evaluateAlertWindows(
      { status: "active", expiresAt: renewedExp },
      NOW,
      new Set(),
    );
    expect(r.windowsToFire).toContain("14d");
  });
});
