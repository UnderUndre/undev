import React, { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api.js";

interface RunSummary {
  id: string;
  scriptId: string;
  serverId: string | null;
  userId: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  duration: number | null;
  archived: boolean;
}

interface RunsResponse {
  runs: RunSummary[];
}

const STATUSES = ["", "pending", "running", "success", "failed", "cancelled", "timeout"] as const;

const statusColor: Record<string, string> = {
  success: "text-green-400",
  failed: "text-red-400",
  running: "text-blue-400",
  pending: "text-yellow-400",
  cancelled: "text-neutral-400",
  timeout: "text-orange-400",
};

export function RunsPage(): React.JSX.Element {
  const [status, setStatus] = useState<string>("");
  const [scriptId, setScriptId] = useState("");
  const [offset, setOffset] = useState(0);
  const limit = 50;

  const query = useQuery<RunsResponse>({
    queryKey: ["runs", { status, scriptId, offset }],
    queryFn: () => {
      const qs = new URLSearchParams();
      qs.set("limit", String(limit));
      qs.set("offset", String(offset));
      if (status) qs.set("status", status);
      if (scriptId) qs.set("scriptId", scriptId);
      return api.get<RunsResponse>(`/runs?${qs.toString()}`);
    },
  });

  return (
    <div className="p-6">
      <h1 className="text-2xl font-semibold mb-4">Runs</h1>
      <div className="flex gap-2 mb-4">
        <select
          className="bg-gray-900 border border-gray-700 rounded px-2 py-1 text-sm"
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            setOffset(0);
          }}
        >
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s || "all statuses"}
            </option>
          ))}
        </select>
        <input
          className="bg-gray-900 border border-gray-700 rounded px-2 py-1 text-sm"
          placeholder="filter by scriptId (e.g. db/backup)"
          value={scriptId}
          onChange={(e) => {
            setScriptId(e.target.value);
            setOffset(0);
          }}
        />
      </div>
      {query.isLoading && <div>Loading…</div>}
      {query.error && (
        <div className="text-red-400">
          Failed: {(query.error as Error).message}
        </div>
      )}
      <table className="w-full text-sm">
        <thead className="text-left text-neutral-400 border-b border-gray-800">
          <tr>
            <th className="py-2">Script</th>
            <th>Server</th>
            <th>User</th>
            <th>Status</th>
            <th>Started</th>
            <th>Duration</th>
          </tr>
        </thead>
        <tbody>
          {query.data?.runs.map((r) => (
            <tr
              key={r.id}
              className="border-b border-gray-900 hover:bg-gray-900"
            >
              <td className="py-2 font-mono">
                <Link to={`/runs/${r.id}`} className="hover:underline">
                  {r.scriptId}
                </Link>
                {r.archived && (
                  <span
                    className="ml-2 px-1.5 py-0.5 text-[10px] bg-neutral-800 text-neutral-400 rounded"
                    title="Script no longer available in this dashboard version"
                  >
                    Archived
                  </span>
                )}
              </td>
              <td className="text-neutral-400">{r.serverId ?? "—"}</td>
              <td className="text-neutral-400">{r.userId}</td>
              <td className={statusColor[r.status] ?? ""}>{r.status}</td>
              <td className="text-neutral-400">
                {new Date(r.startedAt).toLocaleString()}
              </td>
              <td className="text-neutral-400">
                {r.duration !== null ? `${(r.duration / 1000).toFixed(1)}s` : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="flex items-center gap-2 mt-4">
        <button
          type="button"
          disabled={offset === 0}
          onClick={() => setOffset(Math.max(0, offset - limit))}
          className="px-3 py-1 bg-gray-900 border border-gray-700 rounded disabled:opacity-50"
        >
          Prev
        </button>
        <button
          type="button"
          disabled={(query.data?.runs.length ?? 0) < limit}
          onClick={() => setOffset(offset + limit)}
          className="px-3 py-1 bg-gray-900 border border-gray-700 rounded disabled:opacity-50"
        >
          Next
        </button>
        <span className="text-xs text-neutral-500">offset {offset}</span>
      </div>
    </div>
  );
}
