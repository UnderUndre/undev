/**
 * Feature 012 T047 — AbortDuringDrainDialog.
 *
 * Operator types app's name to enable Abort. POSTs to
 * /api/applications/:id/blue-green/abort.
 */

import React, { useState } from "react";

export interface AbortDuringDrainDialogProps {
  appId: string;
  appName: string;
  onDone?: () => void;
}

export function AbortDuringDrainDialog({
  appId,
  appName,
  onDone,
}: AbortDuringDrainDialogProps) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const armed = typed === appName && appName.length > 0;

  async function handleAbort() {
    if (!armed || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/applications/${encodeURIComponent(appId)}/blue-green/abort`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ confirmAppName: typed }),
        },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: { code?: string; message?: string };
        };
        setError(body.error?.message ?? `HTTP ${res.status}`);
        return;
      }
      setTyped("");
      onDone?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="bg-red-950/30 border border-red-800/60 rounded p-3 space-y-2">
      <div className="text-sm text-red-200 font-medium">
        Abort and rollback
      </div>
      <p className="text-xs text-red-100/70">
        Switch traffic back to the outgoing slot, stop the candidate, mark
        deploy failed. Type the app name to confirm.
      </p>
      <input
        type="text"
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
        placeholder={appName}
        className="w-full bg-gray-950 border border-gray-700 rounded px-2 py-1 text-xs font-mono"
      />
      <button
        type="button"
        onClick={handleAbort}
        disabled={!armed || busy}
        className="px-3 py-1 rounded bg-red-700 disabled:opacity-40 text-white text-xs"
      >
        {busy ? "Aborting…" : "Abort and rollback"}
      </button>
      {error && <div className="text-xs text-red-300">{error}</div>}
    </div>
  );
}
