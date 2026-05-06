/** Feature 010 T024 — variant-aware FailureAction renderer. */
import React from "react";
import type {
  FailureAction,
  ActionTrigger,
} from "./FailureCard.js";

type ButtonKind = "primary" | "secondary" | "destructive";

const BASE = "px-3 py-1 rounded text-xs transition-colors";
const STYLES: Record<ButtonKind, string> = {
  primary: "bg-blue-700 hover:bg-blue-600 text-white",
  secondary: "bg-gray-700 hover:bg-gray-600 text-gray-100",
  destructive: "bg-red-700 hover:bg-red-600 text-white",
};

function renderTrigger(
  trigger: ActionTrigger,
  label: string,
  kind: ButtonKind,
): React.ReactElement {
  const cls = `${BASE} ${STYLES[kind]}`;
  switch (trigger.type) {
    case "navigate":
      return (
        <a href={trigger.href} className={cls}>
          {label}
        </a>
      );
    case "callback":
      return (
        <button type="button" className={cls} onClick={trigger.onClick}>
          {label}
        </button>
      );
    default: {
      const _never: never = trigger;
      // Unhandled trigger — surface via thrown error matching CLAUDE.md AGCG.
      throw new Error(`unhandled_action_trigger:${JSON.stringify(_never)}`);
    }
  }
}

export function FailureActionButton({ action }: { action: FailureAction }) {
  switch (action.kind) {
    case "Retry":
      return renderTrigger(action.trigger, "Retry", "primary");
    case "RetryFromFailedStep":
      return renderTrigger(action.trigger, `Retry from ${action.fromStep}`, "primary");
    case "EditConfig":
      return renderTrigger(action.trigger, "Edit config", "secondary");
    case "ViewLog":
      return renderTrigger(action.trigger, "View full log", "secondary");
    case "HardDelete":
      return renderTrigger(action.trigger, "Hard delete…", "destructive");
    case "ForceDelete":
      return renderTrigger(action.trigger, "Force delete (bypass hook)", "destructive");
    case "ForceRenew":
      return renderTrigger(action.trigger, "Force renew", "destructive");
    case "Custom":
      return renderTrigger(action.trigger, action.label, "secondary");
    default: {
      const _never: never = action;
      throw new Error(`unhandled_failure_action:${JSON.stringify(_never)}`);
    }
  }
}
