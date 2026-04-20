import React, { useState } from "react";
import type { DockerCandidate } from "../../hooks/useScan.js";

interface Props {
  candidate: DockerCandidate;
  dockerAvailable: boolean;
  onImport: (c: DockerCandidate) => void;
}

export function DockerCandidateRow({ candidate: c, dockerAvailable, onImport }: Props) {
  const [expanded, setExpanded] = useState(false);
  const hasExtras = c.extraComposeFiles.length > 0;

  return (
    <li className="flex items-start justify-between gap-4 rounded-md border border-gray-700 bg-gray-900/50 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-mono text-sm text-gray-100">{c.name}</span>
          <span className="rounded bg-purple-900/50 px-2 py-0.5 text-xs text-purple-300 border border-purple-700">
            {c.kind === "compose" ? "Compose" : "Container"}
          </span>
          {c.alreadyImported && (
            <span className="rounded bg-blue-900/50 px-2 py-0.5 text-xs text-blue-300 border border-blue-700">
              Already added
            </span>
          )}
        </div>
        {c.path && (
          <div className="mt-1 font-mono text-xs text-gray-400">{c.path}</div>
        )}
        {c.services.length === 0 && c.kind === "compose" && !dockerAvailable && (
          <div className="mt-1 text-xs text-gray-500 italic">
            Services unknown — docker not available on host
          </div>
        )}
        {c.services.length > 0 && (
          <ul className="mt-2 space-y-0.5 text-xs">
            {c.services.map((s) => (
              <li key={s.name} className="flex items-center gap-2">
                <span
                  className={
                    s.running
                      ? "h-1.5 w-1.5 rounded-full bg-green-500"
                      : "h-1.5 w-1.5 rounded-full bg-gray-600"
                  }
                  title={s.running ? "running" : "stopped"}
                />
                <span className="font-mono text-gray-300">{s.name}</span>
                <span className="text-gray-500">{s.image}</span>
              </li>
            ))}
          </ul>
        )}
        {hasExtras && (
          <button
            type="button"
            onClick={() => setExpanded((x) => !x)}
            className="mt-1 text-xs text-gray-500 hover:text-gray-300"
          >
            {expanded ? "Hide" : "Show"} {c.extraComposeFiles.length} override file
            {c.extraComposeFiles.length === 1 ? "" : "s"}
          </button>
        )}
        {expanded && hasExtras && (
          <ul className="mt-1 space-y-0.5 font-mono text-xs text-gray-500">
            {c.extraComposeFiles.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        )}
      </div>
      <button
        type="button"
        onClick={() => onImport(c)}
        disabled={c.alreadyImported}
        className="shrink-0 rounded-md bg-purple-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-purple-500 disabled:cursor-not-allowed disabled:bg-gray-700 disabled:text-gray-500"
      >
        {c.alreadyImported ? "Added" : "Import"}
      </button>
    </li>
  );
}
