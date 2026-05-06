/**
 * Feature 011 T050 — compatibility gating logic.
 *
 * Tests the pure gating function via the buildReportFromFields outputs;
 * the actual `createServer` invocation requires a DB and is exercised in
 * the T051 integration test.
 */
import { describe, it, expect } from "vitest";
import {
  CompatibilityUnresolvedError,
} from "../../server/services/server-onboarding.js";
import { buildReportFromFields } from "../../server/services/compatibility-probe.js";

// Replicate the gate predicate in the test so we catch shape drift.
function gateOnCompatibility(
  report: { checks: { id: string; status: "pass" | "warn" | "fail" }[] },
  acknowledged: ReadonlySet<string>,
): { fails: string[]; unackedWarns: string[] } {
  return {
    fails: report.checks
      .filter((c) => c.status === "fail")
      .map((c) => c.id),
    unackedWarns: report.checks
      .filter((c) => c.status === "warn" && !acknowledged.has(c.id))
      .map((c) => c.id),
  };
}

const PASS_FIELDS = {
  SSH_OK: "true",
  SUDO_NOPASSWD: "true",
  USE_PTY: "false",
  DOCKER: "26.1.0",
  DISK_FREE_GB: "50",
  SWAP: "true",
  OS_FAMILY: "debian",
  OS_VERSION: "22.04",
  ARCH: "x86_64",
};

describe("server-onboarding gating", () => {
  it("a fully-pass report passes the gate with no acknowledgements", () => {
    const r = buildReportFromFields(PASS_FIELDS, "vanilla");
    const g = gateOnCompatibility(r, new Set());
    expect(g.fails).toEqual([]);
    expect(g.unackedWarns).toEqual([]);
  });

  it("a fail row blocks regardless of acknowledgements", () => {
    const r = buildReportFromFields(
      { ...PASS_FIELDS, DISK_FREE_GB: "2" },
      "vanilla",
    );
    const ackAll = new Set(r.checks.map((c) => c.id));
    const g = gateOnCompatibility(r, ackAll);
    expect(g.fails).toContain("disk.free");
  });

  it("warn rows must be acknowledged", () => {
    const r = buildReportFromFields(
      { ...PASS_FIELDS, DOCKER: "" },
      "vanilla",
    );
    const empty = gateOnCompatibility(r, new Set());
    expect(empty.unackedWarns).toContain("docker.present");
    const acked = gateOnCompatibility(r, new Set(["docker.present"]));
    expect(acked.unackedWarns).toEqual([]);
  });

  it("CompatibilityUnresolvedError carries detail lists", () => {
    const e = new CompatibilityUnresolvedError({
      unresolvedFails: ["disk.free"],
      unacknowledgedWarns: ["docker.present"],
    });
    expect(e.details.unresolvedFails).toEqual(["disk.free"]);
    expect(e.details.unacknowledgedWarns).toEqual(["docker.present"]);
  });
});
