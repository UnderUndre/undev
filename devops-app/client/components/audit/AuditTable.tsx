/** Feature 010 T044 — paginated audit table with CSV export anchor. */
import React from "react";
import {
  useAuditQuery,
  buildAuditCsvHref,
  type AuditFilters,
} from "../../hooks/useAuditQuery.js";
import { ResourceLink } from "./ResourceLink.js";

export interface AuditTableProps {
  filters: AuditFilters;
  page: number;
  pageSize: number;
  onPageChange: (next: number) => void;
}

export function AuditTable({ filters, page, pageSize, onPageChange }: AuditTableProps) {
  const { data, isLoading, error } = useAuditQuery(filters, page, pageSize);
  const csvHref = buildAuditCsvHref(filters);

  return (
    <section className="space-y-3">
      <header className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">Audit log</h2>
        <a
          href={csvHref}
          className="px-3 py-1 rounded bg-gray-700 hover:bg-gray-600 text-xs"
        >
          Export CSV
        </a>
      </header>
      {error && <div className="text-xs text-red-400">{error}</div>}
      {data?.isCapped && (
        <div className="rounded border border-yellow-700 bg-yellow-950/30 px-3 py-1 text-xs text-yellow-300">
          ≥10,000 results — narrow the filter to see all.
        </div>
      )}
      <table className="w-full text-xs">
        <thead>
          <tr className="text-gray-500 text-left">
            <th className="py-1">Time</th>
            <th>Actor</th>
            <th>Action</th>
            <th>Resource</th>
            <th>Details</th>
          </tr>
        </thead>
        <tbody>
          {isLoading && !data ? (
            <tr><td colSpan={5} className="py-4 text-center text-gray-500">Loading…</td></tr>
          ) : !data || data.rows.length === 0 ? (
            <tr><td colSpan={5} className="py-4 text-center text-gray-500">No entries.</td></tr>
          ) : (
            data.rows.map((r) => (
              <tr key={r.id} className="border-t border-gray-800 align-top">
                <td className="py-1 font-mono text-gray-400">{r.occurredAt.slice(0, 19).replace("T", " ")}</td>
                <td className="text-gray-300">{r.actor}</td>
                <td className="font-mono text-gray-200">{r.action}</td>
                <td><ResourceLink row={r} /></td>
                <td className="text-gray-400">
                  <pre className="whitespace-pre-wrap break-all bg-gray-950 border border-gray-800 rounded p-1 text-[10px]">
                    {typeof r.details === "string" ? r.details : JSON.stringify(r.details, null, 2)}
                  </pre>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
      {data && data.totalCount > pageSize && (
        <div className="flex items-center justify-end gap-2 text-xs">
          <button
            type="button"
            className="px-2 py-1 rounded bg-gray-800 disabled:opacity-50"
            disabled={page <= 1}
            onClick={() => onPageChange(Math.max(1, page - 1))}
          >
            Prev
          </button>
          <span className="text-gray-500">page {data.page} ({data.totalCount} total)</span>
          <button
            type="button"
            className="px-2 py-1 rounded bg-gray-800 disabled:opacity-50"
            disabled={page * pageSize >= data.totalCount}
            onClick={() => onPageChange(page + 1)}
          >
            Next
          </button>
        </div>
      )}
    </section>
  );
}
