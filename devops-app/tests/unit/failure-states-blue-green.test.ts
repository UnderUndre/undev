/**
 * T042 — failure-state-declarations registry coverage for feature 012.
 *
 * Asserts the 4 new entries land in the registry with correct shape per
 * contracts/state-machine.md § FailureCard mount mapping.
 */
import { describe, it, expect } from "vitest";
import { FAILURE_STATE_DECLARATIONS } from "../../server/lib/failure-state-declarations.js";

describe("feature 012 failure-state declarations", () => {
  const expectedStates = [
    "candidate_healthcheck_failed",
    "aborted_during_drain",
    "caddy_admin_failure_post_switch",
    "deploy_interrupted_by_restart",
  ] as const;

  for (const state of expectedStates) {
    it(`registry has '${state}' with deploy context`, () => {
      const decl = FAILURE_STATE_DECLARATIONS[state];
      expect(decl).toBeDefined();
      expect(decl?.applicableContexts).toContain("deploy");
      expect(decl?.defaultActionKinds.length).toBeGreaterThan(0);
    });
  }

  it("candidate_healthcheck_failed → Retry / EditConfig / ViewLog", () => {
    const decl = FAILURE_STATE_DECLARATIONS.candidate_healthcheck_failed;
    expect(decl?.defaultActionKinds).toEqual(["Retry", "EditConfig", "ViewLog"]);
  });

  it("Custom-action states carry customLabel", () => {
    const post = FAILURE_STATE_DECLARATIONS.caddy_admin_failure_post_switch;
    expect(post?.defaultActionKinds).toContain("Custom");
    expect(post?.customLabel).toBeDefined();
  });
});
