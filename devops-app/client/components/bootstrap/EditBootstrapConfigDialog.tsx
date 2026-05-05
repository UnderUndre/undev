/** Feature 009 T034 — Edit Config dialog for failed_* apps. */
import React, { useEffect, useState } from "react";
import { ApiError } from "../../lib/api.js";
import { bootstrapApi } from "../../lib/bootstrap-api.js";

export interface EditBootstrapConfigDialogProps {
  appId: string;
  initial: {
    branch: string;
    composePath: string;
    upstreamService: string | null;
    upstreamPort: number | null;
    remotePath: string;
    repoUrl: string;
  };
  onClose: () => void;
  onSaved: () => void;
}

const COMPOSE_PATH_RE = /^[\x20-\x7E]+$/;

function validateComposePath(p: string): string | null {
  if (!p) return null;
  if (p.length > 256) return "Path too long";
  if (p.includes("..")) return "Path contains `..`";
  if (p.includes("\\")) return "Backslashes not allowed";
  if (p.startsWith("/")) return "Must be repo-relative";
  if (!COMPOSE_PATH_RE.test(p)) return "Non-printable bytes";
  if (!/\.(yml|yaml)$/.test(p)) return "Must end in .yml or .yaml";
  return null;
}

export function EditBootstrapConfigDialog({ appId, initial, onClose, onSaved }: EditBootstrapConfigDialogProps) {
  const [branch, setBranch] = useState(initial.branch);
  const [composePath, setComposePath] = useState(initial.composePath);
  const [upstreamService, setUpstreamService] = useState(initial.upstreamService ?? "");
  const [upstreamPort, setUpstreamPort] = useState<number | null>(initial.upstreamPort);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [composePathDebounced, setComposePathDebounced] = useState<string>(initial.composePath);

  useEffect(() => {
    const t = setTimeout(() => setComposePathDebounced(composePath), 300);
    return () => clearTimeout(t);
  }, [composePath]);

  const composePathError = composePathDebounced ? validateComposePath(composePathDebounced) : null;

  async function save() {
    setSubmitting(true);
    setError(null);
    try {
      const upstreamPair =
        upstreamService.trim() === ""
          ? { upstreamService: null, upstreamPort: null }
          : { upstreamService: upstreamService.trim(), upstreamPort: upstreamPort };
      await bootstrapApi.editConfig(appId, {
        branch,
        composePath,
        ...upstreamPair,
      });
      onSaved();
    } catch (err) {
      if (err instanceof ApiError) {
        setError(`${err.code}: ${err.message}`);
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Edit bootstrap config"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70"
    >
      <div className="bg-gray-900 border border-gray-700 rounded-lg p-5 w-full max-w-lg space-y-3 text-sm">
        <h2 className="text-lg font-semibold">Edit bootstrap config</h2>
        <div className="text-xs text-gray-500">
          Mutable: branch, compose path, upstream service+port. Immutable: remote path, repo URL — change those via Hard Delete + re-bootstrap.
        </div>
        <label className="block">
          <span className="text-xs uppercase text-gray-400">Branch</span>
          <input
            type="text"
            className="w-full rounded bg-gray-800 border border-gray-700 px-2 py-1 mt-1"
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
          />
        </label>
        <label className="block">
          <span className="text-xs uppercase text-gray-400">Compose path</span>
          <input
            type="text"
            className="w-full rounded bg-gray-800 border border-gray-700 px-2 py-1 mt-1 font-mono"
            value={composePath}
            onChange={(e) => setComposePath(e.target.value)}
          />
          {composePathError && <span className="text-xs text-red-400">{composePathError}</span>}
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="text-xs uppercase text-gray-400">Upstream service</span>
            <input
              type="text"
              className="w-full rounded bg-gray-800 border border-gray-700 px-2 py-1 mt-1"
              value={upstreamService}
              onChange={(e) => setUpstreamService(e.target.value)}
            />
          </label>
          <label className="block">
            <span className="text-xs uppercase text-gray-400">Upstream port</span>
            <input
              type="number"
              min={1}
              max={65535}
              className="w-full rounded bg-gray-800 border border-gray-700 px-2 py-1 mt-1"
              value={upstreamPort ?? ""}
              onChange={(e) => {
                const n = e.target.value === "" ? null : Number(e.target.value);
                setUpstreamPort(Number.isFinite(n) ? (n as number) : null);
              }}
            />
          </label>
        </div>
        <div className="border border-gray-800 rounded p-2 bg-gray-950 text-xs text-gray-500">
          <div>Remote path: <code>{initial.remotePath}</code></div>
          <div>Repo URL: <code>{initial.repoUrl}</code></div>
        </div>
        {error && <div className="text-xs text-red-400">{error}</div>}
        <div className="flex justify-end gap-2">
          <button type="button" className="px-3 py-1 rounded bg-gray-700 text-sm" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="px-3 py-1 rounded bg-blue-700 text-sm disabled:opacity-50"
            onClick={() => void save()}
            disabled={submitting || !!composePathError}
          >
            {submitting ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
