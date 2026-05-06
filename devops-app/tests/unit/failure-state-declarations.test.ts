/** Feature 010 T009 — failure-state-declarations registry invariants. */
import { describe, it, expect } from "vitest";
import {
  FAILURE_STATE_DECLARATIONS,
  FEATURE_009_FAILED_STATES,
  type FailureActionKind,
} from "../../server/lib/failure-state-declarations.js";

describe("FAILURE_STATE_DECLARATIONS", () => {
  it("every entry has at least one defaultActionKind", () => {
    for (const [state, decl] of Object.entries(FAILURE_STATE_DECLARATIONS)) {
      expect(
        decl.defaultActionKinds.length,
        `state ${state} must declare ≥1 defaultActionKinds`,
      ).toBeGreaterThanOrEqual(1);
    }
  });

  it("every feature 009 failed_* state has an entry", () => {
    for (const s of FEATURE_009_FAILED_STATES) {
      expect(FAILURE_STATE_DECLARATIONS[s], `state ${s} must be registered`).toBeDefined();
    }
  });

  it("pre_destroy_hook_failed entry exists with Retry+ForceDelete", () => {
    const d = FAILURE_STATE_DECLARATIONS.pre_destroy_hook_failed;
    expect(d).toBeDefined();
    expect(d?.defaultActionKinds).toEqual(["Retry", "ForceDelete"]);
  });

  it("RetryFromFailedStep declarations include fromStep", () => {
    for (const [state, decl] of Object.entries(FAILURE_STATE_DECLARATIONS)) {
      if (decl.defaultActionKinds.includes("RetryFromFailedStep")) {
        expect(decl.fromStep, `state ${state} needs fromStep`).toBeDefined();
      }
    }
  });

  it("Custom declarations include customLabel", () => {
    for (const [state, decl] of Object.entries(FAILURE_STATE_DECLARATIONS)) {
      if (decl.defaultActionKinds.includes("Custom")) {
        expect(decl.customLabel, `state ${state} needs customLabel`).toBeDefined();
      }
    }
  });

  it("Revoke is NOT in the FailureActionKind enum", () => {
    // TypeScript-enforced. Runtime guard: assert no declaration uses Revoke.
    const ALL_KINDS: FailureActionKind[] = [
      "Retry",
      "RetryFromFailedStep",
      "EditConfig",
      "ViewLog",
      "HardDelete",
      "ForceDelete",
      "ForceRenew",
      "Custom",
    ];
    expect(ALL_KINDS as ReadonlyArray<string>).not.toContain("Revoke");
    for (const decl of Object.values(FAILURE_STATE_DECLARATIONS)) {
      for (const k of decl.defaultActionKinds) {
        expect(k as string).not.toBe("Revoke");
      }
    }
  });

  it("cert_failed declares ForceRenew but not Revoke", () => {
    const d = FAILURE_STATE_DECLARATIONS.cert_failed;
    expect(d?.defaultActionKinds).toContain("ForceRenew");
    expect(d?.defaultActionKinds).not.toContain("Revoke" as never);
  });
});
