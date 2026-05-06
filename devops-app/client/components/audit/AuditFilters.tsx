/** Feature 010 T042 — audit filter sidebar. */
import React from "react";
import type { AuditFilters as Filters, ResourceTypeFilter } from "../../hooks/useAuditQuery.js";

export interface AuditFiltersProps {
  filters: Filters;
  onChange: (next: Filters) => void;
}

const RESOURCE_TYPES: ResourceTypeFilter[] = ["server", "application", "cert", "bootstrap", "other"];
const PRESETS: Array<{ label: string; ms: number | null }> = [
  { label: "1h", ms: 60 * 60_000 },
  { label: "24h", ms: 24 * 60 * 60_000 },
  { label: "7d", ms: 7 * 24 * 60 * 60_000 },
  { label: "30d", ms: 30 * 24 * 60 * 60_000 },
  { label: "All", ms: null },
];

export function AuditFilters({ filters, onChange }: AuditFiltersProps) {
  const setPreset = (ms: number | null) => {
    if (ms === null) {
      const { since: _s, until: _u, ...rest } = filters;
      onChange(rest);
    } else {
      const since = new Date(Date.now() - ms).toISOString();
      onChange({ ...filters, since });
    }
  };
  return (
    <aside className="border border-gray-800 rounded p-3 bg-gray-950 space-y-3 text-sm">
      <div>
        <label className="block text-xs uppercase text-gray-400 mb-1">Actor (CSV)</label>
        <input
          type="text"
          className="w-full rounded bg-gray-800 border border-gray-700 px-2 py-1 text-xs"
          value={(filters.actor ?? []).join(",")}
          onChange={(e) =>
            onChange({
              ...filters,
              actor: e.target.value.split(",").map((s) => s.trim()).filter(Boolean),
            })
          }
        />
      </div>
      <div>
        <label className="block text-xs uppercase text-gray-400 mb-1">Action (CSV)</label>
        <input
          type="text"
          className="w-full rounded bg-gray-800 border border-gray-700 px-2 py-1 text-xs"
          value={(filters.action ?? []).join(",")}
          onChange={(e) =>
            onChange({
              ...filters,
              action: e.target.value.split(",").map((s) => s.trim()).filter(Boolean),
            })
          }
        />
      </div>
      <div>
        <label className="block text-xs uppercase text-gray-400 mb-1">Resource type</label>
        <select
          className="w-full rounded bg-gray-800 border border-gray-700 px-2 py-1 text-xs"
          value={filters.resourceType ?? ""}
          onChange={(e) => {
            const v = e.target.value;
            onChange({ ...filters, resourceType: v === "" ? undefined : (v as ResourceTypeFilter) });
          }}
        >
          <option value="">All</option>
          {RESOURCE_TYPES.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className="block text-xs uppercase text-gray-400 mb-1">Time</label>
        <div className="flex flex-wrap gap-1">
          {PRESETS.map((p) => (
            <button
              key={p.label}
              type="button"
              className="px-2 py-1 rounded bg-gray-800 hover:bg-gray-700 text-xs"
              onClick={() => setPreset(p.ms)}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>
    </aside>
  );
}
