import React, { useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api.js";
import { DeployLog } from "../components/deploy/DeployLog.js";
import { CommitList } from "../components/github/CommitList.js";
import { BranchSelect } from "../components/github/BranchSelect.js";

interface Application {
  id: string;
  serverId: string;
  name: string;
  repoUrl: string;
  branch: string;
  remotePath: string;
  deployScript: string;
  currentCommit: string | null;
  currentVersion: string | null;
  githubRepo: string | null;
}

interface Deployment {
  id: string;
  appId: string;
  type: "deploy" | "rollback";
  status: "pending" | "running" | "success" | "failed";
  branch: string;
  commit: string | null;
  startedAt: string;
  finishedAt: string | null;
  duration: number | null;
  jobId: string;
}

interface DeployResponse {
  jobId: string;
}

interface PreflightCheck {
  name: string;
  status: "pass" | "warn" | "fail";
  message: string;
}

interface PreflightResponse {
  checks: PreflightCheck[];
  canDeploy: boolean;
}

export function AppPage() {
  const { appId } = useParams<{ appId: string }>();
  const queryClient = useQueryClient();
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [preflight, setPreflight] = useState<PreflightResponse | null>(null);
  const [isPreflightLoading, setIsPreflightLoading] = useState(false);
  const [rollbackTarget, setRollbackTarget] = useState<Deployment | null>(null);

  const { data: app, isLoading: appLoading } = useQuery({
    queryKey: ["app", appId],
    queryFn: () => api.get<Application>(`/apps/${appId}`),
    enabled: Boolean(appId),
  });

  const { data: deployments, isLoading: deploymentsLoading } = useQuery({
    queryKey: ["app", appId, "deployments"],
    queryFn: () => api.get<Deployment[]>(`/apps/${appId}/deployments`),
    enabled: Boolean(appId),
  });

  const deployMutation = useMutation({
    mutationFn: (payload: { commit?: string; branch?: string } = {}) =>
      api.post<DeployResponse>(`/apps/${appId}/deploy`, payload),
    onSuccess: (data) => {
      setActiveJobId(data.jobId);
      setPreflight(null);
      queryClient.invalidateQueries({ queryKey: ["app", appId, "deployments"] });
    },
  });

  const updateBranchMutation = useMutation({
    mutationFn: (branch: string) => api.put<Application>(`/apps/${appId}`, { branch }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["app", appId] });
    },
  });

  const rollbackMutation = useMutation({
    mutationFn: (deploymentId: string) =>
      api.post<DeployResponse>(`/apps/${appId}/rollback`, { deploymentId }),
    onSuccess: (data) => {
      setActiveJobId(data.jobId);
      setRollbackTarget(null);
      queryClient.invalidateQueries({ queryKey: ["app", appId, "deployments"] });
    },
  });

  const runPreflight = async () => {
    setIsPreflightLoading(true);
    try {
      const result = await api.get<PreflightResponse>(`/apps/${appId}/preflight`);
      setPreflight(result);
    } catch {
      setPreflight(null);
    } finally {
      setIsPreflightLoading(false);
    }
  };

  const handleDeploy = () => {
    deployMutation.mutate({});
  };

  const handleDeployCommit = (sha: string) => {
    deployMutation.mutate({ commit: sha });
  };

  if (appLoading) {
    return (
      <div className="p-6">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-gray-800 rounded w-48" />
          <div className="h-4 bg-gray-800 rounded w-64" />
        </div>
      </div>
    );
  }

  if (!app) {
    return (
      <div className="p-6">
        <p className="text-red-400">Application not found</p>
        <Link to="/" className="text-blue-400 hover:underline text-sm mt-2 inline-block">
          Back to dashboard
        </Link>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-4xl">
      {/* Header */}
      <div className="mb-6">
        <Link
          to={`/servers/${app.serverId}`}
          className="text-sm text-gray-500 hover:text-gray-300 transition-colors"
        >
          &larr; Server
        </Link>
        <div className="flex items-center gap-4 mt-2 flex-wrap">
          <h1 className="text-2xl font-bold">{app.name}</h1>
          {app.githubRepo && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-gray-500">Branch:</span>
              <div className="w-56 max-w-full">
                <BranchSelect
                  owner={app.githubRepo.split("/")[0]}
                  repo={app.githubRepo.split("/")[1]}
                  value={app.branch}
                  onChange={(b) => updateBranchMutation.mutate(b)}
                  disabled={updateBranchMutation.isPending}
                />
              </div>
            </div>
          )}
        </div>
      </div>

      {/* App Info */}
      <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 mb-6">
        <div className="grid grid-cols-2 gap-4 text-sm">
          <InfoRow label="Branch" value={app.branch} />
          <InfoRow label="Commit" value={app.currentCommit?.slice(0, 7) ?? "N/A"} mono />
          <InfoRow label="Version" value={app.currentVersion ?? "N/A"} />
          <InfoRow label="Path" value={app.remotePath} mono />
        </div>
      </div>

      {/* Deploy Section */}
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-4">
          <button
            onClick={runPreflight}
            disabled={isPreflightLoading}
            className="bg-gray-800 hover:bg-gray-700 disabled:opacity-50 px-4 py-2 rounded-lg text-sm font-medium transition-colors"
          >
            {isPreflightLoading ? "Checking..." : "Pre-flight Check"}
          </button>
          <button
            onClick={handleDeploy}
            disabled={deployMutation.isPending}
            className="bg-green-600 hover:bg-green-700 disabled:opacity-50 px-4 py-2 rounded-lg text-sm font-medium transition-colors"
          >
            {deployMutation.isPending ? "Deploying..." : "Deploy"}
          </button>
        </div>

        {deployMutation.isError && (
          <div className="text-sm text-red-400 mb-4">
            {deployMutation.error instanceof Error ? deployMutation.error.message : "Deploy failed"}
          </div>
        )}

        {/* Preflight Results */}
        {preflight && (
          <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 mb-4">
            <h3 className="text-sm font-medium text-gray-300 mb-2">Pre-flight Checks</h3>
            <div className="space-y-1">
              {preflight.checks.map((check, i) => (
                <div key={i} className="flex items-center gap-2 text-sm">
                  <PreflightIcon status={check.status} />
                  <span className="text-gray-300">{check.name}</span>
                  <span className="text-gray-600">&mdash;</span>
                  <span className="text-gray-500">{check.message}</span>
                </div>
              ))}
            </div>
            {!preflight.canDeploy && (
              <p className="text-xs text-red-400 mt-2">
                Fix failing checks before deploying.
              </p>
            )}
          </div>
        )}

        {/* Deploy Log */}
        {activeJobId && <DeployLog jobId={activeJobId} />}
      </div>

      {/* GitHub Commits */}
      {app.githubRepo && (
        <div className="mb-8">
          <h2 className="text-lg font-semibold mb-4">Commits</h2>
          <CommitList
            owner={app.githubRepo.split("/")[0]}
            repo={app.githubRepo.split("/")[1]}
            branch={app.branch}
            onDeploy={handleDeployCommit}
            isDeploying={deployMutation.isPending}
          />
        </div>
      )}

      {/* Deployment History */}
      <div>
        <h2 className="text-lg font-semibold mb-4">Deployment History</h2>
        {deploymentsLoading ? (
          <div className="animate-pulse space-y-2">
            {[1, 2, 3].map((n) => (
              <div key={n} className="h-10 bg-gray-800 rounded" />
            ))}
          </div>
        ) : !deployments?.length ? (
          <p className="text-gray-600 text-sm">No deployments yet.</p>
        ) : (
          <div className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-800 text-left text-gray-500">
                  <th className="px-4 py-2 font-medium">Type</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                  <th className="px-4 py-2 font-medium">Branch</th>
                  <th className="px-4 py-2 font-medium">Commit</th>
                  <th className="px-4 py-2 font-medium">Started</th>
                  <th className="px-4 py-2 font-medium">Duration</th>
                  <th className="px-4 py-2 font-medium" />
                </tr>
              </thead>
              <tbody>
                {deployments.map((d) => (
                  <tr
                    key={d.id}
                    className="border-b border-gray-800/50 hover:bg-gray-800/30 transition-colors"
                  >
                    <td className="px-4 py-2">
                      <span
                        className={`text-xs font-medium px-1.5 py-0.5 rounded ${
                          d.type === "rollback"
                            ? "bg-yellow-900/30 text-yellow-400"
                            : "bg-blue-900/30 text-blue-400"
                        }`}
                      >
                        {d.type}
                      </span>
                    </td>
                    <td className="px-4 py-2">
                      <DeployStatusBadge status={d.status} />
                    </td>
                    <td className="px-4 py-2 text-gray-400">{d.branch}</td>
                    <td className="px-4 py-2 font-mono text-gray-500">
                      {d.commit?.slice(0, 7) ?? "-"}
                    </td>
                    <td className="px-4 py-2 text-gray-500">
                      {new Date(d.startedAt).toLocaleString()}
                    </td>
                    <td className="px-4 py-2 text-gray-500">
                      {formatDuration(d.duration)}
                    </td>
                    <td className="px-4 py-2 text-right">
                      {d.type === "deploy" && d.status === "success" && (
                        <button
                          onClick={() => setRollbackTarget(d)}
                          className="text-xs text-yellow-500 hover:text-yellow-400 transition-colors"
                        >
                          Rollback
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Rollback Confirmation */}
      {rollbackTarget && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
          onClick={(e) => {
            if (e.target === e.currentTarget) setRollbackTarget(null);
          }}
          role="dialog"
          aria-modal="true"
          aria-label="Confirm rollback"
        >
          <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-md mx-4 shadow-2xl p-6">
            <h3 className="text-lg font-semibold mb-2">Confirm Rollback</h3>
            <p className="text-sm text-gray-400 mb-1">
              Roll back to deployment from{" "}
              <span className="text-gray-300">
                {new Date(rollbackTarget.startedAt).toLocaleString()}
              </span>
            </p>
            <p className="text-sm text-gray-500 mb-4">
              Branch: <span className="text-gray-300">{rollbackTarget.branch}</span>
              {rollbackTarget.commit && (
                <>
                  {" "}&middot; Commit:{" "}
                  <span className="text-gray-300 font-mono">
                    {rollbackTarget.commit.slice(0, 7)}
                  </span>
                </>
              )}
            </p>
            <div className="bg-yellow-950/30 border border-yellow-900/50 rounded-lg px-3 py-2 text-sm text-yellow-400 mb-4">
              This will trigger a rollback deployment. Proceed with caution.
            </div>

            {rollbackMutation.isError && (
              <div className="text-sm text-red-400 mb-3">
                {rollbackMutation.error instanceof Error
                  ? rollbackMutation.error.message
                  : "Rollback failed"}
              </div>
            )}

            <div className="flex justify-end gap-3">
              <button
                onClick={() => setRollbackTarget(null)}
                className="px-4 py-2 text-sm text-gray-400 hover:text-white transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => rollbackMutation.mutate(rollbackTarget.id)}
                disabled={rollbackMutation.isPending}
                className="bg-yellow-600 hover:bg-yellow-700 disabled:opacity-50 px-4 py-2 rounded-lg text-sm font-medium transition-colors"
              >
                {rollbackMutation.isPending ? "Rolling back..." : "Confirm Rollback"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function InfoRow({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div>
      <span className="text-gray-500">{label}</span>
      <span className={`ml-2 text-gray-200 ${mono ? "font-mono" : ""}`}>{value}</span>
    </div>
  );
}

function PreflightIcon({ status }: { status: "pass" | "warn" | "fail" }) {
  const map = {
    pass: "text-green-400",
    warn: "text-yellow-400",
    fail: "text-red-400",
  };
  const symbols = { pass: "\u2713", warn: "\u26A0", fail: "\u2717" };
  return <span className={`${map[status]} text-xs`}>{symbols[status]}</span>;
}

function DeployStatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    success: "text-green-400",
    failed: "text-red-400",
    running: "text-blue-400",
    pending: "text-gray-400",
  };
  return (
    <span className={`text-xs ${colors[status] ?? "text-gray-500"}`}>
      {status}
    </span>
  );
}

function formatDuration(ms: number | null): string {
  if (ms === null) return "-";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return `${minutes}m ${remaining}s`;
}
