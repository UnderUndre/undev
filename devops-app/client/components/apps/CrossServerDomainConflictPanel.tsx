/** Feature 010 T035 — inline panel listing cross-server domain conflicts. */
import React from "react";
import type { DomainConflict } from "../../hooks/useCrossServerDomainCheck.js";

export interface CrossServerDomainConflictPanelProps {
  conflicts: DomainConflict[];
}

export function CrossServerDomainConflictPanel({ conflicts }: CrossServerDomainConflictPanelProps) {
  if (conflicts.length === 0) return null;
  return (
    <div className="rounded border border-yellow-700 bg-yellow-950/30 px-3 py-2 text-sm">
      <p className="text-yellow-300 font-semibold mb-1">
        Domain already in use on {conflicts.length} other server{conflicts.length === 1 ? "" : "s"}.
      </p>
      <ul className="text-xs text-yellow-200 space-y-1">
        {conflicts.map((c) => (
          <li key={`${c.serverId}:${c.appId}`} className="flex items-center gap-2">
            <a href={`/apps/${c.appId}`} className="underline">
              {c.serverLabel} / {c.appName}
            </a>
            {c.certStatus && (
              <span className="px-1.5 py-0.5 rounded bg-yellow-900 text-yellow-100">
                cert: {c.certStatus}
              </span>
            )}
          </li>
        ))}
      </ul>
      <p className="text-xs text-yellow-400 mt-2">
        Type the domain exactly to confirm an intentional HA / round-robin attach.
      </p>
    </div>
  );
}
