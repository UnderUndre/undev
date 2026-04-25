import React from "react";
import { useParams, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api.js";
import { renderScriptIdentity } from "../../lib/render-script-identity.js";

interface RunDetail {
  id: string;
  scriptId: string;
  serverId: string | null;
  deploymentId: string | null;
  userId: string;
  params: Record<string, unknown>;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  duration: number | null;
  exitCode: number | null;
  outputArtifact: unknown | null;
  errorMessage: string | null;
  logFilePath: string;
  archived: boolean;
  reRunnable: boolean;
}

const statusColor: Record<string, string> = {
  success: "bg-green-900/40 text-green-300 border-green-700",
  failed: "bg-red-900/40 text-red-300 border-red-700",
  running: "bg-blue-900/40 text-blue-300 border-blue-700",
  pending: "bg-yellow-900/40 text-yellow-300 border-yellow-700",
  cancelled: "bg-neutral-900/40 text-neutral-300 border-neutral-700",
  timeout: "bg-orange-900/40 text-orange-300 border-orange-700",
};

export function RunDetail(): React.JSX.Element {
  const { runId } = useParams<{ runId: string }>();

  const query = useQuery<RunDetail>({
    queryKey: ["run", runId],
    queryFn: () => api.get<RunDetail>(`/runs/${runId}`),
    enabled: Boolean(runId),
    refetchInterval: (q) => {
      const data = q.state.data;
      return data && (data.status === "running" || data.status === "pending")
        ? 2000
        : false;
    },
  });

  if (query.isLoading) return <div className="p-6">Loading…</div>;
  if (query.error)
    return <div className="p-6 text-red-400">{(query.error as Error).message}</div>;
  if (!query.data) return <div className="p-6">Not found</div>;

  const r = query.data;

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-semibold">
            <Link to="/runs" className="text-brand-purple hover:underline">
              Runs
            </Link>{" "}
            / {renderScriptIdentity(r)}
            {r.archived && (
              <span
                className="ml-2 px-2 py-0.5 text-xs bg-neutral-800 text-neutral-400 rounded"
                title="Script no longer available in this dashboard version"
              >
                Archived
              </span>
            )}
          </h1>
          <p className="text-sm text-neutral-400 mt-1">
            {r.userId} • {new Date(r.startedAt).toLocaleString()} • {r.id}
          </p>
        </div>
        <span
          className={`px-2 py-1 text-xs rounded border ${statusColor[r.status] ?? ""}`}
        >
          {r.status}
        </span>
      </div>

      <section>
        <h2 className="text-sm uppercase tracking-wide text-neutral-400 mb-1">
          Parameters
        </h2>
        <pre className="bg-neutral-950 border border-neutral-800 rounded p-3 text-xs overflow-x-auto">
          {JSON.stringify(r.params, null, 2)}
        </pre>
      </section>

      {r.errorMessage && (
        <section>
          <h2 className="text-sm uppercase tracking-wide text-red-400 mb-1">
            Error
          </h2>
          <div className="bg-red-950/40 border border-red-800 rounded p-3 text-sm">
            {r.errorMessage}
          </div>
        </section>
      )}

      {r.outputArtifact !== null && (
        <section>
          <h2 className="text-sm uppercase tracking-wide text-neutral-400 mb-1">
            Output
          </h2>
          <pre className="bg-neutral-950 border border-neutral-800 rounded p-3 text-xs overflow-x-auto">
            {JSON.stringify(r.outputArtifact, null, 2)}
          </pre>
        </section>
      )}

      <section className="flex gap-2">
        <button
          type="button"
          disabled={!r.reRunnable}
          className="px-3 py-1 text-sm bg-blue-600 hover:bg-blue-500 disabled:bg-neutral-700 disabled:text-neutral-400 rounded"
          title={
            r.reRunnable
              ? "Re-run with the same parameters"
              : "Script no longer available in this dashboard version"
          }
        >
          Re-run
        </button>
      </section>
    </div>
  );
}
