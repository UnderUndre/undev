import React, { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api.js";

interface AuditEntry {
  id: string;
  timestamp: string;
  user: string;
  action: string;
  target: string;
  result: string;
}

interface AuditResponse {
  entries: AuditEntry[];
  total: number;
}

const PAGE_SIZE = 25;

export function AuditPage() {
  const [offset, setOffset] = useState(0);

  const { data, isLoading } = useQuery({
    queryKey: ["audit-trail", offset],
    queryFn: () =>
      api.get<AuditResponse>(
        `/audit-trail?limit=${PAGE_SIZE}&offset=${offset}`,
      ),
  });

  const entries = data?.entries ?? [];
  const total = data?.total ?? 0;
  const hasMore = offset + PAGE_SIZE < total;

  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold mb-6">Audit Trail</h1>

      {isLoading ? (
        <div className="space-y-2">
          {[1, 2, 3, 4, 5].map((n) => (
            <div key={n} className="h-10 bg-gray-800 rounded animate-pulse" />
          ))}
        </div>
      ) : entries.length === 0 ? (
        <p className="text-gray-600 text-center py-12">No audit entries found.</p>
      ) : (
        <>
          <div className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-800 text-left text-gray-500">
                  <th className="px-4 py-2 font-medium">Timestamp</th>
                  <th className="px-4 py-2 font-medium">User</th>
                  <th className="px-4 py-2 font-medium">Action</th>
                  <th className="px-4 py-2 font-medium">Target</th>
                  <th className="px-4 py-2 font-medium">Result</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => (
                  <tr
                    key={entry.id}
                    className="border-b border-gray-800/50 hover:bg-gray-800/30 transition-colors"
                  >
                    <td className="px-4 py-2 text-gray-500 text-xs whitespace-nowrap">
                      {new Date(entry.timestamp).toLocaleString()}
                    </td>
                    <td className="px-4 py-2 text-gray-300">{entry.user}</td>
                    <td className="px-4 py-2">
                      <span className="text-xs font-medium px-1.5 py-0.5 rounded bg-gray-800 text-gray-300">
                        {entry.action}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-gray-400 font-mono text-xs">
                      {entry.target}
                    </td>
                    <td className="px-4 py-2">
                      <ResultBadge result={entry.result} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          <div className="flex items-center justify-between mt-4">
            <p className="text-xs text-gray-500">
              Showing {offset + 1}–{Math.min(offset + PAGE_SIZE, total)} of {total}
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => setOffset((o) => Math.max(0, o - PAGE_SIZE))}
                disabled={offset === 0}
                className="px-3 py-1.5 text-sm bg-gray-800 hover:bg-gray-700 disabled:opacity-50 rounded-lg transition-colors"
              >
                Previous
              </button>
              <button
                onClick={() => setOffset((o) => o + PAGE_SIZE)}
                disabled={!hasMore}
                className="px-3 py-1.5 text-sm bg-gray-800 hover:bg-gray-700 disabled:opacity-50 rounded-lg transition-colors"
              >
                Next
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function ResultBadge({ result }: { result: string }) {
  const colors: Record<string, string> = {
    success: "text-green-400",
    failure: "text-red-400",
    error: "text-red-400",
    pending: "text-yellow-400",
  };

  return (
    <span className={`text-xs ${colors[result.toLowerCase()] ?? "text-gray-400"}`}>
      {result}
    </span>
  );
}
