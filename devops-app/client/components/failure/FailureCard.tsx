/** Feature 010 T023 — unified failure surface (FailureCard). */
import React from "react";
import type { ReactNode } from "react";
import { FailureActionButton } from "./FailureActionButton.js";

export type ActionTrigger =
  | { type: "navigate"; href: string }
  | { type: "callback"; onClick: () => void };

export type DestructiveTrigger = Extract<ActionTrigger, { type: "callback" }>;
export type NavTrigger = Extract<ActionTrigger, { type: "navigate" }>;

export type FailureAction =
  | { kind: "Retry"; trigger: ActionTrigger }
  | { kind: "RetryFromFailedStep"; fromStep: string; trigger: ActionTrigger }
  | { kind: "EditConfig"; trigger: NavTrigger }
  | { kind: "ViewLog"; trigger: NavTrigger }
  | { kind: "HardDelete"; trigger: DestructiveTrigger }
  | { kind: "ForceDelete"; trigger: DestructiveTrigger }
  | { kind: "ForceRenew"; trigger: DestructiveTrigger }
  | { kind: "Custom"; label: string; trigger: ActionTrigger };

export interface FailureCardProps {
  state: string;
  summary: string;
  details?: ReactNode;
  actions?: FailureAction[];
}

const ICON_MAP: Record<string, string> = {
  failed: "⚠",
  deploy_timeout: "⏰",
  failed_clone: "📦",
  failed_compose: "🔧",
  failed_healthcheck: "⚠",
  failed_proxy: "🌐",
  failed_cert: "🔒",
  failed_clone_pat_expired: "🔑",
  cert_failed: "🔒",
  cert_rate_limited: "⏰",
  cert_pending_reconcile: "🔧",
  http_probe_blocked: "🌐",
  caddy_unreachable: "🌐",
  pre_destroy_hook_failed: "🔧",
};

export function FailureCard({ state, summary, details, actions }: FailureCardProps) {
  const icon = ICON_MAP[state] ?? "⚠";
  return (
    <div className="rounded border-2 border-red-500 bg-red-950/20 p-3 space-y-2">
      <h3 className="text-sm font-semibold text-red-200 flex items-center gap-2">
        <span aria-hidden="true">{icon}</span>
        {summary}
      </h3>
      {details && <div className="text-xs text-red-100">{details}</div>}
      {actions && actions.length > 0 && (
        <div className="flex justify-end gap-2 pt-2 border-t border-red-900">
          {actions.map((a, i) => (
            <FailureActionButton key={`${a.kind}-${i}`} action={a} />
          ))}
        </div>
      )}
    </div>
  );
}
