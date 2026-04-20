import React, { useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api.js";
import { HealthPanel } from "../components/health/HealthPanel.js";
import { BackupsPanel } from "../components/backups/BackupsPanel.js";
import { LogViewer } from "../components/logs/LogViewer.js";
import { DockerPanel } from "../components/docker/DockerPanel.js";
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
  deployScript: string;
  currentCommit: string | null;
  currentVersion: string | null;
}

type AddAppPayload = AddAppFormValues & { source: AppSource };

const TABS = ["Apps", "Health", "Backups", "Logs", "Docker"] as const;
type Tab = (typeof TABS)[number];

const INITIAL_FORM: AddAppFormValues = {
  name: "",
  repoUrl: "",
  branch: "main",
  remotePath: "",
  deployScript: "",
  githubRepo: null,
};

interface AddFormState {
  initial: AddAppFormValues;
  source: AppSource;
  dockerMode: boolean;
  deployScriptSuggestions: string[];
}

const DEFAULT_ADD_STATE: AddFormState = {
  initial: INITIAL_FORM,
  source: "manual",
  dockerMode: false,
  deployScriptSuggestions: [],
};

export function ServerPage() {
  const { serverId } = useParams<{ serverId: string }>();
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<Tab>("Apps");
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [addState, setAddState] = useState<AddFormState>(DEFAULT_ADD_STATE);
  const [isScanOpen, setIsScanOpen] = useState(false);

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
        deployScript: c.suggestedDeployScripts[0] ?? "",
        githubRepo: c.githubRepo,
      },
      source: "scan",
      dockerMode: false,
      deployScriptSuggestions: c.suggestedDeployScripts,
    });
    setIsScanOpen(false);
    setIsAddOpen(true);
  };

  const handleImportDocker = (c: DockerCandidate) => {
    const primary = c.path ?? "";
    const remotePath = primary ? dirname(primary) : "";
    const suggestion =
      c.kind === "compose"
        ? "docker compose pull && docker compose up -d"
        : "";
    setAddState({
      initial: {
        name: c.name,
        repoUrl: `docker://${primary || c.name}`,
        branch: "-",
        remotePath,
        deployScript: suggestion,
        githubRepo: null,
      },
      source: "scan",
      dockerMode: true,
      deployScriptSuggestions: suggestion ? [suggestion] : [],
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
          scanDisabled={server.status !== "online"}
          onSubmit={(values) => addAppMutation.mutate(values)}
          mutation={addAppMutation}
        />
      )}

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
}) {
  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold">Applications</h2>
        <div className="flex gap-2">
          <button
            onClick={onOpenScan}
            disabled={scanDisabled}
            title={scanDisabled ? "Server is offline" : "Scan server for existing apps"}
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

      {/* Add Application Form (reused for manual and scan imports — T021) */}
      {isAddOpen && (
        <AddAppForm
          key={`${addState.source}-${addState.initial.name}-${addState.initial.remotePath}`}
          initialValues={addState.initial}
          source={addState.source}
          dockerMode={addState.dockerMode}
          deployScriptSuggestions={addState.deployScriptSuggestions}
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
          {apps.map((app) => (
            <Link
              key={app.id}
              to={`/apps/${app.id}`}
              className="flex items-center justify-between bg-gray-900 border border-gray-800 rounded-lg p-4 hover:border-gray-600 transition-colors group"
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
          ))}
        </div>
      )}
    </div>
  );
}

