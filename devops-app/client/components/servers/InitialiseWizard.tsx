/**
 * Feature 011 T030 — 4-step Initialise wizard.
 *
 *   Step 1: Summary       — what Initialise will do.
 *   Step 2: Options       — deploy user, swap, UFW ports, useNoPty.
 *   Step 3: Confirm       — typed `INITIALISE` acknowledgement.
 *   Step 4: Live progress — file-tail modal subscribing to script.run.tail.
 *
 * No `dangerouslySetInnerHTML`, controlled inputs only.
 */

import React, { useState } from "react";
import { api, ApiError } from "../../lib/api.js";

interface Props {
  serverId: string;
  isOpen: boolean;
  onClose: () => void;
  defaultUseNoPty: boolean;
}

interface InitialiseResponse {
  scriptRunId: string;
  jobId: string;
  wsTopic: string;
}

export function InitialiseWizard({
  serverId,
  isOpen,
  onClose,
  defaultUseNoPty,
}: Props): React.JSX.Element | null {
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  const [deployUser, setDeployUser] = useState("deploy");
  const [swapSize, setSwapSize] = useState("2G");
  const [ufwPorts, setUfwPorts] = useState<string>("80,443");
  const [useNoPty, setUseNoPty] = useState(defaultUseNoPty);
  const [ackText, setAckText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);

  if (!isOpen) return null;

  async function handleStart() {
    setError(null);
    setSubmitting(true);
    try {
      const ports = ufwPorts
        .split(",")
        .map((s) => Number.parseInt(s.trim(), 10))
        .filter((n) => Number.isFinite(n) && n > 0 && n <= 65535);
      const r = await api.post<InitialiseResponse>(
        `/servers/${serverId}/initialise`,
        {
          deployUser,
          swapSize,
          ufwPorts: ports,
          useNoPty,
          typedAcknowledgement: "INITIALISE",
        },
      );
      setRunId(r.scriptRunId);
      setStep(4);
    } catch (err) {
      if (err instanceof ApiError) setError(`${err.code}: ${err.message}`);
      else if (err instanceof Error) setError(err.message);
      else setError("Failed to start");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget && step !== 4) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-label="Initialise server"
    >
      <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-lg mx-4 shadow-2xl">
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-800">
          <h2 className="text-lg font-semibold">Initialise server</h2>
          <button
            onClick={onClose}
            className="text-gray-500 hover:text-gray-300 text-xl leading-none"
            aria-label="Close"
          >
            &times;
          </button>
        </div>

        <div className="p-5 space-y-4">
          <ol className="flex gap-2 text-xs text-gray-500">
            {(["Summary", "Options", "Confirm", "Progress"] as const).map(
              (label, i) => {
                const n = (i + 1) as 1 | 2 | 3 | 4;
                return (
                  <li
                    key={label}
                    className={`flex-1 px-2 py-1 rounded ${
                      step === n
                        ? "bg-brand-purple text-white"
                        : "bg-gray-950 border border-gray-800"
                    }`}
                  >
                    {n}. {label}
                  </li>
                );
              },
            )}
          </ol>

          {step === 1 && (
            <div className="space-y-2 text-sm text-gray-300">
              <p>This will run <code>setup-vps.sh</code> on the target:</p>
              <ul className="list-disc pl-5 text-gray-400 text-xs space-y-1">
                <li>Install Docker, fail2ban, ufw</li>
                <li>Create the deploy user with NOPASSWD sudo</li>
                <li>Harden sshd (disable root login, password auth)</li>
                <li>Allocate swap, configure UFW, install the dashboard pubkey</li>
              </ul>
              <p className="text-xs text-yellow-400">
                Allow ~5–15 min depending on apt mirror speed.
              </p>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-3 text-sm">
              <label className="block">
                <span className="text-xs uppercase text-gray-500">Deploy user</span>
                <input
                  type="text"
                  value={deployUser}
                  onChange={(e) => setDeployUser(e.target.value)}
                  pattern="^[a-z][a-z0-9_-]{0,31}$"
                  className="w-full bg-gray-950 border border-gray-700 rounded px-2 py-1.5 text-sm"
                />
              </label>
              <div className="grid grid-cols-2 gap-3">
                <label className="block">
                  <span className="text-xs uppercase text-gray-500">Swap</span>
                  <input
                    type="text"
                    value={swapSize}
                    onChange={(e) => setSwapSize(e.target.value)}
                    pattern="^\d+G$"
                    className="w-full bg-gray-950 border border-gray-700 rounded px-2 py-1.5 text-sm"
                  />
                </label>
                <label className="block">
                  <span className="text-xs uppercase text-gray-500">UFW ports (csv)</span>
                  <input
                    type="text"
                    value={ufwPorts}
                    onChange={(e) => setUfwPorts(e.target.value)}
                    placeholder="80,443"
                    className="w-full bg-gray-950 border border-gray-700 rounded px-2 py-1.5 text-sm"
                  />
                </label>
              </div>
              <label className="inline-flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={useNoPty}
                  onChange={(e) => setUseNoPty(e.target.checked)}
                  className="h-4 w-4 accent-brand-purple"
                />
                Set sshd <code>UsePTY no</code> (recommended on GCP)
              </label>
            </div>
          )}

          {step === 3 && (
            <div className="space-y-3 text-sm">
              <p className="text-yellow-400">
                Type <code className="font-mono bg-gray-950 px-1">INITIALISE</code> to confirm:
              </p>
              <input
                type="text"
                value={ackText}
                onChange={(e) => setAckText(e.target.value)}
                className="w-full bg-gray-950 border border-gray-700 rounded px-2 py-1.5 text-sm font-mono"
              />
            </div>
          )}

          {step === 4 && (
            <div className="text-sm space-y-2">
              <p className="text-green-400">
                Initialise dispatched (run id <code className="font-mono">{runId}</code>).
              </p>
              <p className="text-xs text-gray-500">
                Live tail subscribes to WS topic <code>script.run.tail</code>.
                Closing this dialog does not abort the run.
              </p>
            </div>
          )}

          {error && (
            <p className="text-sm text-red-400" role="alert">
              {error}
            </p>
          )}

          <div className="flex justify-between pt-1">
            <button
              type="button"
              onClick={() => {
                if (step === 1) onClose();
                else setStep(((step - 1) as 1 | 2 | 3) || 1);
              }}
              className="px-3 py-1.5 text-sm text-gray-400 hover:text-white"
            >
              {step === 1 ? "Cancel" : "Back"}
            </button>
            {step < 3 && (
              <button
                type="button"
                onClick={() => setStep(((step + 1) as 2 | 3))}
                className="bg-brand-purple hover:bg-purple-600 px-3 py-1.5 rounded text-sm font-medium"
              >
                Next
              </button>
            )}
            {step === 3 && (
              <button
                type="button"
                onClick={handleStart}
                disabled={ackText !== "INITIALISE" || submitting}
                className="bg-brand-purple hover:bg-purple-600 disabled:opacity-50 px-3 py-1.5 rounded text-sm font-medium"
              >
                {submitting ? "Dispatching…" : "Initialise"}
              </button>
            )}
            {step === 4 && (
              <button
                type="button"
                onClick={onClose}
                className="border border-gray-700 hover:border-gray-500 px-3 py-1.5 rounded text-sm"
              >
                Close
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
