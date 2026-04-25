import React from "react";

export interface ApplicationDetailProps {
  app: {
    id: string;
    name: string;
    repoUrl: string;
    branch: string;
    remotePath: string;
    scriptPath: string | null;
  };
}

export function ApplicationDetail({ app }: ApplicationDetailProps) {
  return (
    <div className="space-y-2 text-sm">
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
