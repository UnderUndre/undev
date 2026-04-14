import React, { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api.js";
import { DeployLog } from "../deploy/DeployLog.js";

interface DockerPanelProps {
  serverId: string;
}

interface DockerInfo {
  diskUsage: {
    images: string;
    containers: string;
    volumes: string;
    buildCache: string;
    total: string;
  };
  containers: DockerContainer[];
}

interface DockerContainer {
  name: string;
  status: string;
  image: string;
}

interface CleanupResponse {
  jobId: string;
}

export function DockerPanel({ serverId }: DockerPanelProps) {
  const queryClient = useQueryClient();
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [confirmAggressive, setConfirmAggressive] = useState(false);

  const { data: docker, isLoading } = useQuery({
    queryKey: ["server", serverId, "docker"],
    queryFn: () => api.get<DockerInfo>(`/servers/${serverId}/docker`),
    enabled: Boolean(serverId),
  });

  const cleanupMutation = useMutation({
    mutationFn: (mode: "safe" | "aggressive") =>
      api.post<CleanupResponse>(`/servers/${serverId}/docker/cleanup`, { mode }),
    onSuccess: (data) => {
      setActiveJobId(data.jobId);
      setConfirmAggressive(false);
      queryClient.invalidateQueries({
        queryKey: ["server", serverId, "docker"],
      });
    },
  });

  if (isLoading) {
    return (
      <div className="space-y-4">
        <div className="h-32 bg-gray-900 border border-gray-800 rounded-lg animate-pulse" />
        <div className="h-48 bg-gray-900 border border-gray-800 rounded-lg animate-pulse" />
      </div>
    );
  }

  if (!docker) {
    return (
      <div className="text-center py-12 text-gray-600">
        No Docker information available.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Docker</h2>
        <div className="flex items-center gap-2">
          <button
            onClick={() => cleanupMutation.mutate("safe")}
            disabled={cleanupMutation.isPending}
            className="bg-gray-800 hover:bg-gray-700 disabled:opacity-50 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors"
          >
            Safe Cleanup
          </button>
          <button
            onClick={() => setConfirmAggressive(true)}
            disabled={cleanupMutation.isPending}
            className="bg-red-600/80 hover:bg-red-600 disabled:opacity-50 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors"
          >
            Aggressive Cleanup
          </button>
        </div>
      </div>

      {cleanupMutation.isError && (
        <p className="text-sm text-red-400">
          {cleanupMutation.error instanceof Error
            ? cleanupMutation.error.message
            : "Cleanup failed"}
        </p>
      )}

      {/* Disk Usage */}
      <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
        <h3 className="text-sm font-medium text-gray-400 mb-3">Disk Usage</h3>
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-4 text-sm">
          {Object.entries(docker.diskUsage).map(([key, value]) => (
            <div key={key}>
              <p className="text-xs text-gray-500 capitalize">{key.replace(/([A-Z])/g, " $1")}</p>
              <p className="text-gray-200 font-mono mt-0.5">{value}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Containers */}
      <div>
        <h3 className="text-sm font-medium text-gray-400 mb-3">Containers</h3>
        {docker.containers.length === 0 ? (
          <p className="text-sm text-gray-600">No containers found.</p>
        ) : (
          <div className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-800 text-left text-gray-500">
                  <th className="px-4 py-2 font-medium">Name</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                  <th className="px-4 py-2 font-medium">Image</th>
                </tr>
              </thead>
              <tbody>
                {docker.containers.map((c) => (
                  <tr
                    key={c.name}
                    className="border-b border-gray-800/50 hover:bg-gray-800/30 transition-colors"
                  >
                    <td className="px-4 py-2 font-mono text-gray-300">{c.name}</td>
                    <td className="px-4 py-2">
                      <span
                        className={`text-xs ${
                          c.status.includes("Up")
                            ? "text-green-400"
                            : "text-red-400"
                        }`}
                      >
                        {c.status}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-gray-500 font-mono text-xs">
                      {c.image}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Job Log */}
      {activeJobId && (
        <div>
          <DeployLog jobId={activeJobId} />
        </div>
      )}

      {/* Aggressive Cleanup Confirmation */}
      {confirmAggressive && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
          onClick={(e) => {
            if (e.target === e.currentTarget) setConfirmAggressive(false);
          }}
          role="dialog"
          aria-modal="true"
          aria-label="Confirm aggressive cleanup"
        >
          <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-md mx-4 shadow-2xl p-6">
            <h3 className="text-lg font-semibold mb-2">Aggressive Cleanup</h3>
            <div className="bg-red-950/40 border border-red-900/50 rounded-lg px-3 py-2 text-sm text-red-400 mb-4">
              WARNING: This will remove ALL stopped containers, unused images
              (including tagged), unused networks, and build cache. This cannot be undone.
            </div>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setConfirmAggressive(false)}
                className="px-4 py-2 text-sm text-gray-400 hover:text-white transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => cleanupMutation.mutate("aggressive")}
                disabled={cleanupMutation.isPending}
                className="bg-red-600 hover:bg-red-700 disabled:opacity-50 px-4 py-2 rounded-lg text-sm font-medium transition-colors"
              >
                {cleanupMutation.isPending ? "Cleaning..." : "Confirm Cleanup"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
