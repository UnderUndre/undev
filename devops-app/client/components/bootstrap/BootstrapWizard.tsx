/**
 * Feature 009 T026 — Bootstrap Wizard.
 *
 * 5 steps: Repo → Detection → Domain → Advanced → Review. Closing the modal
 * does NOT abort an in-flight bootstrap (orchestrator is server-side per
 * FR-007); switching to `BootstrapProgressView` after submit is just a
 * convenience for the operator who triggered the run.
 *
 * Slug derivation runs client-side for fast feedback; the server
 * re-validates per FR-027.
 */
import React, { useEffect, useMemo, useState } from "react";
import { ApiError } from "../../lib/api.js";
import {
  bootstrapApi,
  type ComposeFetchResponse,
} from "../../lib/bootstrap-api.js";
import { ComposeDetectionView } from "./ComposeDetectionView.js";
import { BootstrapProgressView } from "./BootstrapProgressView.js";

export interface BootstrapWizardProps {
  serverId: string;
  deployUserHome?: string; // for default remotePath display
  onClose: () => void;
  onCreated?: (appId: string) => void;
}

type Step = "repo" | "detection" | "domain" | "advanced" | "review" | "progress";

const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const COMPOSE_PATH_RE = /^[\x20-\x7E]+$/;

function clientDeriveSlug(name: string): string {
  // Client-side mirror of server's pipeline (FR-006). Server re-validates.
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function clientValidateComposePath(p: string): string | null {
  if (!p) return null;
  if (p.length > 256) return "Path too long (max 256)";
  if (p.includes("..")) return "Path contains `..`";
  if (p.includes("\\")) return "Backslashes not allowed";
  if (p.startsWith("/")) return "Path must be repo-relative";
  if (!COMPOSE_PATH_RE.test(p)) return "Path has non-printable bytes";
  if (!/\.(yml|yaml)$/.test(p)) return "Must end in .yml or .yaml";
  return null;
}

export function BootstrapWizard({ serverId, deployUserHome, onClose, onCreated }: BootstrapWizardProps) {
  const [step, setStep] = useState<Step>("repo");
  const [createdAppId, setCreatedAppId] = useState<string | null>(null);

  const [githubRepo, setGithubRepo] = useState(""); // "owner/repo"
  const [name, setName] = useState("");
  const [branch, setBranch] = useState("main");
  const [composePath, setComposePath] = useState("docker-compose.yml");
  const [remotePath, setRemotePath] = useState("");
  const [upstreamService, setUpstreamService] = useState<string | null>(null);
  const [upstreamPort, setUpstreamPort] = useState<number | null>(null);
  const [domain, setDomain] = useState("");
  const [acmeEmail, setAcmeEmail] = useState("");
  const [bootstrapAutoRetry, setBootstrapAutoRetry] = useState(false);

  const [composeRes, setComposeRes] = useState<ComposeFetchResponse | null>(null);
  const [composeLoading, setComposeLoading] = useState(false);
  const [composePathDebounce, setComposePathDebounce] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const slugError = useMemo(() => {
    if (!name) return "Required";
    if (!SLUG_RE.test(name)) return "Must match ^[a-z0-9]+(-[a-z0-9]+)*$";
    if (name.length > 64) return "Max 64 chars";
    return null;
  }, [name]);

  const composePathError = useMemo(
    () => clientValidateComposePath(composePath),
    [composePath],
  );

  // T068 — debounced compose-path validation hint (300ms).
  useEffect(() => {
    const t = setTimeout(() => setComposePathDebounce(composePath), 300);
    return () => clearTimeout(t);
  }, [composePath]);

  const ownerRepoOk = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(githubRepo);

  // Auto-derive slug + remotePath on owner/repo input.
  useEffect(() => {
    if (!ownerRepoOk) return;
    const repoName = githubRepo.split("/")[1] ?? "";
    if (!name) {
      const slug = clientDeriveSlug(repoName);
      setName(slug);
    }
  }, [githubRepo, ownerRepoOk, name]);

  useEffect(() => {
    if (!remotePath && name) {
      const home = deployUserHome ?? "/home/deploy";
      setRemotePath(`${home}/apps/${name}`);
    }
  }, [name, remotePath, deployUserHome]);

  async function fetchCompose() {
    if (!ownerRepoOk) return;
    const [owner, repo] = githubRepo.split("/") as [string, string];
    setComposeLoading(true);
    try {
      const res = await bootstrapApi.fetchCompose(owner, repo, composePath || undefined);
      setComposeRes(res);
      // Auto-pick when there's exactly one ok-port service.
      const okSvcs = (res.services ?? []).filter((s) => s.kind === "ok");
      const sole = okSvcs[0];
      if (okSvcs.length === 1 && sole && upstreamService === null) {
        setUpstreamService(sole.name);
        setUpstreamPort(sole.exposeOrPorts ?? null);
      }
    } catch (err) {
      setComposeRes({
        found: false,
        errors: [err instanceof Error ? err.message : "fetch failed"],
        warnings: [],
      });
    } finally {
      setComposeLoading(false);
    }
  }

  async function submit() {
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await bootstrapApi.create({
        serverId,
        githubRepo,
        name,
        branch,
        composePath,
        remotePath,
        upstreamService: upstreamService || null,
        upstreamPort: upstreamPort ?? null,
        domain: domain || null,
        acmeEmail: acmeEmail || null,
        bootstrapAutoRetry,
      });
      setCreatedAppId(res.id);
      setStep("progress");
      onCreated?.(res.id);
    } catch (err) {
      if (err instanceof ApiError) {
        setSubmitError(`${err.code}: ${err.message}`);
      } else {
        setSubmitError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setSubmitting(false);
    }
  }

  if (step === "progress" && createdAppId) {
    return <BootstrapProgressView appId={createdAppId} onClose={onClose} />;
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Bootstrap from GitHub"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70"
    >
      <div className="bg-gray-900 border border-gray-700 rounded-lg p-5 w-full max-w-2xl space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Bootstrap from GitHub</h2>
          <button type="button" onClick={onClose} className="text-gray-400 text-sm">×</button>
        </div>

        <div className="text-xs text-gray-500 flex gap-3">
          {(["repo", "detection", "domain", "advanced", "review"] as Step[]).map((s) => (
            <span key={s} className={step === s ? "text-blue-400 font-semibold" : ""}>
              {s}
            </span>
          ))}
        </div>

        {step === "repo" && (
          <div className="space-y-3 text-sm">
            <label className="block">
              <span className="text-xs uppercase text-gray-400">GitHub repo (owner/repo)</span>
              <input
                type="text"
                className="w-full rounded bg-gray-800 border border-gray-700 px-2 py-1 mt-1"
                value={githubRepo}
                onChange={(e) => setGithubRepo(e.target.value)}
                placeholder="acme/my-app"
              />
            </label>
            <label className="block">
              <span className="text-xs uppercase text-gray-400">Slug (server-validated)</span>
              <input
                type="text"
                className="w-full rounded bg-gray-800 border border-gray-700 px-2 py-1 mt-1 font-mono"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
              {slugError && <span className="text-xs text-red-400">{slugError}</span>}
            </label>
            <label className="block">
              <span className="text-xs uppercase text-gray-400">Branch</span>
              <input
                type="text"
                className="w-full rounded bg-gray-800 border border-gray-700 px-2 py-1 mt-1"
                value={branch}
                onChange={(e) => setBranch(e.target.value)}
              />
            </label>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                className="px-3 py-1 rounded bg-blue-700 text-sm disabled:opacity-50"
                disabled={!ownerRepoOk || !!slugError}
                onClick={() => {
                  setStep("detection");
                  void fetchCompose();
                }}
              >
                Next
              </button>
            </div>
          </div>
        )}

        {step === "detection" && (
          <div className="space-y-3">
            {composeLoading ? (
              <div className="text-sm text-gray-400">Loading compose…</div>
            ) : composeRes ? (
              <ComposeDetectionView
                services={composeRes.services ?? []}
                warnings={composeRes.warnings}
                errors={composeRes.errors}
                selectedService={upstreamService}
                selectedPort={upstreamPort}
                onChange={(s, p) => {
                  setUpstreamService(s);
                  setUpstreamPort(p);
                }}
              />
            ) : (
              <div className="text-sm text-gray-400">No data.</div>
            )}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                className="px-3 py-1 rounded bg-gray-700 text-sm"
                onClick={() => setStep("repo")}
              >
                Back
              </button>
              <button
                type="button"
                className="px-3 py-1 rounded bg-blue-700 text-sm"
                onClick={() => setStep("domain")}
              >
                Next
              </button>
            </div>
          </div>
        )}

        {step === "domain" && (
          <div className="space-y-3 text-sm">
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
            <label className="block">
              <span className="text-xs uppercase text-gray-400">ACME email (optional override)</span>
              <input
                type="email"
                className="w-full rounded bg-gray-800 border border-gray-700 px-2 py-1 mt-1"
                value={acmeEmail}
                onChange={(e) => setAcmeEmail(e.target.value)}
              />
            </label>
            <div className="flex justify-end gap-2">
              <button type="button" className="px-3 py-1 rounded bg-gray-700 text-sm" onClick={() => setStep("detection")}>
                Back
              </button>
              <button type="button" className="px-3 py-1 rounded bg-blue-700 text-sm" onClick={() => setStep("advanced")}>
                Next
              </button>
            </div>
          </div>
        )}

        {step === "advanced" && (
          <div className="space-y-3 text-sm">
            <label className="block">
              <span className="text-xs uppercase text-gray-400">Remote path</span>
              <input
                type="text"
                className="w-full rounded bg-gray-800 border border-gray-700 px-2 py-1 mt-1 font-mono"
                value={remotePath}
                onChange={(e) => setRemotePath(e.target.value)}
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
              {composePathError && composePathDebounce && (
                <span className="text-xs text-red-400">{composePathError}</span>
              )}
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={bootstrapAutoRetry}
                onChange={(e) => setBootstrapAutoRetry(e.target.checked)}
              />
              <span>Auto-retry on transient failures (5 min reconciler)</span>
            </label>
            <div className="flex justify-end gap-2">
              <button type="button" className="px-3 py-1 rounded bg-gray-700 text-sm" onClick={() => setStep("domain")}>
                Back
              </button>
              <button
                type="button"
                className="px-3 py-1 rounded bg-blue-700 text-sm disabled:opacity-50"
                disabled={!!composePathError}
                onClick={() => setStep("review")}
              >
                Next
              </button>
            </div>
          </div>
        )}

        {step === "review" && (
          <div className="space-y-3 text-sm">
            <ul className="list-disc pl-5 space-y-1 text-gray-300">
              <li>Clone <code>{githubRepo}</code> @ <code>{branch}</code> → <code>{remotePath}</code></li>
              <li>Run <code>docker compose -f {composePath} up -d</code></li>
              {upstreamService && <li>Wait for <code>{upstreamService}</code> healthy on port {upstreamPort ?? "?"}</li>}
              {domain && <li>Apply Caddy + ACME for <code>{domain}</code></li>}
              <li>Mark ACTIVE</li>
            </ul>
            {submitError && <div className="text-red-400 text-xs">{submitError}</div>}
            <div className="flex justify-end gap-2">
              <button type="button" className="px-3 py-1 rounded bg-gray-700 text-sm" onClick={() => setStep("advanced")}>
                Back
              </button>
              <button
                type="button"
                className="px-3 py-1 rounded bg-green-700 text-sm disabled:opacity-50"
                disabled={submitting || !!slugError || !!composePathError}
                onClick={() => void submit()}
              >
                {submitting ? "Bootstrapping…" : "Bootstrap"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
