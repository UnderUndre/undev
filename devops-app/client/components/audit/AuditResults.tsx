import React, { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { api } from "../../lib/api.js";
import { DeployLog } from "../deploy/DeployLog.js";

interface AuditResultsProps {
  appId: string;
}

interface AuditResponse {
  jobId: string;
}

export function AuditResults({ appId }: AuditResultsProps) {
  const [activeJobId, setActiveJobId] = useState<string | null>(null);

  const auditMutation = useMutation({
    mutationFn: () => api.post<AuditResponse>(`/apps/${appId}/audit`),
    onSuccess: (data) => {
      setActiveJobId(data.jobId);
    },
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Security Audit</h2>
        <button
          onClick={() => auditMutation.mutate()}
          disabled={auditMutation.isPending}
          className="bg-brand-purple hover:bg-purple-600 disabled:opacity-50 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors"
        >
          {auditMutation.isPending ? "Starting..." : "Run Security Audit"}
        </button>
      </div>

      {auditMutation.isError && (
        <p className="text-sm text-red-400">
          {auditMutation.error instanceof Error
            ? auditMutation.error.message
            : "Failed to start audit"}
        </p>
      )}

      {activeJobId && <DeployLog jobId={activeJobId} />}

      {!activeJobId && (
        <div className="text-center py-12 text-gray-600">
          <p>Run a security audit to check for vulnerabilities.</p>
          <p className="text-xs mt-1 text-gray-700">
            Results will appear here after the audit completes.
          </p>
        </div>
      )}
    </div>
  );
}
