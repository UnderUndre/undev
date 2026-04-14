import React, { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { api } from "../../lib/api.js";
import { DeployLog } from "../deploy/DeployLog.js";

interface SetupWizardProps {
  serverId: string;
}

interface SetupResponse {
  jobId: string;
}

const SETUP_TASKS = [
  { id: "deploy-user", label: "Deploy User", description: "Create dedicated deploy user with SSH access" },
  { id: "ssh-hardening", label: "SSH Hardening", description: "Disable root login, password auth" },
  { id: "firewall", label: "Firewall (UFW)", description: "Configure UFW with sensible defaults" },
  { id: "swap", label: "Swap", description: "Create and enable swap file" },
  { id: "nodejs", label: "Node.js", description: "Install Node.js via nvm" },
  { id: "ssl", label: "SSL", description: "Install certbot and configure HTTPS" },
] as const;

type TaskId = (typeof SETUP_TASKS)[number]["id"];

export function SetupWizard({ serverId }: SetupWizardProps) {
  const [selected, setSelected] = useState<Set<TaskId>>(new Set());
  const [activeJobId, setActiveJobId] = useState<string | null>(null);

  const setupMutation = useMutation({
    mutationFn: (tasks: TaskId[]) =>
      api.post<SetupResponse>(`/servers/${serverId}/setup`, { tasks }),
    onSuccess: (data) => {
      setActiveJobId(data.jobId);
    },
  });

  const toggleTask = (id: TaskId) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const toggleAll = () => {
    if (selected.size === SETUP_TASKS.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(SETUP_TASKS.map((t) => t.id)));
    }
  };

  const handleRun = () => {
    if (selected.size === 0) return;
    setupMutation.mutate(Array.from(selected));
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Server Setup</h2>
        <div className="flex items-center gap-3">
          <button
            onClick={toggleAll}
            className="text-xs text-gray-400 hover:text-white transition-colors"
          >
            {selected.size === SETUP_TASKS.length ? "Deselect All" : "Select All"}
          </button>
          <button
            onClick={handleRun}
            disabled={selected.size === 0 || setupMutation.isPending}
            className="bg-green-600 hover:bg-green-700 disabled:opacity-50 px-4 py-2 rounded-lg text-sm font-medium transition-colors"
          >
            {setupMutation.isPending ? "Running..." : `Run Setup (${selected.size})`}
          </button>
        </div>
      </div>

      {setupMutation.isError && (
        <p className="text-sm text-red-400">
          {setupMutation.error instanceof Error
            ? setupMutation.error.message
            : "Setup failed to start"}
        </p>
      )}

      {/* Task Checklist */}
      <div className="space-y-2">
        {SETUP_TASKS.map((task) => (
          <label
            key={task.id}
            className={`flex items-start gap-3 bg-gray-900 border rounded-lg p-3 cursor-pointer transition-colors ${
              selected.has(task.id)
                ? "border-blue-700 bg-blue-950/20"
                : "border-gray-800 hover:border-gray-700"
            }`}
          >
            <input
              type="checkbox"
              checked={selected.has(task.id)}
              onChange={() => toggleTask(task.id)}
              className="mt-0.5 rounded border-gray-600 bg-gray-800 text-blue-500 focus:ring-blue-500 focus:ring-offset-0"
            />
            <div>
              <span className="text-sm font-medium text-gray-200">{task.label}</span>
              <p className="text-xs text-gray-500 mt-0.5">{task.description}</p>
            </div>
          </label>
        ))}
      </div>

      {/* Job Log */}
      {activeJobId && (
        <div className="mt-4">
          <DeployLog jobId={activeJobId} />
        </div>
      )}
    </div>
  );
}
