/**
 * Feature 006 T046 — windowed cert-expiry alert dedup unit tests.
 *
 * Drives the timeline from quickstart.md Scenario 4. The test simulates the
 * `app_cert_events` table with an in-memory store keyed by `(certId, window)`
 * and a mutable `lifecycle_start` token that flips on `recordRenewal`.
 *
 * Coverage (≥ 8 cases):
 *   1. daysLeft 30 → no window selected → no alert
 *   2. daysLeft 14 → window 14 fires (first time)
 *   3. daysLeft 13 → window 14 dedup (already fired)
 *   4. daysLeft 7  → window 7 fires (first time)
 *   5. daysLeft 6  → window 7 dedup
 *   6. daysLeft 3  → window 3 fires
 *   7. daysLeft 1  → window 1 fires
 *   8. renewal → lifecycle resets → next 14d fires again
 *   9. window selection edge: daysLeft 14.0 vs 14.0001
 *  10. NaN / Infinity → null
 */
import { describe, it, expect } from "vitest";
import {
  selectAlertWindow,
  reserveExpiryAlertSlot,
  shouldFireExpiryAlert,
  type CertAlertWindow,
  type CertWindowDedupDeps,
} from "../../server/services/cert-window-dedup.js";

interface Store {
  fired: Set<string>;
  lifecycle: number;
}

function makeStore(): Store {
  return { fired: new Set(), lifecycle: 1 };
}

function key(lifecycle: number, certId: string, window: CertAlertWindow): string {
  return `${lifecycle}:${certId}:${window}`;
}

function makeDeps(store: Store, certId: string): CertWindowDedupDeps {
  return {
    hasExpiryAlert: async (id, w) =>
      store.fired.has(key(store.lifecycle, id, w)),
    recordExpiryAlert: async (id, w) => {
      store.fired.add(key(store.lifecycle, id, w));
    },
  };
}

function recordRenewal(store: Store): void {
  store.lifecycle += 1;
}

describe("cert-window-dedup — selectAlertWindow", () => {
  it("returns null for daysLeft above 14", () => {
    expect(selectAlertWindow(30)).toBeNull();
    expect(selectAlertWindow(14.0001)).toBeNull();
    expect(selectAlertWindow(15)).toBeNull();
  });

  it("returns 14 for daysLeft in (7, 14]", () => {
    expect(selectAlertWindow(14)).toBe(14);
    expect(selectAlertWindow(13)).toBe(14);
    expect(selectAlertWindow(7.0001)).toBe(14);
  });

  it("returns 7 for daysLeft in (3, 7]", () => {
    expect(selectAlertWindow(7)).toBe(7);
    expect(selectAlertWindow(6)).toBe(7);
  });

  it("returns 3 for daysLeft in (1, 3]", () => {
    expect(selectAlertWindow(3)).toBe(3);
    expect(selectAlertWindow(2)).toBe(3);
  });

  it("returns 1 for daysLeft <= 1 (incl. 0 and negatives)", () => {
    expect(selectAlertWindow(1)).toBe(1);
    expect(selectAlertWindow(0)).toBe(1);
    expect(selectAlertWindow(-5)).toBe(1);
  });

  it("returns null for NaN/Infinity", () => {
    expect(selectAlertWindow(Number.NaN)).toBeNull();
    expect(selectAlertWindow(Number.POSITIVE_INFINITY)).toBeNull();
    expect(selectAlertWindow(Number.NEGATIVE_INFINITY)).toBeNull();
  });
});

describe("cert-window-dedup — quickstart Scenario 4 timeline", () => {
  const certId = "cert-abc";

  it("(1) daysLeft 30 → no alert", async () => {
    const store = makeStore();
    const r = await reserveExpiryAlertSlot(certId, 30, makeDeps(store, certId));
    expect(r.fired).toBe(false);
    expect(r.window).toBeNull();
  });

  it("(2,3) 14 fires, 13 silent (same lifecycle)", async () => {
    const store = makeStore();
    const deps = makeDeps(store, certId);
    const r1 = await reserveExpiryAlertSlot(certId, 14, deps);
    expect(r1).toEqual({ fired: true, window: 14 });
    const r2 = await reserveExpiryAlertSlot(certId, 13, deps);
    expect(r2).toEqual({ fired: false, window: 14 });
  });

  it("(4,5) 7 fires after 14 lifecycle, 6 silent", async () => {
    const store = makeStore();
    const deps = makeDeps(store, certId);
    await reserveExpiryAlertSlot(certId, 14, deps); // fires
    await reserveExpiryAlertSlot(certId, 13, deps); // dedup
    const r7 = await reserveExpiryAlertSlot(certId, 7, deps);
    expect(r7).toEqual({ fired: true, window: 7 });
    const r6 = await reserveExpiryAlertSlot(certId, 6, deps);
    expect(r6).toEqual({ fired: false, window: 7 });
  });

  it("(6) daysLeft 3 fires window 3", async () => {
    const store = makeStore();
    const deps = makeDeps(store, certId);
    await reserveExpiryAlertSlot(certId, 14, deps);
    await reserveExpiryAlertSlot(certId, 7, deps);
    const r3 = await reserveExpiryAlertSlot(certId, 3, deps);
    expect(r3).toEqual({ fired: true, window: 3 });
  });

  it("(7) daysLeft 1 fires window 1", async () => {
    const store = makeStore();
    const deps = makeDeps(store, certId);
    await reserveExpiryAlertSlot(certId, 14, deps);
    await reserveExpiryAlertSlot(certId, 7, deps);
    await reserveExpiryAlertSlot(certId, 3, deps);
    const r1 = await reserveExpiryAlertSlot(certId, 1, deps);
    expect(r1).toEqual({ fired: true, window: 1 });
    // a 1-day repeat is silent
    const r1b = await reserveExpiryAlertSlot(certId, 1, deps);
    expect(r1b).toEqual({ fired: false, window: 1 });
  });

  it("(8) renewal resets lifecycle — fresh 14d alert fires again", async () => {
    const store = makeStore();
    const deps = makeDeps(store, certId);
    await reserveExpiryAlertSlot(certId, 14, deps);
    // duplicate within same lifecycle
    expect((await reserveExpiryAlertSlot(certId, 14, deps)).fired).toBe(false);
    // renewal flips lifecycle; the dedup key changes; next 14d alert fires
    recordRenewal(store);
    const after = await reserveExpiryAlertSlot(certId, 14, deps);
    expect(after).toEqual({ fired: true, window: 14 });
  });

  it("default deps (no hooks) always fire — feature 008 not yet wired", async () => {
    const r1 = await reserveExpiryAlertSlot(certId, 14);
    const r2 = await reserveExpiryAlertSlot(certId, 14);
    expect(r1.fired).toBe(true);
    expect(r2.fired).toBe(true); // no dedup persistence → always fires
  });

  it("shouldFireExpiryAlert exposes reason without persisting", async () => {
    const store = makeStore();
    const deps = makeDeps(store, certId);
    const noWin = await shouldFireExpiryAlert(certId, 30, deps);
    expect(noWin).toEqual({ fire: false, window: null, reason: "no-window" });

    // Reserve to populate
    await reserveExpiryAlertSlot(certId, 14, deps);
    const dup = await shouldFireExpiryAlert(certId, 13, deps);
    expect(dup).toEqual({ fire: false, window: 14, reason: "duplicate" });
  });
});
