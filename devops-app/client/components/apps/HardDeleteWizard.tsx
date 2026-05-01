/** Feature 008 T056 — typed-confirm hard delete wizard. */
import React, { useState } from "react";
import { api, ApiError } from "../../lib/api.js";

export interface HardDeleteWizardProps {
  appId: string;
  appName: string;
  certId: string | null;
  onClose: () => void;
  onDeleted: () => void;
}

type Step = "confirm" | "executing" | "done" | "error";

export function HardDeleteWizard({
  appId,
  appName,
  certId,
  onClose,
  onDeleted,
}: HardDeleteWizardProps) {
  const [typed, setTyped] = useState("");
  const [step, setStep] = useState<Step>("confirm");
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<string>("");

  async function execute() {
    setStep("executing");
    setError(null);
    try {
      if (certId) {
        setProgress("revoking cert…");
        await api.post(`/applications/${appId}/certs/${certId}/revoke`, {
          confirmName: typed,
        });
      }
      setProgress("removing app…");
      await api.delete(`/apps/${appId}?hard=true`, {
        "X-Confirm-Name": typed,
      });
      setStep("done");
      onDeleted();
    } catch (err) {
      setStep("error");
      if (err instanceof ApiError) setError(err.message);
      else setError("Unknown error");
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Hard delete app"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70"
    >
      <div className="bg-gray-900 border border-red-800 rounded-lg p-5 w-full max-w-lg space-y-4">
        <h2 className="text-lg font-semibold text-red-400">Remove everything from server</h2>
        {step === "confirm" && (
          <>
            <p className="text-sm">
              This will revoke the TLS cert, remove the Caddy site, delete cert files, and remove
              the app row. Type the app name to confirm:
            </p>
            <input
              type="text"
              className="w-full rounded bg-gray-800 border border-gray-700 px-2 py-1 font-mono text-sm"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder={appName}
            />
            <p className="text-xs text-gray-500">
              Expected: <code>{appName}</code>
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                className="px-3 py-1 rounded bg-gray-700 text-sm"
                onClick={onClose}
              >
                Cancel
              </button>
              <button
                type="button"
                className="px-3 py-1 rounded bg-red-700 text-sm disabled:opacity-50"
                onClick={execute}
                disabled={typed !== appName}
              >
                Remove everything
              </button>
            </div>
          </>
        )}
        {step === "executing" && <p className="text-sm">{progress}</p>}
        {step === "done" && (
          <>
            <p className="text-sm text-green-400">Done.</p>
            <button
              type="button"
              className="px-3 py-1 rounded bg-gray-700 text-sm"
              onClick={onClose}
            >
              Close
            </button>
          </>
        )}
        {step === "error" && (
          <>
            <p className="text-sm text-red-400">{error}</p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                className="px-3 py-1 rounded bg-gray-700 text-sm"
                onClick={onClose}
              >
                Close
              </button>
              <button
                type="button"
                className="px-3 py-1 rounded bg-red-700 text-sm"
                onClick={execute}
              >
                Retry
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
