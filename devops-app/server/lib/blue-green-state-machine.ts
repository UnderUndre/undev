/**
 * Feature 012 T007 — pure-data state machine for blue/green deploy phases.
 *
 * Lives server-side. Zero React, zero DB, zero side effects. Consumed by
 * `blue-green-orchestrator.ts` to validate every transition and by
 * tests to assert invariants per `contracts/state-machine.md`.
 */

export type Phase =
  | "CANDIDATE_STARTING"
  | "CANDIDATE_HEALTHY"
  | "SWITCHING"
  | "OUTGOING_DRAINING"
  | "OUTGOING_STOPPED"
  | "ACTIVE"
  | "FAILED_CANDIDATE_HEALTHCHECK"
  | "FAILED_SWITCH"
  | "FAILED_DRAIN_ABORT"
  | "FAILED_CADDY_ADMIN_POST_SWITCH";

export type PhaseOrIdle = Phase | null;

export interface Transition {
  from: PhaseOrIdle;
  to: PhaseOrIdle;
  trigger: string;
  requiresOperatorAction: boolean;
  resetsDrainTimer: boolean;
  pausesDrainTimer: boolean;
  resumesDrainTimer: boolean;
  emitsAuditEvent: string;
}

export const TRANSITIONS: ReadonlyArray<Transition> = [
  // Happy path
  {
    from: null,
    to: "CANDIDATE_STARTING",
    trigger: "operator_clicked_deploy",
    requiresOperatorAction: false,
    resetsDrainTimer: false,
    pausesDrainTimer: false,
    resumesDrainTimer: false,
    emitsAuditEvent: "deploy.blue_green_started",
  },
  {
    from: "CANDIDATE_STARTING",
    to: "CANDIDATE_HEALTHY",
    trigger: "compose_healthcheck_pass",
    requiresOperatorAction: false,
    resetsDrainTimer: false,
    pausesDrainTimer: false,
    resumesDrainTimer: false,
    emitsAuditEvent: "deploy.candidate_healthy",
  },
  {
    from: "CANDIDATE_HEALTHY",
    to: "SWITCHING",
    trigger: "orchestrator_initiated_switch",
    requiresOperatorAction: false,
    resetsDrainTimer: false,
    pausesDrainTimer: false,
    resumesDrainTimer: false,
    emitsAuditEvent: "deploy.switching_started",
  },
  {
    from: "SWITCHING",
    to: "OUTGOING_DRAINING",
    trigger: "caddy_post_load_2xx",
    requiresOperatorAction: false,
    resetsDrainTimer: true,
    pausesDrainTimer: false,
    resumesDrainTimer: false,
    emitsAuditEvent: "deploy.traffic_switched",
  },
  {
    from: "OUTGOING_DRAINING",
    to: "OUTGOING_STOPPED",
    trigger: "drain_timer_elapsed",
    requiresOperatorAction: false,
    resetsDrainTimer: false,
    pausesDrainTimer: false,
    resumesDrainTimer: false,
    emitsAuditEvent: "deploy.drained",
  },
  {
    from: "OUTGOING_STOPPED",
    to: "ACTIVE",
    trigger: "outgoing_container_stopped_and_active_color_flipped",
    requiresOperatorAction: false,
    resetsDrainTimer: false,
    pausesDrainTimer: false,
    resumesDrainTimer: false,
    emitsAuditEvent: "deploy.outgoing_stopped",
  },
  {
    from: "ACTIVE",
    to: null,
    trigger: "cleanup_complete",
    requiresOperatorAction: false,
    resetsDrainTimer: false,
    pausesDrainTimer: false,
    resumesDrainTimer: false,
    emitsAuditEvent: "deploy.blue_green_succeeded",
  },

  // Failure paths
  {
    from: "CANDIDATE_STARTING",
    to: "FAILED_CANDIDATE_HEALTHCHECK",
    trigger: "compose_healthcheck_timeout_or_exit",
    requiresOperatorAction: false,
    resetsDrainTimer: false,
    pausesDrainTimer: false,
    resumesDrainTimer: false,
    emitsAuditEvent: "deploy.candidate_failed_rollback",
  },
  {
    from: "SWITCHING",
    to: "FAILED_SWITCH",
    trigger: "caddy_post_load_failed",
    requiresOperatorAction: false,
    resetsDrainTimer: false,
    pausesDrainTimer: false,
    resumesDrainTimer: false,
    emitsAuditEvent: "deploy.caddy_admin_failure_pre_switch",
  },
  {
    from: "OUTGOING_DRAINING",
    to: "FAILED_CADDY_ADMIN_POST_SWITCH",
    trigger: "caddy_admin_dropped_mid_drain",
    requiresOperatorAction: false,
    resetsDrainTimer: false,
    pausesDrainTimer: true,
    resumesDrainTimer: false,
    emitsAuditEvent: "deploy.caddy_admin_failure_post_switch",
  },
  {
    from: "OUTGOING_DRAINING",
    to: "FAILED_DRAIN_ABORT",
    trigger: "operator_aborted",
    requiresOperatorAction: true,
    resetsDrainTimer: false,
    pausesDrainTimer: false,
    resumesDrainTimer: false,
    emitsAuditEvent: "deploy.aborted",
  },

  // Recovery from caddy admin post-switch failure
  {
    from: "FAILED_CADDY_ADMIN_POST_SWITCH",
    to: "OUTGOING_DRAINING",
    trigger: "operator_marked_recovered_or_retry_healthcheck_pass",
    requiresOperatorAction: true,
    resetsDrainTimer: false,
    pausesDrainTimer: false,
    resumesDrainTimer: true,
    emitsAuditEvent: "deploy.caddy_admin_recovered",
  },
  {
    from: "FAILED_CADDY_ADMIN_POST_SWITCH",
    to: "FAILED_DRAIN_ABORT",
    trigger: "operator_aborted_during_caddy_recovery",
    requiresOperatorAction: true,
    resetsDrainTimer: false,
    pausesDrainTimer: false,
    resumesDrainTimer: false,
    emitsAuditEvent: "deploy.aborted",
  },

  // Cleanup paths (failed → null when operator clears)
  {
    from: "FAILED_CANDIDATE_HEALTHCHECK",
    to: null,
    trigger: "operator_clicked_retry_or_cleanup",
    requiresOperatorAction: true,
    resetsDrainTimer: false,
    pausesDrainTimer: false,
    resumesDrainTimer: false,
    emitsAuditEvent: "deploy.failure_cleared",
  },
  {
    from: "FAILED_SWITCH",
    to: null,
    trigger: "operator_clicked_retry_or_cleanup",
    requiresOperatorAction: true,
    resetsDrainTimer: false,
    pausesDrainTimer: false,
    resumesDrainTimer: false,
    emitsAuditEvent: "deploy.failure_cleared",
  },
  {
    from: "FAILED_DRAIN_ABORT",
    to: null,
    trigger: "abort_cleanup_complete",
    requiresOperatorAction: false,
    resetsDrainTimer: false,
    pausesDrainTimer: false,
    resumesDrainTimer: false,
    emitsAuditEvent: "deploy.failure_cleared",
  },
];

export function canTransition(from: PhaseOrIdle, to: PhaseOrIdle): boolean {
  return TRANSITIONS.some((t) => t.from === from && t.to === to);
}

export function findTransition(
  from: PhaseOrIdle,
  to: PhaseOrIdle,
): Transition | undefined {
  return TRANSITIONS.find((t) => t.from === from && t.to === to);
}

export function oppositeColor(c: "blue" | "green"): "blue" | "green" {
  return c === "blue" ? "green" : "blue";
}
