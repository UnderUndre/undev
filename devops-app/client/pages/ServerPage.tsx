import React, { useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api.js";
import { HealthPanel } from "../components/health/HealthPanel.js";
import { BackupsPanel } from "../components/backups/BackupsPanel.js";
import { LogViewer } from "../components/logs/LogViewer.js";
import { DockerPanel } from "../components/docker/DockerPanel.js";

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

interface AddAppPayload {
  name: string;
  repoUrl: string;
  branch: string;
  remotePath: string;
  deployScript: string;
}

const TABS = ["Apps", "Health", "Backups", "Logs", "Docker"] as const;
type Tab = (typeof TABS)[number];

const INITIAL_FORM: AddAppPayload = {
  name: "",
  repoUrl: "",
  branch: "main",
  remotePath: "",
  deployScript: "",
};

export function ServerPage() {
  const { serverId } = useParams<{ serverId: string }>();
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<Tab>("Apps");
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [form, setForm] = useState<AddAppPayload>(INITIAL_FORM);

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
      setForm(INITIAL_FORM);
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    addAppMutation.mutate(form);
  };

  const updateField = <K extends keyof AddAppPayload>(key: K, value: AddAppPayload[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
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
        <Link to="/" className="text-blue-400 hover:underline text-sm mt-2 inline-block">
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
                ? "text-blue-400 border-blue-400"
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
          onOpenAdd={() => {
            setForm(INITIAL_FORM);
            setIsAddOpen(true);
          }}
          onCloseAdd={() => setIsAddOpen(false)}
          form={form}
          updateField={updateField}
          onSubmit={handleSubmit}
          mutation={addAppMutation}
        />
      )}

      {activeTab === "Health" && <HealthPanel serverId={serverId!} />}
      {activeTab === "Backups" && <BackupsPanel serverId={serverId!} />}
      {activeTab === "Logs" && <LogViewer serverId={serverId!} />}
      {activeTab === "Docker" && <DockerPanel serverId={serverId!} />}
    </div>
  );
}

function AppsTab({
  apps,
  isLoading,
  isAddOpen,
  onOpenAdd,
  onCloseAdd,
  form,
  updateField,
  onSubmit,
  mutation,
}: {
  apps: Application[] | undefined;
  isLoading: boolean;
  isAddOpen: boolean;
  onOpenAdd: () => void;
  onCloseAdd: () => void;
  form: AddAppPayload;
  updateField: <K extends keyof AddAppPayload>(key: K, value: AddAppPayload[K]) => void;
  onSubmit: (e: React.FormEvent) => void;
  mutation: { isPending: boolean; isError: boolean; error: Error | null };
}) {
  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold">Applications</h2>
        <button
          onClick={onOpenAdd}
          className="bg-blue-600 hover:bg-blue-700 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors"
        >
          Add Application
        </button>
      </div>

      {/* Add Application Form */}
      {isAddOpen && (
        <form
          onSubmit={onSubmit}
          className="bg-gray-900 border border-gray-800 rounded-lg p-4 mb-4 space-y-3"
        >
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="text-sm text-gray-400 mb-1 block">
                Name <span className="text-red-500">*</span>
              </span>
              <input
                type="text"
                value={form.name}
                onChange={(e) => updateField("name", e.target.value)}
                placeholder="my-api"
                required
                className="w-full bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500"
              />
            </label>
            <label className="block">
              <span className="text-sm text-gray-400 mb-1 block">
                Branch
              </span>
              <input
                type="text"
                value={form.branch}
                onChange={(e) => updateField("branch", e.target.value)}
                placeholder="main"
                className="w-full bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500"
              />
            </label>
          </div>

          <label className="block">
            <span className="text-sm text-gray-400 mb-1 block">
              Repository URL <span className="text-red-500">*</span>
            </span>
            <input
              type="text"
              value={form.repoUrl}
              onChange={(e) => updateField("repoUrl", e.target.value)}
              placeholder="git@github.com:org/repo.git"
              required
              className="w-full bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500"
            />
          </label>

          <label className="block">
            <span className="text-sm text-gray-400 mb-1 block">
              Remote Path <span className="text-red-500">*</span>
            </span>
            <input
              type="text"
              value={form.remotePath}
              onChange={(e) => updateField("remotePath", e.target.value)}
              placeholder="/var/www/my-api"
              required
              className="w-full bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500"
            />
          </label>

          <label className="block">
            <span className="text-sm text-gray-400 mb-1 block">
              Deploy Script
            </span>
            <input
              type="text"
              value={form.deployScript}
              onChange={(e) => updateField("deployScript", e.target.value)}
              placeholder="deploy.sh"
              className="w-full bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500"
            />
          </label>

          {mutation.isError && (
            <div className="text-sm text-red-400">
              {mutation.error instanceof Error ? mutation.error.message : "Failed to add application"}
            </div>
          )}

          <div className="flex justify-end gap-3">
            <button
              type="button"
              onClick={onCloseAdd}
              className="px-3 py-1.5 text-sm text-gray-400 hover:text-white transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={mutation.isPending}
              className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors"
            >
              {mutation.isPending ? "Adding..." : "Add"}
            </button>
          </div>
        </form>
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
                <h3 className="font-medium group-hover:text-blue-400 transition-colors">
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

