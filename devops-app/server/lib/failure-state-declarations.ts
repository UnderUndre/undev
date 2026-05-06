/**
 * Feature 010 T008 — pure-data state→{icon, defaultActionKinds} registry.
 *
 * Lives on the server (zero React, zero callbacks, zero client routes) per
 * Session 2026-05-05 review G-P0-2. The client consumes this registry via
 * `client/lib/failure-state-wiring.ts` to produce wired `FailureAction[]`.
 *
 * Registry invariant (asserted by `failure-state-declarations.test.ts`):
 *   - Every `bootstrap_state` value matching `^failed_/` from feature 009
 *     has a declaration entry.
 *   - `pre_destroy_hook_failed` declaration exists (Session 2026-05-05 GE-2).
 *   - `RetryFromFailedStep` declarations always include `fromStep`.
 *   - `Custom` declarations always include `customLabel`.
 *   - `Revoke` is NOT in the FailureActionKind enum (G-P0-4).
 */

export type FailureActionKind =
  | "Retry"
  | "RetryFromFailedStep"
  | "EditConfig"
  | "ViewLog"
  | "HardDelete"
  | "ForceDelete"
  | "ForceRenew"
  | "Custom";

export type FailureIcon =
  | "clock"
  | "network"
  | "shield"
  | "wrench"
  | "alert"
  | "package"
  | "lock";

export type FailureContextKind = "deploy" | "bootstrap" | "cert" | "health";

export interface FailureStateDeclaration {
  icon: FailureIcon;
  applicableContexts: ReadonlyArray<FailureContextKind>;
  defaultActionKinds: ReadonlyArray<FailureActionKind>;
  /** Resolved step for RetryFromFailedStep variants — bootstrap chain. */
  fromStep?: string;
  /** Freeform label for Custom variants. */
  customLabel?: string;
}

export const FAILURE_STATE_DECLARATIONS: Readonly<Record<string, FailureStateDeclaration>> = {
  // Deploy failures (job-status driven)
  failed: {
    icon: "alert",
    applicableContexts: ["deploy"],
    defaultActionKinds: ["Retry", "ViewLog"],
  },
  deploy_timeout: {
    icon: "clock",
    applicableContexts: ["deploy"],
    defaultActionKinds: ["Retry", "EditConfig"],
  },

  // Bootstrap failures (feature 009 state machine)
  failed_clone: {
    icon: "package",
    applicableContexts: ["bootstrap"],
    defaultActionKinds: ["RetryFromFailedStep", "EditConfig", "HardDelete"],
    fromStep: "cloning",
  },
  failed_compose: {
    icon: "wrench",
    applicableContexts: ["bootstrap"],
    defaultActionKinds: ["RetryFromFailedStep", "EditConfig", "HardDelete"],
    fromStep: "compose_up",
  },
  failed_healthcheck: {
    icon: "alert",
    applicableContexts: ["bootstrap"],
    defaultActionKinds: ["RetryFromFailedStep", "ViewLog", "HardDelete"],
    fromStep: "healthcheck",
  },
  failed_proxy: {
    icon: "network",
    applicableContexts: ["bootstrap"],
    defaultActionKinds: ["RetryFromFailedStep", "EditConfig"],
    fromStep: "proxy_applied",
  },
  failed_cert: {
    icon: "lock",
    applicableContexts: ["bootstrap"],
    defaultActionKinds: ["RetryFromFailedStep", "EditConfig"],
    fromStep: "cert_issued",
  },
  failed_clone_pat_expired: {
    icon: "lock",
    applicableContexts: ["bootstrap"],
    defaultActionKinds: ["Custom", "RetryFromFailedStep"],
    fromStep: "cloning",
    customLabel: "Reconnect GitHub",
  },

  // Cert failures (feature 008)
  cert_failed: {
    icon: "lock",
    applicableContexts: ["cert"],
    defaultActionKinds: ["ForceRenew", "EditConfig"],
  },
  cert_rate_limited: {
    icon: "clock",
    applicableContexts: ["cert"],
    defaultActionKinds: ["ViewLog"],
  },
  cert_pending_reconcile: {
    icon: "wrench",
    applicableContexts: ["cert"],
    defaultActionKinds: ["ForceRenew"],
  },

  // Health failures (feature 006)
  http_probe_blocked: {
    icon: "network",
    applicableContexts: ["health"],
    defaultActionKinds: ["EditConfig", "ViewLog"],
  },
  caddy_unreachable: {
    icon: "network",
    applicableContexts: ["health"],
    defaultActionKinds: ["Custom"],
    customLabel: "Open Caddy admin",
  },

  // Hard-delete failure recovery
  pre_destroy_hook_failed: {
    icon: "wrench",
    applicableContexts: ["deploy"],
    defaultActionKinds: ["Retry", "ForceDelete"],
  },
};

/**
 * The 9 bootstrap-state failed_* variants from feature 009.
 * Used by tests to assert registry coverage.
 */
export const FEATURE_009_FAILED_STATES: ReadonlyArray<string> = [
  "failed_clone",
  "failed_clone_pat_expired",
  "failed_compose",
  "failed_healthcheck",
  "failed_proxy",
  "failed_cert",
];
