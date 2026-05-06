/** Feature 009 T051 + Feature 010 T063 — hard-delete dialog with typed-name confirm. */
import React, { useState } from "react";
import { api, ApiError } from "../../lib/api.js";
import { bootstrapApi } from "../../lib/bootstrap-api.js";
import { FailureCard } from "../failure/FailureCard.js";

export interface HardDeleteDialogProps {
  appId: string;
  appName: string;
  onClose: () => void;
  onDeleted: () => void;
}

type Stage = "confirm" | "executing" | "done" | "error" | "hook_failed" | "force_confirm";

interface HookFailureDetail {
  hookPath: string;
  exitCode: number;
  sshStderr?: string;
}

export function HardDeleteDialog({ appId, appName, onClose, onDeleted }: HardDeleteDialogProps) {
  const [typed, setTyped] = useState("");
  const [forceTyped, setForceTyped] = useState("");
  const [stage, setStage] = useState<Stage>("confirm");
  const [error, setError] = useState<string | null>(null);
  const [removed, setRemoved] = useState<{ remotePath: string; resolved: string } | null>(null);
  const [hookFailure, setHookFailure] = useState<HookFailureDetail | null>(null);

  async function execute() {
    setStage("executing");
    setError(null);
    try {
      const res = await bootstrapApi.hardDelete(appId, typed);
      setRemoved(res.removed);
      setStage("done");
      onDeleted();
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.code === "pre_destroy_hook_failed") {
          const d = (err.details as HookFailureDetail | undefined) ?? {
            hookPath: "(unknown)",
            exitCode: -1,
          };
          setHookFailure(d);
          setStage("hook_failed");
          return;
        }
        if (err.code === "JAIL_ESCAPE") {
          setError(`Refused: target path resolved outside the jail. Investigate manually before retry.`);
        } else if (err.code === "SSH_UNREACHABLE") {
          setError(`Server unreachable. Partial cleanup may have occurred.`);
        } else {
          setError(`${err.code}: ${err.message}`);
        }
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
      setStage("error");
    }
  }

  async function executeForce() {
    setStage("executing");
    setError(null);
    try {
      // Bootstrap router accepts ?force=true on POST /hard-delete.
      const res = await api.post<{ id: string; removed: { remotePath: string; resolved: string } }>(
        `/applications/${appId}/hard-delete?force=true`,
        { confirmName: typed || appName },
      );
      setRemoved(res.removed);
      setStage("done");
      onDeleted();
    } catch (err) {
      if (err instanceof ApiError) {
        setError(`${err.code}: ${err.message}`);
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
      setStage("error");
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Hard delete bootstrapped app"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70"
    >
      <div className="bg-gray-900 border border-red-800 rounded-lg p-5 w-full max-w-lg space-y-3 text-sm">
        <h2 className="text-lg font-semibold text-red-400">Hard delete: {appName}</h2>
        {stage === "confirm" && (
          <>
            <p className="text-sm">
              This will: revoke the cert (if any) → <code>docker compose down -v</code> → realpath
              jail check → <code>rm -rf $remotePath</code> → delete the DB row.
            </p>
            <input
              type="text"
              className="w-full rounded bg-gray-800 border border-gray-700 px-2 py-1 font-mono"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder={appName}
            />
            <div className="text-xs text-gray-500">
              Type the app name to confirm: <code>{appName}</code>
            </div>
            <div className="flex justify-end gap-2">
              <button type="button" className="px-3 py-1 rounded bg-gray-700 text-sm" onClick={onClose}>
                Cancel
              </button>
              <button
                type="button"
                className="px-3 py-1 rounded bg-red-700 text-sm disabled:opacity-50"
                disabled={typed !== appName}
                onClick={() => void execute()}
              >
                Hard delete
              </button>
            </div>
          </>
        )}
        {stage === "executing" && <div className="text-sm">Removing… cert → compose down → rm -rf</div>}
        {stage === "done" && (
          <>
            <div className="text-green-400 text-sm">Done.</div>
            {removed && (
              <pre className="bg-black border border-gray-800 rounded p-2 text-xs">
                {`remotePath: ${removed.remotePath}\nresolved:   ${removed.resolved}`}
              </pre>
            )}
            <div className="flex justify-end">
              <button type="button" onClick={onClose} className="px-3 py-1 rounded bg-gray-700 text-sm">
                Close
              </button>
            </div>
          </>
        )}
        {stage === "error" && (
          <>
            <div className="text-red-400 text-sm">{error}</div>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={onClose} className="px-3 py-1 rounded bg-gray-700 text-sm">
                Close
              </button>
              <button
                type="button"
                onClick={() => setStage("confirm")}
                className="px-3 py-1 rounded bg-blue-700 text-sm"
              >
                Try again
              </button>
            </div>
          </>
        )}
        {stage === "hook_failed" && hookFailure && (
          <FailureCard
            state="pre_destroy_hook_failed"
            summary={`pre_destroy hook ${hookFailure.hookPath} exited ${hookFailure.exitCode}`}
            details={
              hookFailure.sshStderr ? (
                <pre className="whitespace-pre-wrap break-all text-[11px] bg-black/40 border border-red-900 rounded p-1">
                  {hookFailure.sshStderr}
                </pre>
              ) : null
            }
            actions={[
              {
                kind: "Retry",
                trigger: { type: "callback", onClick: () => void execute() },
              },
              {
                kind: "ForceDelete",
                trigger: { type: "callback", onClick: () => setStage("force_confirm") },
              },
            ]}
          />
        )}
        {stage === "force_confirm" && (
          <>
            <div className="rounded border border-red-700 bg-red-950/40 px-3 py-2 text-sm text-red-200">
              <p className="font-semibold">Force delete bypasses the failed hook.</p>
              <p className="text-xs mt-1">
                The action is audited as <code>app.hard_deleted_force_bypass</code> with the
                skipped hook path. Type the app name again to confirm.
              </p>
            </div>
            <input
              type="text"
              className="w-full rounded bg-gray-800 border border-gray-700 px-2 py-1 font-mono"
              value={forceTyped}
              onChange={(e) => setForceTyped(e.target.value)}
              placeholder={appName}
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setStage("hook_failed")}
                className="px-3 py-1 rounded bg-gray-700 text-sm"
              >
                Back
              </button>
              <button
                type="button"
                disabled={forceTyped !== appName}
                onClick={() => {
                  setTyped(appName);
                  void executeForce();
                }}
                className="px-3 py-1 rounded bg-red-700 text-sm disabled:opacity-50"
              >
                Force delete
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
