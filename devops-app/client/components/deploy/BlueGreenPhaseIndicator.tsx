/**
 * Feature 012 T036 — visual progress indicator for blue/green state machine.
 *
 * Maps phase tokens to display labels. Renders a horizontal stepper.
 * FailureCard mount is delegated to the parent; this component just shows
 * which phase is current + which are completed.
 */

import React from "react";

const PHASES = [
  { id: "CANDIDATE_STARTING", label: "Starting candidate" },
  { id: "CANDIDATE_HEALTHY", label: "Candidate healthy" },
  { id: "SWITCHING", label: "Switching traffic" },
  { id: "OUTGOING_DRAINING", label: "Draining outgoing" },
  { id: "OUTGOING_STOPPED", label: "Outgoing stopped" },
  { id: "ACTIVE", label: "Active" },
] as const;

const PHASE_INDEX = new Map<string, number>(
  PHASES.map((p, i) => [p.id, i]),
);

export interface BlueGreenPhaseIndicatorProps {
  currentPhase: string | null;
  candidateColor?: "blue" | "green";
}

export function BlueGreenPhaseIndicator({
  currentPhase,
  candidateColor,
}: BlueGreenPhaseIndicatorProps) {
  const isFailed = currentPhase?.startsWith("FAILED_") === true;
  const currentIdx = currentPhase
    ? PHASE_INDEX.get(currentPhase) ?? -1
    : -1;

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-3 space-y-2">
      <div className="flex items-center justify-between text-xs text-gray-400">
        <span>Blue/Green deploy</span>
        {candidateColor && (
          <span>
            Candidate slot:{" "}
            <span className="font-mono text-gray-200">{candidateColor}</span>
          </span>
        )}
      </div>
      <ol className="flex items-center gap-1">
        {PHASES.map((p, i) => {
          const done = currentIdx > i;
          const active = currentIdx === i && !isFailed;
          return (
            <li
              key={p.id}
              className={`flex-1 px-2 py-1 rounded text-[11px] text-center border ${
                active
                  ? "bg-brand-purple/30 border-brand-purple text-white"
                  : done
                    ? "bg-green-950/40 border-green-800/60 text-green-300"
                    : "bg-gray-950 border-gray-800 text-gray-500"
              }`}
            >
              {p.label}
            </li>
          );
        })}
      </ol>
      {isFailed && currentPhase && (
        <div className="bg-red-950/40 border border-red-800/50 rounded p-2 text-xs text-red-200">
          Failure phase: <span className="font-mono">{currentPhase}</span>
        </div>
      )}
    </div>
  );
}
