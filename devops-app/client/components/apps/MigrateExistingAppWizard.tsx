/** Feature 010 T052 — wizard for adopting an existing manually-configured app. */
import React, { useState } from "react";
import { ApiError } from "../../lib/api.js";
import { api } from "../../lib/api.js";
import { useCrossServerDomainCheck } from "../../hooks/useCrossServerDomainCheck.js";
import { CrossServerDomainConflictPanel } from "./CrossServerDomainConflictPanel.js";

export interface MigrateExistingAppWizardProps {
  serverId: string;
  onClose: () => void;
  onAdopted: (appId: string, branch: "insert" | "patch_promote") => void;
}

type Step = "path" | "review";

interface MigrateRequest {
  serverId: string;
  remotePath: string;
  composePath?: string;
  healthUrl: string | null;
  domain: string | null;
  domainTypedConfirmation: string | null;
}

interface MigrateInsertResponse {
  app: { id: string };
  branch: "insert";
  detected: { repoUrl: string | null };
}
interface MigratePatchResponse {
  app: { id: string };
  branch: "patch_promote";
  addedFields: string[];
  preservedCreatedVia: "scan";
}
type MigrateResponse = MigrateInsertResponse | MigratePatchResponse;

export function MigrateExistingAppWizard({ serverId, onClose, onAdopted }: MigrateExistingAppWizardProps) {
  const [step, setStep] = useState<Step>("path");
  const [remotePath, setRemotePath] = useState("");
  const [composePath, setComposePath] = useState("docker-compose.yml");
  const [healthUrl, setHealthUrl] = useState("");
  const [domain, setDomain] = useState("");
  const [typed, setTyped] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { conflicts } = useCrossServerDomainCheck(domain || null, "__pending__");

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      const body: MigrateRequest = {
        serverId,
        remotePath,
        composePath: composePath || undefined,
        healthUrl: healthUrl || null,
        domain: domain || null,
        domainTypedConfirmation: typed || null,
      };
      const res = await api.post<MigrateResponse>("/applications/migrate", body);
      onAdopted(res.app.id, res.branch);
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.code === "target_path_jail_violation") {
          const d = err.details as { resolvedPath?: string; allowedRoots?: string[] };
          setError(
            `Resolved to ${d.resolvedPath ?? "?"} — outside allowed roots ${(d.allowedRoots ?? []).join(", ")}.`,
          );
        } else if (err.code === "domain_confirmation_required") {
          setError("Cross-server conflict — type the domain exactly to confirm.");
        } else {
          setError(`${err.code}: ${err.message}`);
        }
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
      aria-label="Migrate existing app"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70"
    >
      <div className="bg-gray-900 border border-gray-700 rounded-lg p-5 w-full max-w-lg space-y-3 text-sm">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Migrate existing app</h2>
          <button type="button" className="text-gray-400" onClick={onClose}>×</button>
        </div>

        {step === "path" && (
          <>
            <label className="block">
              <span className="text-xs uppercase text-gray-400">Remote path</span>
              <input
                type="text"
                className="w-full rounded bg-gray-800 border border-gray-700 px-2 py-1 mt-1 font-mono"
                value={remotePath}
                onChange={(e) => setRemotePath(e.target.value)}
                placeholder="/srv/myapp"
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
            </label>
            <label className="block">
              <span className="text-xs uppercase text-gray-400">Health URL (optional)</span>
              <input
                type="text"
                className="w-full rounded bg-gray-800 border border-gray-700 px-2 py-1 mt-1"
                value={healthUrl}
                onChange={(e) => setHealthUrl(e.target.value)}
                placeholder="https://example.com/health"
              />
            </label>
            <label className="block">
              <span className="text-xs uppercase text-gray-400">Domain (optional)</span>
              <input
                type="text"
                className="w-full rounded bg-gray-800 border border-gray-700 px-2 py-1 mt-1"
                value={domain}
                onChange={(e) => setDomain(e.target.value.toLowerCase())}
                placeholder="example.com"
              />
            </label>
            <div className="flex justify-end">
              <button
                type="button"
                className="px-3 py-1 rounded bg-blue-700 disabled:opacity-50"
                disabled={!remotePath}
                onClick={() => setStep("review")}
              >
                Next
              </button>
            </div>
          </>
        )}

        {step === "review" && (
          <>
            <ul className="list-disc pl-5 text-xs text-gray-300 space-y-1">
              <li>Server: {serverId}</li>
              <li>Path: <code>{remotePath}</code></li>
              <li>Compose: <code>{composePath}</code></li>
              {domain && <li>Domain: <code>{domain}</code></li>}
            </ul>
            {domain && conflicts.length > 0 && (
              <>
                <CrossServerDomainConflictPanel conflicts={conflicts} />
                <label className="block">
                  <span className="text-xs uppercase text-gray-400">Type the domain to confirm</span>
                  <input
                    type="text"
                    className="w-full rounded bg-gray-800 border border-gray-700 px-2 py-1 mt-1 font-mono"
                    value={typed}
                    onChange={(e) => setTyped(e.target.value)}
                    placeholder={domain}
                  />
                </label>
              </>
            )}
            {error && <div className="text-xs text-red-400">{error}</div>}
            <div className="flex justify-end gap-2">
              <button type="button" className="px-3 py-1 rounded bg-gray-700" onClick={() => setStep("path")}>
                Back
              </button>
              <button
                type="button"
                className="px-3 py-1 rounded bg-green-700 disabled:opacity-50"
                disabled={
                  submitting ||
                  (!!domain && conflicts.length > 0 && typed !== domain)
                }
                onClick={() => void submit()}
              >
                {submitting ? "Adopting…" : "Adopt"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
