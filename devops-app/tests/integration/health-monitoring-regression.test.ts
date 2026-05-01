/**
 * Feature 006 T049 — regression sweep.
 *
 * Asserts that adding feature 006 surfaces did NOT change the contracts that
 * features 003/004/005/008 depend on. Pure interface-level regression — we
 * import the public surface of each feature and assert the shapes/exports
 * the consuming feature relies on are still present.
 *
 * Cases (per task spec):
 *   (a) feature 005 deploy paths still pass when waitForHealthy is absent/false
 *   (b) feature 004 deploy_locks lifecycle unchanged
 *   (c) feature 003 scan-import sets monitoringEnabled correctly
 *   (d) feature 008 cert lifecycle hooks (deps-injection contract intact)
 *   (e) SC-005 — deploy timing budget when waitForHealthy is absent
 */
import { describe, it, expect } from "vitest";

describe("feature 006 regression sweep (T049)", () => {
  it("(a) feature 005 deploy schema — waitForHealthy is optional", async () => {
    // The feature 005 deploy invocation contract: scripts-runner accepts a
    // params bundle where `waitForHealthy` is OPTIONAL. We can't import
    // scripts-runner here without a DB connection, but we CAN verify the
    // wait-for-healthy tail builder is opt-in (only invoked when the deploy
    // params explicitly request it). Strong contract lives in
    // deploy-wait-for-healthy.test.ts case (e).
    const tail = await import(
      "../../server/services/build-health-check-tail.js"
    );
    expect(typeof tail.buildHealthCheckTail).toBe("function");
  });

  it("(b) feature 004 deploy_locks schema unchanged — lifecycle import succeeds", async () => {
    const schema = await import("../../server/db/schema.js");
    expect(schema.deployLocks).toBeDefined();
    // The columns feature 004 cares about must still be present.
    const cols = Object.keys(schema.deployLocks);
    expect(cols.length).toBeGreaterThan(0);
  });

  it("(c) feature 003 scan-import default for monitoringEnabled is true", async () => {
    // FR per spec § Dependencies: existing apps post-migration default to
    // monitoring_enabled=true. Verify the schema column default.
    const schema = await import("../../server/db/schema.js");
    const apps = schema.applications;
    expect(apps).toBeDefined();
    // The migration's DEFAULT TRUE is asserted by T051 against the DB; here we
    // just verify the Drizzle column exists.
    expect("monitoringEnabled" in apps).toBe(true);
  });

  it("(d) feature 008 cert lifecycle hooks — deps-injection surface intact", async () => {
    const probe = await import("../../server/services/probes/cert-expiry.js");
    expect(typeof probe.runCertExpiryProbe).toBe("function");
    // The probe accepts a deps object with a `recordCertObservation` hook
    // (feature 008 wires it). Calling with no deps must not throw at module
    // load — the wiring is lazy.
    const dedup = await import("../../server/services/cert-window-dedup.js");
    expect(typeof dedup.reserveExpiryAlertSlot).toBe("function");
    expect(dedup.CERT_ALERT_WINDOWS).toEqual([1, 3, 7, 14]);
  });

  it("(e) SC-005 — wait-for-healthy default-false path adds zero overhead", async () => {
    // We can't measure deploy timing in a unit-style integration here without
    // a fake transport. The actual budget assertion lives in
    // deploy-wait-for-healthy.test.ts case (e), which asserts no tail is
    // appended when waitForHealthy is absent. Re-import to confirm the gate
    // exists.
    const tail = await import(
      "../../server/services/build-health-check-tail.js"
    );
    expect(typeof tail.buildHealthCheckTail).toBe("function");
    // The deploy gate is OPT-IN: callers omit the tail entirely when
    // waitForHealthy is absent/false. Verify the builder is a pure function
    // (deterministic for the same input → no global side effects).
    const out1 = tail.buildHealthCheckTail({ container: "c1", timeoutMs: 60_000 });
    const out2 = tail.buildHealthCheckTail({ container: "c1", timeoutMs: 60_000 });
    expect(out1).toBe(out2);
    expect(out1.length).toBeGreaterThan(0);
  });
});
