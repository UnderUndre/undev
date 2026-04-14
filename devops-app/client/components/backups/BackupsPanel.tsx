import React, { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api.js";
import { DeployLog } from "../deploy/DeployLog.js";

interface BackupsPanelProps {
  serverId: string;
}

interface Backup {
  id: string;
  name: string;
  database: string;
  fileSize: number;
  date: string;
  status: "complete" | "in_progress" | "failed";
}

interface BackupResponse {
  jobId: string;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const k = 1024;
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const size = bytes / k ** i;
  return `${size.toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}

function StatusBadge({ status }: { status: Backup["status"] }) {
  const styles: Record<Backup["status"], string> = {
    complete: "bg-green-900/30 text-green-400 border-green-800",
    in_progress: "bg-blue-900/30 text-blue-400 border-blue-800",
    failed: "bg-red-900/30 text-red-400 border-red-800",
  };

  return (
    <span
      className={`text-xs px-2 py-0.5 rounded-full border ${styles[status]}`}
    >
      {status.replace("_", " ")}
    </span>
  );
}

export function BackupsPanel({ serverId }: BackupsPanelProps) {
  const queryClient = useQueryClient();
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [dbName, setDbName] = useState("");
  const [restoreTarget, setRestoreTarget] = useState<Backup | null>(null);

  const { data: backups, isLoading } = useQuery({
    queryKey: ["server", serverId, "backups"],
    queryFn: () => api.get<Backup[]>(`/servers/${serverId}/backups`),
    enabled: Boolean(serverId),
  });

  const createMutation = useMutation({
    mutationFn: (database: string) =>
      api.post<BackupResponse>(`/servers/${serverId}/backups`, { database }),
    onSuccess: (data) => {
      setActiveJobId(data.jobId);
      setIsCreateOpen(false);
      setDbName("");
      queryClient.invalidateQueries({
        queryKey: ["server", serverId, "backups"],
      });
    },
  });

  const restoreMutation = useMutation({
    mutationFn: (backupId: string) =>
      api.post<BackupResponse>(`/backups/${backupId}/restore`, undefined),
    onSuccess: (data) => {
      setActiveJobId(data.jobId);
      setRestoreTarget(null);
      queryClient.invalidateQueries({
        queryKey: ["server", serverId, "backups"],
      });
    },
  });

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    if (dbName.trim()) {
      createMutation.mutate(dbName.trim());
    }
  };

  const handleRestore = () => {
    if (!restoreTarget) return;
    restoreMutation.mutate(restoreTarget.id);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Backups</h2>
        <button
          onClick={() => setIsCreateOpen(true)}
          className="bg-blue-600 hover:bg-blue-700 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors"
        >
          Create Backup
        </button>
      </div>

      {/* Create Backup Form */}
      {isCreateOpen && (
        <form
          onSubmit={handleCreate}
          className="bg-gray-900 border border-gray-800 rounded-lg p-4 space-y-3"
        >
          <label className="block">
            <span className="text-sm text-gray-400 mb-1 block">
              Database Name <span className="text-red-500">*</span>
            </span>
            <input
              type="text"
              value={dbName}
              onChange={(e) => setDbName(e.target.value)}
              placeholder="my_database"
              required
              className="w-full bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500"
            />
          </label>
          {createMutation.isError && (
            <p className="text-sm text-red-400">
              {createMutation.error instanceof Error
                ? createMutation.error.message
                : "Failed to create backup"}
            </p>
          )}
          <div className="flex justify-end gap-3">
            <button
              type="button"
              onClick={() => {
                setIsCreateOpen(false);
                setDbName("");
              }}
              className="px-3 py-1.5 text-sm text-gray-400 hover:text-white transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={createMutation.isPending}
              className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors"
            >
              {createMutation.isPending ? "Creating..." : "Create"}
            </button>
          </div>
        </form>
      )}

      {/* Active Job Log */}
      {activeJobId && (
        <div className="mb-4">
          <DeployLog jobId={activeJobId} />
        </div>
      )}

      {/* Backups Table */}
      {isLoading ? (
        <div className="space-y-2">
          {[1, 2, 3].map((n) => (
            <div key={n} className="h-10 bg-gray-800 rounded animate-pulse" />
          ))}
        </div>
      ) : !backups?.length ? (
        <p className="text-gray-600 text-center py-8">No backups found.</p>
      ) : (
        <div className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800 text-left text-gray-500">
                <th className="px-4 py-2 font-medium">Name / Database</th>
                <th className="px-4 py-2 font-medium">Size</th>
                <th className="px-4 py-2 font-medium">Date</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium" />
              </tr>
            </thead>
            <tbody>
              {backups.map((b) => (
                <tr
                  key={b.id}
                  className="border-b border-gray-800/50 hover:bg-gray-800/30 transition-colors"
                >
                  <td className="px-4 py-2">
                    <span className="text-gray-200">{b.name}</span>
                    <span className="text-gray-600 ml-2 text-xs">{b.database}</span>
                  </td>
                  <td className="px-4 py-2 text-gray-400 font-mono text-xs">
                    {formatBytes(b.fileSize)}
                  </td>
                  <td className="px-4 py-2 text-gray-500 text-xs">
                    {new Date(b.date).toLocaleString()}
                  </td>
                  <td className="px-4 py-2">
                    <StatusBadge status={b.status} />
                  </td>
                  <td className="px-4 py-2 text-right">
                    {b.status === "complete" && (
                      <button
                        onClick={() => setRestoreTarget(b)}
                        className="text-xs text-yellow-500 hover:text-yellow-400 transition-colors"
                      >
                        Restore
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Restore Confirmation Dialog */}
      {restoreTarget && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
          onClick={(e) => {
            if (e.target === e.currentTarget) setRestoreTarget(null);
          }}
          role="dialog"
          aria-modal="true"
          aria-label="Confirm backup restore"
        >
          <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-md mx-4 shadow-2xl p-6">
            <h3 className="text-lg font-semibold mb-2">Confirm Restore</h3>
            <p className="text-sm text-gray-400 mb-3">
              Restore backup <span className="text-gray-200">{restoreTarget.name}</span>{" "}
              for database <span className="text-gray-200 font-mono">{restoreTarget.database}</span>?
            </p>
            <div className="bg-red-950/40 border border-red-900/50 rounded-lg px-3 py-2 text-sm text-red-400 mb-4">
              WARNING: This will overwrite the current database contents. This action
              cannot be undone. Make sure you have a recent backup of the current state.
            </div>

            {restoreMutation.isError && (
              <p className="text-sm text-red-400 mb-3">
                {restoreMutation.error instanceof Error
                  ? restoreMutation.error.message
                  : "Restore failed"}
              </p>
            )}

            <div className="flex justify-end gap-3">
              <button
                onClick={() => setRestoreTarget(null)}
                className="px-4 py-2 text-sm text-gray-400 hover:text-white transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleRestore}
                disabled={restoreMutation.isPending}
                className="bg-red-600 hover:bg-red-700 disabled:opacity-50 px-4 py-2 rounded-lg text-sm font-medium transition-colors"
              >
                {restoreMutation.isPending ? "Restoring..." : "Confirm Restore"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
