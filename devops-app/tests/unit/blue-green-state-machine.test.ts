import { describe, it, expect } from "vitest";
import {
  TRANSITIONS,
  canTransition,
  findTransition,
  oppositeColor,
  type Phase,
  type PhaseOrIdle,
} from "../../server/lib/blue-green-state-machine.js";

const ALL_PHASES: Phase[] = [
  "CANDIDATE_STARTING",
  "CANDIDATE_HEALTHY",
  "SWITCHING",
  "OUTGOING_DRAINING",
  "OUTGOING_STOPPED",
  "ACTIVE",
  "FAILED_CANDIDATE_HEALTHCHECK",
  "FAILED_SWITCH",
  "FAILED_DRAIN_ABORT",
  "FAILED_CADDY_ADMIN_POST_SWITCH",
];

describe("blue-green-state-machine", () => {
  it("every transition has all required fields populated", () => {
    for (const t of TRANSITIONS) {
      expect(typeof t.trigger).toBe("string");
      expect(t.trigger.length).toBeGreaterThan(0);
      expect(typeof t.requiresOperatorAction).toBe("boolean");
      expect(typeof t.resetsDrainTimer).toBe("boolean");
      expect(typeof t.pausesDrainTimer).toBe("boolean");
      expect(typeof t.resumesDrainTimer).toBe("boolean");
      expect(typeof t.emitsAuditEvent).toBe("string");
    }
  });

  it("canTransition() true for documented transitions", () => {
    for (const t of TRANSITIONS) {
      expect(canTransition(t.from, t.to)).toBe(true);
    }
  });

  it("canTransition() false for non-documented transitions", () => {
    const invalidPairs: ReadonlyArray<[PhaseOrIdle, PhaseOrIdle]> = [
      ["ACTIVE", "CANDIDATE_STARTING"],
      ["CANDIDATE_STARTING", "OUTGOING_DRAINING"],
      ["SWITCHING", "OUTGOING_STOPPED"],
      ["FAILED_DRAIN_ABORT", "OUTGOING_DRAINING"],
      [null, "ACTIVE"],
    ];
    for (const [from, to] of invalidPairs) {
      expect(canTransition(from, to)).toBe(false);
    }
  });

  it("no transition has both pausesDrainTimer and resumesDrainTimer", () => {
    for (const t of TRANSITIONS) {
      expect(t.pausesDrainTimer && t.resumesDrainTimer).toBe(false);
    }
  });

  it("every Phase appears as both from and to somewhere", () => {
    for (const phase of ALL_PHASES) {
      const asFrom = TRANSITIONS.some((t) => t.from === phase);
      const asTo = TRANSITIONS.some((t) => t.to === phase);
      expect(asFrom, `${phase} as from`).toBe(true);
      expect(asTo, `${phase} as to`).toBe(true);
    }
  });

  it("every FAILED_* state has at least one outgoing transition", () => {
    const failed = ALL_PHASES.filter((p) => p.startsWith("FAILED_"));
    for (const f of failed) {
      const out = TRANSITIONS.filter((t) => t.from === f);
      expect(out.length, `${f} has outgoing transitions`).toBeGreaterThan(0);
    }
  });

  it("findTransition returns the transition or undefined", () => {
    expect(findTransition(null, "CANDIDATE_STARTING")?.trigger).toBe(
      "operator_clicked_deploy",
    );
    expect(findTransition("ACTIVE", "CANDIDATE_STARTING")).toBeUndefined();
  });

  it("oppositeColor flips blue/green", () => {
    expect(oppositeColor("blue")).toBe("green");
    expect(oppositeColor("green")).toBe("blue");
  });
});
