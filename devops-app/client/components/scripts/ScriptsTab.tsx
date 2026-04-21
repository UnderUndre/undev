import React, { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api.js";
import { RunDialog, type ManifestEntry } from "./RunDialog.js";

interface ManifestResponse {
  scripts: ManifestEntry[];
}

interface Props {
  serverId: string;
}

export function ScriptsTab({ serverId }: Props): React.JSX.Element {
  const [selected, setSelected] = useState<ManifestEntry | null>(null);

  const { data, isLoading, error } = useQuery<ManifestResponse>({
    queryKey: ["scripts-manifest"],
    queryFn: () => api.get<ManifestResponse>("/scripts/manifest"),
  });

  if (isLoading) {
    return <div className="p-4 text-neutral-500">Loading scripts…</div>;
  }
  if (error) {
    return (
      <div className="p-4 text-red-500">
        Failed to load manifest: {(error as Error).message}
      </div>
    );
  }
  if (!data || data.scripts.length === 0) {
    return <div className="p-4 text-neutral-500">No scripts available.</div>;
  }

  const byCategory = new Map<string, ManifestEntry[]>();
  for (const s of data.scripts) {
    const list = byCategory.get(s.category) ?? [];
    list.push(s);
    byCategory.set(s.category, list);
  }

  return (
    <div className="p-4 space-y-6">
      {[...byCategory.entries()].map(([category, entries]) => (
        <div key={category}>
          <h3 className="text-sm font-semibold uppercase tracking-wide text-neutral-400 mb-2">
            {category}
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {entries.map((entry) => (
              <div
                key={entry.id}
                className="p-3 border border-neutral-700 rounded bg-neutral-900"
              >
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="font-mono text-sm">{entry.id}</div>
                    <div className="text-xs text-neutral-400 mt-1">
                      {entry.description}
                    </div>
                    {entry.dangerLevel === "high" && (
                      <span className="inline-block mt-2 px-2 py-0.5 text-xs bg-red-900 text-red-200 rounded">
                        Dangerous
                      </span>
                    )}
                    {entry.valid === false && (
                      <span
                        className="inline-block mt-2 px-2 py-0.5 text-xs bg-neutral-800 text-neutral-400 rounded ml-1"
                        title={entry.validationError ?? undefined}
                      >
                        Unavailable
                      </span>
                    )}
                  </div>
                  <button
                    type="button"
                    className="px-3 py-1 text-sm bg-blue-600 hover:bg-blue-500 disabled:bg-neutral-700 disabled:text-neutral-400 rounded"
                    disabled={entry.valid === false}
                    onClick={() => setSelected(entry)}
                  >
                    Run
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
      {selected && (
        <RunDialog
          entry={selected}
          serverId={serverId}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}
