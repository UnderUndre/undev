/** Feature 009 T045 + Feature 010 T027 — bootstrap state badge / FailureCard. */
import React from "react";
import type { BootstrapState } from "../../lib/bootstrap-api.js";
import { FailureCard } from "../failure/FailureCard.js";
import { wireActions } from "../../lib/failure-state-wiring.js";
import { useFailureCallbacks } from "../../hooks/useFailureCallbacks.js";

const IN_FLIGHT: BootstrapState[] = [
  "init",
  "cloning",
  "compose_up",
  "healthcheck",
  "proxy_applied",
  "cert_issued",
];

const STATE_SUMMARY: Record<string, string> = {
  failed_clone: "Clone failed",
  failed_clone_pat_expired: "GitHub authentication failed",
  failed_compose: "docker compose up failed",
  failed_healthcheck: "Healthcheck did not turn healthy",
  failed_proxy: "Caddy attach failed",
  failed_cert: "TLS issuance failed",
};

export interface BootstrapStateBadgeProps {
  state: BootstrapState;
  /**
   * When provided, the badge expands to a `<FailureCard>` for failed_* states
   * (T027). Without `appId` we keep the legacy compact-pill rendering — used
   * by the apps list where the badge sits inline next to a row.
   */
  appId?: string;
  connectionId?: string | null;
}

export function BootstrapStateBadge({ state, appId, connectionId }: BootstrapStateBadgeProps) {
  if (state === "active") return null;

  if (state.startsWith("failed_")) {
    if (appId) {
      return <FailureCardForBootstrap state={state} appId={appId} />;
    }
    // Legacy compact pill — used in the apps list.
    if (state === "failed_clone_pat_expired") {
      const href = connectionId
        ? `/settings#github?connectionId=${connectionId}`
        : "/settings#github";
      return (
        <span
          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-red-950 border border-red-700 text-red-300 text-xs"
          title="GitHub authentication failed"
        >
          <span aria-hidden="true">🔑</span>
          <a href={href} className="underline">
            Reconnect GitHub
          </a>
        </span>
      );
    }
    const stepLabel = state.replace(/^failed_/, "");
    return (
      <span
        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-red-950 border border-red-700 text-red-300 text-xs"
        title={`Failed at ${stepLabel}`}
      >
        <span aria-hidden="true">!</span>
        Failed: {stepLabel}
      </span>
    );
  }

  if (IN_FLIGHT.includes(state)) {
    return (
      <span
        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-yellow-950/40 border border-yellow-600 text-yellow-300 text-xs"
        title={`Bootstrapping: ${state}`}
      >
        <span
          aria-hidden="true"
          className="inline-block w-2 h-2 rounded-full border-2 border-yellow-400 border-t-transparent animate-spin"
        />
        {state}
      </span>
    );
  }

  return null;
}

function FailureCardForBootstrap({ state, appId }: { state: BootstrapState; appId: string }) {
  const callbacks = useFailureCallbacks();
  const summary = STATE_SUMMARY[state] ?? `Bootstrap failed at ${state.replace(/^failed_/, "")}`;
  const actions = wireActions(state, { kind: "bootstrap", appId, bootstrapState: state }, callbacks);
  return <FailureCard state={state} summary={summary} actions={actions} />;
}
