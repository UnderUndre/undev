import React, { useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api.js";
import { HealthPanel } from "../components/health/HealthPanel.js";
import { BackupsPanel } from "../components/backups/BackupsPanel.js";
import { LogViewer } from "../components/logs/LogViewer.js";
import { DockerPanel } from "../components/docker/DockerPanel.js";
import { ScriptsTab } from "../components/scripts/ScriptsTab.js";
import {
  AddAppForm,
  type AppSource,
  type AddAppFormValues,
} from "../components/apps/AddAppForm.js";
import { ScanModal } from "../components/scan/ScanModal.js";
import type {
  GitCandidate,
  DockerCandidate,
} from "../hooks/useScan.js";

interface Server {
  id: string;
  label: string;
  host: string;
  port: number;
  status: string;
  sshUser: string;
  lastHealthCheck: string | null;
}

interface Application {
  id: string;
  serverId: string;
  name: string;
  repoUrl: string;
  branch: string;
  remotePath: string;
  currentCommit: string | null;
  currentVersion: string | null;
}

type AddAppPayload = AddAppFormValues & { source: AppSource };

const TABS = ["Apps", "Scripts", "Health", "Backups", "Logs", "Docker"] as const;
type Tab = (typeof TABS)[number];

const INITIAL_FORM: AddAppFormValues = {
  name: "",
  repoUrl: "",
  branch: "main",
  remotePath: "",
  githubRepo: null,
  scriptPath: null,
};

interface AddFormState {
  initial: AddAppFormValues;
  source: AppSource;
  dockerMode: boolean;
}

const DEFAULT_ADD_STATE: AddFormState = {
  initial: INITIAL_FORM,
  source: "manual",
  dockerMode: false,
};

export function ServerPage() {
  const { serverId } = useParams<{ serverId: string }>();
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<Tab>("Apps");
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [addState, setAddState] = useState<AddFormState>(DEFAULT_ADD_STATE);
  const [isScanOpen, setIsScanOpen] = useState(false);
  const [selectedAppIds, setSelectedAppIds] = useState<Set<string>>(
    () => new Set<string>(),
  );

  const { data: server, isLoading: serverLoading } = useQuery({
    queryKey: ["server", serverId],
    queryFn: () => api.get<Server>(`/servers/${serverId}`),
    enabled: Boolean(serverId),
  });

  const { data: apps, isLoading: appsLoading } = useQuery({
    queryKey: ["server", serverId, "apps"],
    queryFn: () => api.get<Application[]>(`/servers/${serverId}/apps`),
    enabled: Boolean(serverId) && activeTab === "Apps",
  });

  const addAppMutation = useMutation({
    mutationFn: (payload: AddAppPayload) =>
      api.post<Application>(`/servers/${serverId}/apps`, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["server", serverId, "apps"] });
      setIsAddOpen(false);
      setAddState(DEFAULT_ADD_STATE);
    },
  });

  const bulkDeleteMutation = useMutation({
    mutationFn: async (appIds: string[]) => {
      // Fire in parallel; surface the first error if any.
      const results = await Promise.allSettled(
        appIds.map((id) => api.delete<void>(`/apps/${id}`)),
      );
      const failures = results
        .map((r, i) => ({ r, id: appIds[i] }))
        .filter(({ r }) => r.status === "rejected");
      if (failures.length > 0) {
        const firstFailure = failures[0];
        const reason =
          firstFailure && firstFailure.r.status === "rejected"
            ? (firstFailure.r.reason as Error | undefined)
            : undefined;
        throw new Error(
          failures.length === 1
            ? reason?.message ?? "Delete failed"
            : `Failed to delete ${failures.length}/${appIds.length} applications`,
        );
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["server", serverId, "apps"] });
      setSelectedAppIds(new Set());
    },
  });

  const onToggleAppSelected = (id: string) => {
    setSelectedAppIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const onToggleSelectAll = (allAppIds: string[]) => {
    setSelectedAppIds((prev) =>
      prev.size === allAppIds.length ? new Set() : new Set(allAppIds),
    );
  };

  const onDeleteSelected = () => {
    const ids = [...selectedAppIds];
    if (ids.length === 0) return;
    const names =
      apps
        ?.filter((a) => selectedAppIds.has(a.id))
        .map((a) => `• ${a.name}`)
        .join("\n") ?? "";
    if (
      !window.confirm(
        `Delete ${ids.length} application${ids.length === 1 ? "" : "s"}?\n\n${names}\n\nThis removes the dashboard rows and their deployment history. It does NOT touch the remote filesystem or running services on the target server.`,
      )
    ) {
      return;
    }
    bulkDeleteMutation.mutate(ids);
  };

  const openManualAdd = () => {
    setAddState(DEFAULT_ADD_STATE);
    setIsAddOpen(true);
  };

  const handleImportGit = (c: GitCandidate) => {
    const name = basename(c.path);
    setAddState({
      initial: {
        name,
        repoUrl: c.remoteUrl ?? "",
        branch: c.detached ? "main" : c.branch || "main",
        remotePath: c.path,
        githubRepo: c.githubRepo,
        scriptPath: null,
      },
      source: "scan",
      dockerMode: false,
    });
    setIsScanOpen(false);
    setIsAddOpen(true);
  };

  const handleImportDocker = (c: DockerCandidate) => {
    const primary = c.path ?? "";
    const remotePath = primary ? dirname(primary) : "";
    setAddState({
      initial: {
        name: c.name,
        repoUrl: `docker://${primary || c.name}`,
        branch: "-",
        remotePath,
        githubRepo: null,
        scriptPath: null,
      },
      source: "scan",
      dockerMode: true,
    });
    setIsScanOpen(false);
    setIsAddOpen(true);
  };

  if (serverLoading) {
    return (
      <div className="p-6">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-gray-800 rounded w-48" />
          <div className="h-4 bg-gray-800 rounded w-32" />
        </div>
      </div>
    );
  }

  if (!server) {
    return (
      <div className="p-6">
        <p className="text-red-400">Server not found</p>
        <Link to="/" className="text-brand-purple hover:underline text-sm mt-2 inline-block">
          Back to servers
        </Link>
      </div>
    );
  }

  const statusColors: Record<string, string> = {
    online: "bg-green-500",
    offline: "bg-red-500",
    unknown: "bg-gray-500",
  };

  return (
    <div className="p-6">
      {/* Header */}
      <div className="mb-6">
        <Link to="/" className="text-sm text-gray-500 hover:text-gray-300 transition-colors">
          &larr; Servers
        </Link>
        <div className="flex items-center gap-3 mt-2">
          <span
            className={`w-2.5 h-2.5 rounded-full ${statusColors[server.status] ?? statusColors.unknown}`}
          />
          <h1 className="text-2xl font-bold">{server.label}</h1>
        </div>
        <p className="text-sm text-gray-400 mt-1">
          {server.host}:{server.port} &middot; {server.sshUser}
        </p>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-gray-800 mb-6" role="tablist">
        {TABS.map((tab) => (
          <button
            key={tab}
            role="tab"
            aria-selected={activeTab === tab}
            onClick={() => setActiveTab(tab)}
            className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
              activeTab === tab
                ? "text-brand-purple border-brand-purple"
                : "text-gray-500 border-transparent hover:text-gray-300"
            }`}
          >
            {tab}
          </button>
        ))}
      </div>

      {/* Tab Content */}
      {activeTab === "Apps" && (
        <AppsTab
          apps={apps}
          isLoading={appsLoading}
          isAddOpen={isAddOpen}
          addState={addState}
          onOpenAdd={openManualAdd}
          onCloseAdd={() => setIsAddOpen(false)}
          onOpenScan={() => setIsScanOpen(true)}
          scanDisabled={server.status === "offline"}
          onSubmit={(values) => addAppMutation.mutate(values)}
          mutation={addAppMutation}
          selectedIds={selectedAppIds}
          onToggleSelected={onToggleAppSelected}
          onToggleSelectAll={onToggleSelectAll}
          onDeleteSelected={onDeleteSelected}
          bulkDeleting={bulkDeleteMutation.isPending}
          bulkDeleteError={
            bulkDeleteMutation.isError
              ? (bulkDeleteMutation.error as Error)?.message ?? "Delete failed"
              : null
          }
        />
      )}

      {activeTab === "Scripts" && <ScriptsTab serverId={serverId!} />}
      {activeTab === "Health" && <HealthPanel serverId={serverId!} />}
      {activeTab === "Backups" && <BackupsPanel serverId={serverId!} />}
      {activeTab === "Logs" && <LogViewer serverId={serverId!} />}
      {activeTab === "Docker" && <DockerPanel serverId={serverId!} />}

      {isScanOpen && serverId && (
        <ScanModal
          serverId={serverId}
          onClose={() => setIsScanOpen(false)}
          onImportGit={handleImportGit}
          onImportDocker={handleImportDocker}
        />
      )}
    </div>
  );
}

function basename(p: string): string {
  const trimmed = p.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx < 0 ? trimmed : trimmed.slice(idx + 1);
}

function dirname(p: string): string {
  const trimmed = p.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx <= 0 ? "/" : trimmed.slice(0, idx);
}

function AppsTab({
  apps,
  isLoading,
  isAddOpen,
  addState,
  onOpenAdd,
  onCloseAdd,
  onOpenScan,
  scanDisabled,
  onSubmit,
  mutation,
  selectedIds,
  onToggleSelected,
  onToggleSelectAll,
  onDeleteSelected,
  bulkDeleting,
  bulkDeleteError,
}: {
  apps: Application[] | undefined;
  isLoading: boolean;
  isAddOpen: boolean;
  addState: AddFormState;
  onOpenAdd: () => void;
  onCloseAdd: () => void;
  onOpenScan: () => void;
  scanDisabled: boolean;
  onSubmit: (values: AddAppPayload) => void;
  mutation: { isPending: boolean; isError: boolean; error: Error | null };
  selectedIds: Set<string>;
  onToggleSelected: (id: string) => void;
  onToggleSelectAll: (allAppIds: string[]) => void;
  onDeleteSelected: () => void;
  bulkDeleting: boolean;
  bulkDeleteError: string | null;
}) {
  const allIds = apps?.map((a) => a.id) ?? [];
  const allChecked = allIds.length > 0 && selectedIds.size === allIds.length;
  const someChecked =
    selectedIds.size > 0 && selectedIds.size < allIds.length;
  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-semibold">Applications</h2>
          {apps && apps.length > 0 && (
            <label className="flex items-center gap-2 text-xs text-gray-400 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={allChecked}
                ref={(el) => {
                  if (el) el.indeterminate = someChecked;
                }}
                onChange={() => onToggleSelectAll(allIds)}
                className="accent-brand-purple"
              />
              {selectedIds.size > 0
                ? `${selectedIds.size} selected`
                : "Select all"}
            </label>
          )}
        </div>
        <div className="flex gap-2">
          {selectedIds.size > 0 && (
            <button
              onClick={onDeleteSelected}
              disabled={bulkDeleting}
              className="border border-red-800 hover:border-red-600 hover:bg-red-950/40 disabled:opacity-50 disabled:cursor-not-allowed px-3 py-1.5 rounded-lg text-sm font-medium transition-colors text-red-400"
            >
              {bulkDeleting
                ? `Deleting ${selectedIds.size}…`
                : `Delete Selected (${selectedIds.size})`}
            </button>
          )}
          <button
            onClick={onOpenScan}
            disabled={scanDisabled}
            title={
              scanDisabled
                ? "Server is offline"
                : "Scan server for existing apps (status unknown — scan will verify connection)"
            }
            className="border border-gray-700 hover:border-gray-500 disabled:border-gray-800 disabled:text-gray-600 disabled:cursor-not-allowed px-3 py-1.5 rounded-lg text-sm font-medium transition-colors text-gray-200"
          >
            Scan Server
          </button>
          <button
            onClick={onOpenAdd}
            className="bg-brand-purple hover:bg-purple-600 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors"
          >
            Add Application
          </button>
        </div>
      </div>
      {bulkDeleteError && (
        <div className="mb-3 p-2 bg-red-950/40 border border-red-800 text-red-200 text-sm rounded">
          {bulkDeleteError}
        </div>
      )}

      {/* Add Application Form (reused for manual and scan imports — T021) */}
      {isAddOpen && (
        <AddAppForm
          key={`${addState.source}-${addState.initial.name}-${addState.initial.remotePath}`}
          initialValues={addState.initial}
          source={addState.source}
          dockerMode={addState.dockerMode}
          onSubmit={onSubmit}
          onCancel={onCloseAdd}
          mutation={mutation}
        />
      )}

      {/* App List */}
      {isLoading ? (
        <div className="space-y-3">
          {[1, 2].map((n) => (
            <div key={n} className="bg-gray-900 border border-gray-800 rounded-lg p-4 animate-pulse h-16" />
          ))}
        </div>
      ) : !apps?.length ? (
        <div className="text-gray-500 text-center py-8">
          No applications configured for this server.
        </div>
      ) : (
        <div className="space-y-2">
          {apps.map((app) => {
            const checked = selectedIds.has(app.id);
            return (
              <div
                key={app.id}
                className={`relative bg-gray-900 border rounded-lg hover:border-gray-600 transition-colors group ${
                  checked ? "border-brand-purple" : "border-gray-800"
                }`}
              >
                <label
                  className="absolute top-1/2 left-3 -translate-y-1/2 p-1.5 cursor-pointer"
                  onClick={(e) => e.stopPropagation()}
                  aria-label={`Select ${app.name}`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => onToggleSelected(app.id)}
                    className="accent-brand-purple"
                  />
                </label>
                <Link
                  to={`/apps/${app.id}`}
                  className="flex items-center justify-between p-4 pl-12"
                >
                  <div>
                    <h3 className="font-medium group-hover:text-brand-purple transition-colors">
                      {app.name}
                    </h3>
                    <p className="text-xs text-gray-500 mt-0.5">
                      {app.branch} &middot; {app.remotePath}
                    </p>
                  </div>
                  <div className="text-right text-xs text-gray-500">
                    {app.currentCommit && (
                      <span className="font-mono">{app.currentCommit.slice(0, 7)}</span>
                    )}
                    {app.currentVersion && (
                      <span className="ml-2 text-gray-400">{app.currentVersion}</span>
                    )}
                  </div>
                </Link>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

