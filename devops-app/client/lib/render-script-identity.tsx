import React, { type ReactNode } from "react";

interface ScriptRunLike {
  scriptId: string;
  params?: unknown;
}

function extractScriptPath(params: unknown): string | undefined {
  if (params && typeof params === "object" && "scriptPath" in params) {
    const sp = (params as Record<string, unknown>).scriptPath;
    return typeof sp === "string" ? sp : undefined;
  }
  return undefined;
}

export function renderScriptIdentity(run: ScriptRunLike): ReactNode {
  if (run.scriptId === "deploy/project-local-deploy") {
    const path = extractScriptPath(run.params) ?? "<unknown>";
    return (
      <span className="font-mono">
        <span className="rounded bg-gray-800 px-1.5 py-0.5 text-xs text-gray-300 border border-gray-700 mr-2">
          project-local
        </span>
        {path}
      </span>
    );
  }
  return <span className="font-mono">{run.scriptId}</span>;
}
