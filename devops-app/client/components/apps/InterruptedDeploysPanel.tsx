/**
 * Feature 012 T049 — InterruptedDeploysPanel.
 *
 * Surfaces interrupted-by-restart blue/green deploys at top of the apps
 * list page. One card per row with Resume / Abort+cleanup / Mark complete.
 *
 * Hidden when fetched data is empty array.
 */

import React, { useState } from "react";
import {
  useInterruptedDeploys,
  type InterruptedDeployRow,
} from "../../hooks/useInterruptedDeploys.js";

export function InterruptedDeploysPanel() {
  const { rows, isLoading, error, refetch } = useInterruptedDeploys();
  if (isLoading || rows.length === 0) return null;
  return (
    <div className="bg-amber-950/30 border border-amber-700/60 rounded-lg p-3 mb-4 space-y-3">
      <div className="text-sm text-amber-200 font-medium">
        Interrupted blue/green deploys ({rows.length})
      </div>
      {error && <div className="text-xs text-red-300">{error}</div>}
      {rows.map((row) => (
        <InterruptedRowCard key={row.appId} row={row} onDone={refetch} />
      ))}
    </div>
  );
}

interface InterruptedRowCardProps {
  row: InterruptedDeployRow;
  onDone: () => Promise<void>;
}

function InterruptedRowCard({ row, onDone }: InterruptedRowCardProps) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState<null | "resume" | "abort" | "complete">(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [resumePhase, setResumePhase] = useState("CANDIDATE_STARTING");
  const [finalColor, setFinalColor] = useState<"blue" | "green">(
    row.activeColor ?? "blue",
  );
  const armed = typed === row.appName && row.appName.length > 0;

  async function call(
    path: string,
    body: Record<string, unknown>,
    label: NonNullable<typeof busy>,
  ): Promise<void> {
    setBusy(label);
    setError(null);
    try {
      const res = await fetch(
        `/api/applications/${encodeURIComponent(row.appId)}/blue-green/${path}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          credentials: "include",
          body: JSON.stringify(body),
        },
      );
      const json = (await res.json().catch(() => ({}))) as {
        error?: { message?: string };
      };
      if (!res.ok) {
        setError(json.error?.message ?? `HTTP ${res.status}`);
        return;
      }
      await onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="bg-gray-950 border border-gray-800 rounded p-3 space-y-2">
      <div className="flex items-center justify-between text-xs text-gray-300">
        <div>
          <span className="font-medium text-gray-100">{row.appName}</span>{" "}
          <span className="text-gray-500">on {row.serverLabel}</span>
        </div>
        <div className="font-mono text-gray-400">{row.lastPhase}</div>
      </div>
      <div className="grid grid-cols-2 gap-2 text-[11px] text-gray-400">
        <div>
          Candidate: <span className="font-mono">{row.candidate.name}</span> —{" "}
          <span>{row.candidate.state}</span>
        </div>
        <div>
          Outgoing: <span className="font-mono">{row.outgoing.name}</span> —{" "}
          <span>{row.outgoing.state}</span>
        </div>
      </div>
      <input
        type="text"
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
        placeholder={`Type "${row.appName}" to enable actions`}
        className="w-full bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs font-mono"
      />
      <div className="flex flex-wrap gap-2 items-center">
        <select
          value={resumePhase}
          onChange={(e) => setResumePhase(e.target.value)}
          className="bg-gray-900 border border-gray-700 rounded px-1 py-0.5 text-[11px]"
        >
          <option value="CANDIDATE_STARTING">CANDIDATE_STARTING</option>
          <option value="CANDIDATE_HEALTHY">CANDIDATE_HEALTHY</option>
          <option value="SWITCHING">SWITCHING</option>
          <option value="OUTGOING_DRAINING">OUTGOING_DRAINING</option>
          <option value="OUTGOING_STOPPED">OUTGOING_STOPPED</option>
        </select>
        <button
          type="button"
          disabled={!armed || busy !== null}
          onClick={() =>
            call(
              "interrupted/resume",
              { resumeFromPhase: resumePhase, confirmAppName: typed },
              "resume",
            )
          }
          className="px-2 py-1 rounded bg-blue-700 disabled:opacity-40 text-white text-xs"
        >
          {busy === "resume" ? "Resuming…" : "Resume"}
        </button>
        <button
          type="button"
          disabled={!armed || busy !== null}
          onClick={() =>
            call("interrupted/abort-cleanup", { confirmAppName: typed }, "abort")
          }
          className="px-2 py-1 rounded bg-red-700 disabled:opacity-40 text-white text-xs"
        >
          {busy === "abort" ? "Cleaning…" : "Abort + cleanup"}
        </button>
        <select
          value={finalColor}
          onChange={(e) => setFinalColor(e.target.value as "blue" | "green")}
          className="bg-gray-900 border border-gray-700 rounded px-1 py-0.5 text-[11px]"
        >
          <option value="blue">blue</option>
          <option value="green">green</option>
        </select>
        <button
          type="button"
          disabled={!armed || busy !== null}
          onClick={() =>
            call(
              "interrupted/mark-complete",
              { finalActiveColor: finalColor, confirmAppName: typed },
              "complete",
            )
          }
          className="px-2 py-1 rounded bg-amber-600 disabled:opacity-40 text-white text-xs"
        >
          {busy === "complete" ? "Marking…" : "Mark complete"}
        </button>
      </div>
      {error && <div className="text-xs text-red-300">{error}</div>}
    </div>
  );
}
