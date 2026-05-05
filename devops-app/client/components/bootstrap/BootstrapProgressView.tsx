/** Feature 009 T027 — live bootstrap progress driven by useBootstrapState. */
import React from "react";
import { useBootstrapState } from "../../hooks/useBootstrapState.js";
import { bootstrapApi, type BootstrapStep } from "../../lib/bootstrap-api.js";

export interface BootstrapProgressViewProps {
  appId: string;
  onClose: () => void;
}

const STEP_ORDER: Array<{ key: string; label: string; failed: string }> = [
  { key: "cloning", label: "Clone", failed: "failed_clone" },
  { key: "compose_up", label: "Compose up", failed: "failed_compose" },
  { key: "healthcheck", label: "Healthcheck", failed: "failed_healthcheck" },
  { key: "proxy_applied", label: "Proxy", failed: "failed_proxy" },
  { key: "cert_issued", label: "TLS cert", failed: "failed_cert" },
  { key: "active", label: "Active", failed: "" },
];

export function BootstrapProgressView({ appId, onClose }: BootstrapProgressViewProps) {
  const { state, logs, error, refresh } = useBootstrapState(appId);

  const currentIndex = state ? STEP_ORDER.findIndex((s) => s.key === state.bootstrapState) : 0;
  const failedIndex = state
    ? STEP_ORDER.findIndex((s) => s.failed === state.bootstrapState)
    : -1;
  const isPatExpired = state?.bootstrapState === "failed_clone_pat_expired";

  const retry = async (fromStep: BootstrapStep) => {
    try {
      await bootstrapApi.retryFromStep(appId, fromStep);
      await refresh();
    } catch (err) {
      // surfaced via state.error on next refresh
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Bootstrap progress"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70"
    >
      <div className="bg-gray-900 border border-gray-700 rounded-lg p-5 w-full max-w-2xl space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Bootstrap progress — {state?.name ?? appId}</h2>
          <button type="button" onClick={onClose} className="text-gray-400 text-sm">×</button>
        </div>
        {error && <div className="text-red-400 text-xs">{error}</div>}

        <ol className="grid grid-cols-6 gap-2 text-xs">
          {STEP_ORDER.map((s, i) => {
            const reached =
              currentIndex >= i ||
              state?.bootstrapState === "active" ||
              (failedIndex !== -1 && failedIndex >= i);
            const isCurrent = state?.bootstrapState === s.key;
            const isFailed = state?.bootstrapState === s.failed;
            return (
              <li
                key={s.key}
                className={`rounded border px-2 py-1 text-center ${
                  isFailed
                    ? "border-red-600 bg-red-950/40 text-red-300"
                    : isCurrent
                    ? "border-blue-500 bg-blue-950/30 text-blue-300 animate-pulse"
                    : reached
                    ? "border-green-700 bg-green-950/30 text-green-300"
                    : "border-gray-700 text-gray-500"
                }`}
              >
                {s.label}
              </li>
            );
          })}
        </ol>

        {isPatExpired && (
          <div className="rounded border border-red-700 bg-red-950/40 px-3 py-2 text-sm text-red-300">
            <p className="font-semibold">GitHub authentication failed</p>
            <p className="text-xs mt-1">
              The PAT is expired or lacks repo scope. Reconnect GitHub in Settings, then retry.
            </p>
            <div className="flex gap-2 mt-2">
              <a
                href="/settings#github"
                className="px-3 py-1 rounded bg-red-800 text-xs"
              >
                Reconnect GitHub
              </a>
              <button
                type="button"
                className="px-3 py-1 rounded bg-gray-700 text-xs"
                title="Re-save the GitHub connection first"
                disabled
              >
                Retry
              </button>
            </div>
          </div>
        )}

        {state?.bootstrapState.startsWith("failed_") && !isPatExpired && (
          <div className="rounded border border-red-700 bg-red-950/40 px-3 py-2 text-sm text-red-300 flex justify-between items-center">
            <span>Failed at <code>{state.bootstrapState.replace("failed_", "")}</code></span>
            <button
              type="button"
              className="px-3 py-1 rounded bg-red-800 text-xs"
              onClick={() =>
                void retry(state.bootstrapState.replace("failed_", "") as BootstrapStep)
              }
            >
              Retry
            </button>
          </div>
        )}

        <div className="bg-black border border-gray-800 rounded p-2 text-xs font-mono h-48 overflow-y-auto">
          {logs.length === 0 ? (
            <div className="text-gray-600">Waiting for output…</div>
          ) : (
            logs.map((l, i) => (
              <div key={i} className="text-gray-300">
                <span className="text-gray-600">[{l.scriptId.replace("bootstrap/", "")}]</span> {l.line}
              </div>
            ))
          )}
        </div>

        <div className="flex justify-end">
          <button type="button" onClick={onClose} className="px-3 py-1 rounded bg-gray-700 text-sm">
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
