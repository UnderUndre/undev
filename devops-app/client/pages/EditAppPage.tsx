import React from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api.js";
import {
  EditAppForm,
  type EditAppFormValues,
} from "../components/apps/EditAppForm.js";

interface Application {
  id: string;
  name: string;
  branch: string;
  remotePath: string;
  scriptPath: string | null;
  composePath: string | null;
  upstreamService: string | null;
  upstreamPort: number | null;
  // Feature 006 — health columns surfaced on GET /apps/:id (T019).
  healthUrl: string | null;
  monitoringEnabled: boolean;
  alertsMuted: boolean;
  healthProbeIntervalSec: number;
  healthDebounceCount: number;
}

export function EditAppPage() {
  const { appId } = useParams<{ appId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data: app, isLoading } = useQuery({
    queryKey: ["app", appId],
    queryFn: () => api.get<Application>(`/apps/${appId}`),
    enabled: Boolean(appId),
  });

  const mutation = useMutation({
    mutationFn: (values: EditAppFormValues) => {
      // Transform UI text fields → API shape (string → number|null for port,
      // empty string → null for upstreamService).
      const port = values.upstreamPort.trim();
      const payload = {
        ...values,
        upstreamService: values.upstreamService.trim() === "" ? null : values.upstreamService.trim(),
        upstreamPort: port === "" ? null : Number(port),
      };
      return api.put<Application>(`/apps/${appId}`, payload);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["app", appId] });
      navigate(`/apps/${appId}`);
    },
  });

  if (isLoading) {
    return <div className="p-6 text-gray-400">Loading…</div>;
  }
  if (!app) {
    return (
      <div className="p-6">
        <div className="text-gray-400 mb-2">Application not found</div>
        <Link to="/" className="text-sm text-brand-purple hover:underline">
          &larr; Dashboard
        </Link>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-2xl">
      <Link
        to={`/apps/${appId}`}
        className="text-sm text-gray-500 hover:text-gray-300 transition-colors"
      >
        &larr; {app.name}
      </Link>
      <h1 className="text-2xl font-bold mt-2 mb-4">Edit application</h1>
      <EditAppForm
        initialValues={{
          name: app.name,
          branch: app.branch,
          remotePath: app.remotePath,
          scriptPath: app.scriptPath,
          composePath: app.composePath ?? "",
          upstreamService: app.upstreamService ?? "",
          upstreamPort: app.upstreamPort !== null && app.upstreamPort !== undefined ? String(app.upstreamPort) : "",
          healthUrl: app.healthUrl,
          monitoringEnabled: app.monitoringEnabled,
          alertsMuted: app.alertsMuted,
          healthProbeIntervalSec: app.healthProbeIntervalSec,
          healthDebounceCount: app.healthDebounceCount,
        }}
        onSubmit={(values) => mutation.mutate(values)}
        onCancel={() => navigate(`/apps/${appId}`)}
        mutation={{
          isPending: mutation.isPending,
          isError: mutation.isError,
          error: mutation.error as Error | null,
        }}
      />
    </div>
  );
}
