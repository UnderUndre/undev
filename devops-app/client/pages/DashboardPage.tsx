import React, { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../lib/api.js";

interface Server {
  id: string;
  label: string;
  host: string;
  port: number;
  status: string;
  sshUser: string;
  sshKeyPath: string;
  scriptsPath: string;
  lastHealthCheck: string | null;
}

interface AddServerPayload {
  label: string;
  host: string;
  port: number;
  sshUser: string;
  sshKeyPath: string;
  scriptsPath: string;
}

const INITIAL_FORM: AddServerPayload = {
  label: "",
  host: "",
  port: 22,
  sshUser: "",
  sshKeyPath: "",
  scriptsPath: "",
};

export function DashboardPage() {
  const queryClient = useQueryClient();
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [form, setForm] = useState<AddServerPayload>(INITIAL_FORM);
  const [verifyStatus, setVerifyStatus] = useState<"idle" | "verifying" | "success" | "failed">("idle");
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [createdServerId, setCreatedServerId] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["servers"],
    queryFn: () => api.get<Server[]>("/servers"),
  });

  const addMutation = useMutation({
    mutationFn: (payload: AddServerPayload) =>
      api.post<Server>("/servers", payload),
    onSuccess: (server) => {
      queryClient.invalidateQueries({ queryKey: ["servers"] });
      setCreatedServerId(server.id);
    },
  });

  const handleVerify = async () => {
    if (!createdServerId) return;
    setVerifyStatus("verifying");
    setVerifyError(null);
    try {
      await api.post(`/servers/${createdServerId}/verify`);
      setVerifyStatus("success");
    } catch (err) {
      setVerifyStatus("failed");
      setVerifyError(err instanceof Error ? err.message : "Verification failed");
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    addMutation.mutate(form);
  };

  const updateField = <K extends keyof AddServerPayload>(key: K, value: AddServerPayload[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const openDialog = () => {
    setForm(INITIAL_FORM);
    setVerifyStatus("idle");
    setVerifyError(null);
    setCreatedServerId(null);
    setIsDialogOpen(true);
  };

  const closeDialog = () => {
    setIsDialogOpen(false);
    setCreatedServerId(null);
  };

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">Servers</h1>
        <button
          onClick={openDialog}
          className="bg-blue-600 hover:bg-blue-700 px-4 py-2 rounded-lg text-sm font-medium transition-colors"
        >
          Add Server
        </button>
      </div>

      {isLoading ? (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {[1, 2, 3].map((n) => (
            <div key={n} className="bg-gray-900 border border-gray-800 rounded-lg p-4 animate-pulse h-24" />
          ))}
        </div>
      ) : !data?.length ? (
        <div className="text-gray-500 text-center py-12">
          No servers configured. Click "Add Server" to get started.
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {data.map((server) => (
            <Link
              key={server.id}
              to={`/servers/${server.id}`}
              className="bg-gray-900 border border-gray-800 rounded-lg p-4 hover:border-gray-600 transition-colors group"
            >
              <div className="flex items-center justify-between mb-2">
                <h3 className="font-semibold group-hover:text-blue-400 transition-colors">
                  {server.label}
                </h3>
                <StatusBadge status={server.status} />
              </div>
              <p className="text-sm text-gray-400">
                {server.host}:{server.port}
              </p>
              {server.lastHealthCheck && (
                <p className="text-xs text-gray-600 mt-1">
                  Last check: {new Date(server.lastHealthCheck).toLocaleString()}
                </p>
              )}
            </Link>
          ))}
        </div>
      )}

      {/* Add Server Dialog */}
      {isDialogOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
          onClick={(e) => {
            if (e.target === e.currentTarget) closeDialog();
          }}
          role="dialog"
          aria-modal="true"
          aria-label="Add Server"
        >
          <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-lg mx-4 shadow-2xl">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-800">
              <h2 className="text-lg font-semibold">Add Server</h2>
              <button
                onClick={closeDialog}
                className="text-gray-500 hover:text-gray-300 text-xl leading-none"
                aria-label="Close dialog"
              >
                &times;
              </button>
            </div>

            <form onSubmit={handleSubmit} className="p-6 space-y-4">
              <FormField label="Label" required>
                <input
                  type="text"
                  value={form.label}
                  onChange={(e) => updateField("label", e.target.value)}
                  placeholder="production-1"
                  required
                  className="w-full bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500"
                />
              </FormField>

              <div className="grid grid-cols-3 gap-3">
                <FormField label="Host" className="col-span-2" required>
                  <input
                    type="text"
                    value={form.host}
                    onChange={(e) => updateField("host", e.target.value)}
                    placeholder="192.168.1.100"
                    required
                    className="w-full bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500"
                  />
                </FormField>
                <FormField label="Port">
                  <input
                    type="number"
                    value={form.port}
                    onChange={(e) => updateField("port", Number(e.target.value))}
                    min={1}
                    max={65535}
                    className="w-full bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500"
                  />
                </FormField>
              </div>

              <FormField label="SSH User" required>
                <input
                  type="text"
                  value={form.sshUser}
                  onChange={(e) => updateField("sshUser", e.target.value)}
                  placeholder="deploy"
                  required
                  className="w-full bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500"
                />
              </FormField>

              <FormField label="SSH Key Path" required>
                <input
                  type="text"
                  value={form.sshKeyPath}
                  onChange={(e) => updateField("sshKeyPath", e.target.value)}
                  placeholder="~/.ssh/id_ed25519"
                  required
                  className="w-full bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500"
                />
              </FormField>

              <FormField label="Scripts Path">
                <input
                  type="text"
                  value={form.scriptsPath}
                  onChange={(e) => updateField("scriptsPath", e.target.value)}
                  placeholder="/opt/scripts"
                  className="w-full bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500"
                />
              </FormField>

              {verifyStatus === "success" && (
                <div className="text-sm text-green-400 bg-green-950/30 border border-green-900/50 rounded-lg px-3 py-2">
                  Connection verified successfully
                </div>
              )}
              {verifyStatus === "failed" && verifyError && (
                <div className="text-sm text-red-400 bg-red-950/30 border border-red-900/50 rounded-lg px-3 py-2">
                  {verifyError}
                </div>
              )}

              {createdServerId && (
                <div className="text-sm text-green-400 bg-green-950/30 border border-green-900/50 rounded-lg px-3 py-2">
                  Server added. You can now verify the connection.
                </div>
              )}

              {addMutation.isError && (
                <div className="text-sm text-red-400">
                  {addMutation.error instanceof Error ? addMutation.error.message : "Failed to add server"}
                </div>
              )}

              <div className="flex justify-end gap-3 pt-2">
                {createdServerId ? (
                  <>
                    <button
                      type="button"
                      onClick={handleVerify}
                      disabled={verifyStatus === "verifying"}
                      className="bg-gray-700 hover:bg-gray-600 disabled:opacity-50 px-4 py-2 rounded-lg text-sm font-medium transition-colors"
                    >
                      {verifyStatus === "verifying" ? "Verifying..." : "Verify Connection"}
                    </button>
                    <button
                      type="button"
                      onClick={closeDialog}
                      className="bg-blue-600 hover:bg-blue-700 px-4 py-2 rounded-lg text-sm font-medium transition-colors"
                    >
                      Done
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={closeDialog}
                      className="px-4 py-2 text-sm text-gray-400 hover:text-white transition-colors"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      disabled={addMutation.isPending}
                      className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 px-4 py-2 rounded-lg text-sm font-medium transition-colors"
                    >
                      {addMutation.isPending ? "Adding..." : "Add Server"}
                    </button>
                  </>
                )}
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    online: "bg-green-900/50 text-green-400 border-green-700",
    offline: "bg-red-900/50 text-red-400 border-red-700",
    unknown: "bg-gray-800 text-gray-400 border-gray-600",
  };
  return (
    <span
      className={`text-xs px-2 py-0.5 rounded-full border ${colors[status] ?? colors.unknown}`}
    >
      {status}
    </span>
  );
}

function FormField({
  label,
  required,
  className,
  children,
}: {
  label: string;
  required?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <label className={`block ${className ?? ""}`}>
      <span className="text-sm text-gray-400 mb-1 block">
        {label}
        {required && <span className="text-red-500 ml-0.5">*</span>}
      </span>
      {children}
    </label>
  );
}
