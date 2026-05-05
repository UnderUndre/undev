/** Feature 009 T045 — bootstrap state badge for AppsList. */
import React from "react";
import type { BootstrapState } from "../../lib/bootstrap-api.js";

const IN_FLIGHT: BootstrapState[] = [
  "init",
  "cloning",
  "compose_up",
  "healthcheck",
  "proxy_applied",
  "cert_issued",
];

export interface BootstrapStateBadgeProps {
  state: BootstrapState;
  connectionId?: string | null;
}

export function BootstrapStateBadge({ state, connectionId }: BootstrapStateBadgeProps) {
  if (state === "active") return null;

  if (state === "failed_clone_pat_expired") {
    const href = connectionId ? `/settings#github?connectionId=${connectionId}` : "/settings#github";
    return (
      <span
        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-red-950 border border-red-700 text-red-300 text-xs"
        title="GitHub authentication failed"
      >
        <span aria-hidden="true">🔑</span>
        <a href={href} className="underline">Reconnect GitHub</a>
      </span>
    );
  }

  if (state.startsWith("failed_")) {
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
