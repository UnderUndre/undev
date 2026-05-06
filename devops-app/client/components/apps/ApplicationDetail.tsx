import React, { useState } from "react";
import { HealthDot } from "./HealthDot.js";
import { HealthSparkline } from "./HealthSparkline.js";
import { CheckNowButton } from "./CheckNowButton.js";
import { useAppHealth } from "../../hooks/useAppHealth.js";
import { DomainTlsSection } from "./DomainTlsSection.js";
import { BootstrapStateBadge } from "../bootstrap/BootstrapStateBadge.js";
import { EditBootstrapConfigDialog } from "../bootstrap/EditBootstrapConfigDialog.js";
import { HardDeleteDialog } from "../bootstrap/HardDeleteDialog.js";
import { bootstrapApi, type BootstrapStep } from "../../lib/bootstrap-api.js";

export interface ApplicationDetailProps {
  app: {
    id: string;
    name: string;
    repoUrl: string;
    branch: string;
    remotePath: string;
    scriptPath: string | null;
    domain?: string | null;
    acmeEmail?: string | null;
    bootstrapState?: string | null;
    composePath?: string | null;
    upstreamService?: string | null;
    upstreamPort?: number | null;
  };
  onChanged?: () => void;
}

export function ApplicationDetail({ app, onChanged }: ApplicationDetailProps) {
  const isFailed = typeof app.bootstrapState === "string" && app.bootstrapState.startsWith("failed_");
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const failedStep = isFailed ? (app.bootstrapState!.replace("failed_", "") as BootstrapStep) : null;

  const onRetry = async () => {
    if (!failedStep) return;
    try {
      await bootstrapApi.retryFromStep(app.id, failedStep);
      onChanged?.();
    } catch {
      /* surfaced upstream */
    }
  };

  return (
    <div className="space-y-4 text-sm">
      {app.bootstrapState && (
        <div className="flex items-center gap-2">
          <BootstrapStateBadge
            state={app.bootstrapState as Parameters<typeof BootstrapStateBadge>[0]["state"]}
            appId={app.id}
          />
          {isFailed && (
            <div className="flex gap-2">
              <button
                type="button"
                className="px-2 py-1 text-xs rounded bg-blue-700"
                onClick={() => void onRetry()}
              >
                Retry from {failedStep}
              </button>
              <button
                type="button"
                className="px-2 py-1 text-xs rounded bg-gray-700"
                onClick={() => setEditOpen(true)}
              >
                Edit Config
              </button>
              <button
                type="button"
                className="px-2 py-1 text-xs rounded bg-red-700"
                onClick={() => setDeleteOpen(true)}
              >
                Hard Delete
              </button>
            </div>
          )}
        </div>
      )}
      <div className="space-y-2">
        <Row label="Name" value={app.name} />
        <Row label="Branch" value={app.branch} />
        <Row label="Remote path" value={<code>{app.remotePath}</code>} />
        <Row label="Repo" value={<code>{app.repoUrl}</code>} />
        <Row
          label="Deploy script"
          value={
            app.scriptPath ? (
              <span className="font-mono">
                <span className="rounded bg-gray-800 px-1.5 py-0.5 text-xs text-gray-300 border border-gray-700 mr-2">
                  project-local
                </span>
                {app.scriptPath}
              </span>
            ) : (
              <span className="text-gray-500">
                builtin (scripts/deploy/server-deploy.sh)
              </span>
            )
          }
        />
      </div>
      <HealthSection appId={app.id} />
      <DomainTlsSection
        app={{
          id: app.id,
          name: app.name,
          domain: app.domain ?? null,
          acmeEmail: app.acmeEmail ?? null,
        }}
      />
      {editOpen && (
        <EditBootstrapConfigDialog
          appId={app.id}
          initial={{
            branch: app.branch,
            composePath: app.composePath ?? "docker-compose.yml",
            upstreamService: app.upstreamService ?? null,
            upstreamPort: app.upstreamPort ?? null,
            remotePath: app.remotePath,
            repoUrl: app.repoUrl,
          }}
          onClose={() => setEditOpen(false)}
          onSaved={() => {
            setEditOpen(false);
            onChanged?.();
          }}
        />
      )}
      {deleteOpen && (
        <HardDeleteDialog
          appId={app.id}
          appName={app.name}
          onClose={() => setDeleteOpen(false)}
          onDeleted={() => {
            setDeleteOpen(false);
            onChanged?.();
          }}
        />
      )}
    </div>
  );
}

// Feature 006 T026 — Health section inside ApplicationDetail.
// Renders a large dot, last-checked timestamp, message, and the 24h
// sparkline. Live updates flow through `useAppHealth`'s WS subscription.
function HealthSection({ appId }: { appId: string }) {
  const { health } = useAppHealth(appId);
  return (
    <section
      className="rounded-lg border border-gray-800 bg-gray-900/40 p-4 space-y-3"
      aria-label="Application health"
    >
      <header className="flex items-center gap-3">
        <HealthDot appId={appId} size="lg" />
        <div className="flex-1">
          <h3 className="text-sm font-semibold text-gray-100">Health</h3>
          <p className="text-xs text-gray-500">
            {health?.checkedAt
              ? `Last checked ${new Date(health.checkedAt).toLocaleString()}`
              : "Awaiting first probe"}
            {health?.config?.alertsMuted && " · alerts muted"}
            {health?.config?.monitoringEnabled === false && " · monitoring disabled"}
          </p>
        </div>
        <CheckNowButton
          appId={appId}
          monitoringEnabled={health?.config?.monitoringEnabled !== false}
        />
      </header>
      {health?.message && (
        <p className="text-xs text-gray-400">{health.message}</p>
      )}
      <HealthSparkline appId={appId} width={480} height={36} />
    </section>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <span className="text-gray-500 w-32">{label}:</span>
      <span className="text-gray-200">{value}</span>
    </div>
  );
}
