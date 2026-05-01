import React from "react";
import { HealthDot } from "./HealthDot.js";
import { HealthSparkline } from "./HealthSparkline.js";
import { CheckNowButton } from "./CheckNowButton.js";
import { useAppHealth } from "../../hooks/useAppHealth.js";
import { DomainTlsSection } from "./DomainTlsSection.js";

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
  };
}

export function ApplicationDetail({ app }: ApplicationDetailProps) {
  return (
    <div className="space-y-4 text-sm">
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
