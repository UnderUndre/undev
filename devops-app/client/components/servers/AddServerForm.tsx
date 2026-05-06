/**
 * Feature 011 T023 — Add server form with probe-then-onboard flow.
 *
 * Three auth modes via discriminated union:
 *   - paste-key      → operator pastes a PEM private key
 *   - paste-password → operator pastes the target's root password
 *   - generate-key   → dashboard generates an Ed25519 keypair; operator
 *                      installs the printed public key on the target
 *                      before the second probe attempt.
 *
 * Flow:
 *   1. Operator fills connection details + auth.
 *   2. Click "Test connection" → POST /api/servers/probe.
 *   3. CompatibilityReport renders. Operator acknowledges warns.
 *   4. Click "Save" → POST /api/servers/onboard with probeToken +
 *      acknowledgedWarnings. Save is disabled while warnings unacked or
 *      any fail row is present.
 */

import React, { useMemo, useState } from "react";
import {
  CompatibilityReport,
  type CompatibilityReportData,
} from "./CompatibilityReport.js";
import {
  useCompatibilityReport,
  type ProbeResult,
} from "../../hooks/useCompatibilityReport.js";
import { api, ApiError } from "../../lib/api.js";

type AuthMode = "paste-key" | "paste-password" | "generate-key";

interface AddServerFormProps {
  onCreated: (serverId: string) => void;
  onCancel: () => void;
}

interface OnboardResponse {
  server: { id: string };
  generatedPublicKey?: string;
}

export function AddServerForm({
  onCreated,
  onCancel,
}: AddServerFormProps): React.JSX.Element {
  // Connection fields.
  const [label, setLabel] = useState("");
  const [host, setHost] = useState("");
  const [port, setPort] = useState(22);
  const [sshUser, setSshUser] = useState("root");
  const [scriptsPath, setScriptsPath] = useState("/opt/devops-scripts");

  // Auth.
  const [mode, setMode] = useState<AuthMode>("paste-key");
  const [privateKey, setPrivateKey] = useState("");
  const [password, setPassword] = useState("");

  // Probe state.
  const probe = useCompatibilityReport();
  const [probeResult, setProbeResult] = useState<ProbeResult | null>(null);
  const [acknowledged, setAcknowledged] = useState<Set<string>>(new Set());
  const [genPubkey, setGenPubkey] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  function buildAuth():
    | { mode: "key"; privateKey: string }
    | { mode: "password"; password: string }
    | { mode: "generate-key" } {
    if (mode === "paste-key") return { mode: "key", privateKey };
    if (mode === "paste-password") return { mode: "password", password };
    return { mode: "generate-key" };
  }

  async function handleProbe() {
    setSubmitError(null);
    setProbeResult(null);
    setAcknowledged(new Set());
    try {
      const result = await probe.mutateAsync({
        host,
        port,
        sshUser,
        bootstrapAuth: buildAuth(),
      });
      setProbeResult(result);
      if (result.generatedPublicKey) {
        setGenPubkey(result.generatedPublicKey);
      }
    } catch (err) {
      if (err instanceof ApiError) {
        if (
          err.code === "ssh_auth_failed" &&
          err.details &&
          typeof err.details === "object" &&
          "generatedPublicKey" in err.details
        ) {
          const detail = err.details as { generatedPublicKey?: string };
          if (detail.generatedPublicKey) {
            setGenPubkey(detail.generatedPublicKey);
          }
        }
        setSubmitError(`${err.code}: ${err.message}`);
      } else if (err instanceof Error) {
        setSubmitError(err.message);
      } else {
        setSubmitError("Probe failed");
      }
    }
  }

  const report: CompatibilityReportData | null = probeResult?.compatibility ?? null;

  const saveBlocked = useMemo(() => {
    if (!report) return true;
    if (report.checks.some((c) => c.status === "fail")) return true;
    const unackedWarn = report.checks.some(
      (c) => c.status === "warn" && !acknowledged.has(c.id),
    );
    return unackedWarn;
  }, [report, acknowledged]);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!probeResult) return;
    setSaving(true);
    setSubmitError(null);
    try {
      const credential = (() => {
        if (mode === "paste-key") {
          // publicKey is omitted — backend derives from the PEM private
          // key. Operator-supplied OpenSSH pubkey could be added later
          // if needed (e.g. for non-Ed25519 keys where derivation may
          // not match the convention the operator expects).
          return { mode: "key" as const, privateKey };
        }
        if (mode === "paste-password") {
          return { mode: "password" as const, password };
        }
        // generated: no fields. Server pulls the keypair from the
        // probe-token cache (FR-002 — client never holds the private).
        return { mode: "generated" as const };
      })();
      const result = await api.post<OnboardResponse>("/servers/onboard", {
        label,
        host,
        port,
        sshUser,
        scriptsPath,
        probeToken: probeResult.probeToken,
        managedSshCredential: credential,
        acknowledgedWarnings: [...acknowledged],
      });
      onCreated(result.server.id);
    } catch (err) {
      if (err instanceof ApiError) {
        setSubmitError(`${err.code}: ${err.message}`);
      } else if (err instanceof Error) {
        setSubmitError(err.message);
      } else {
        setSubmitError("Save failed");
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSave} className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          <span className="text-xs uppercase text-gray-500">Label</span>
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            required
            className="w-full bg-gray-950 border border-gray-700 rounded px-2 py-1.5 text-sm"
          />
        </label>
        <label className="block">
          <span className="text-xs uppercase text-gray-500">SSH user</span>
          <input
            type="text"
            value={sshUser}
            onChange={(e) => setSshUser(e.target.value)}
            required
            className="w-full bg-gray-950 border border-gray-700 rounded px-2 py-1.5 text-sm"
          />
        </label>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <label className="block col-span-2">
          <span className="text-xs uppercase text-gray-500">Host</span>
          <input
            type="text"
            value={host}
            onChange={(e) => setHost(e.target.value)}
            required
            placeholder="192.0.2.10"
            className="w-full bg-gray-950 border border-gray-700 rounded px-2 py-1.5 text-sm"
          />
        </label>
        <label className="block">
          <span className="text-xs uppercase text-gray-500">Port</span>
          <input
            type="number"
            value={port}
            onChange={(e) => setPort(Number(e.target.value))}
            min={1}
            max={65535}
            className="w-full bg-gray-950 border border-gray-700 rounded px-2 py-1.5 text-sm"
          />
        </label>
      </div>

      <fieldset className="space-y-2">
        <legend className="text-xs uppercase text-gray-500">Auth mode</legend>
        <div className="flex gap-2">
          {(
            [
              ["paste-key", "Paste private key"],
              ["paste-password", "Paste root password"],
              ["generate-key", "Generate key"],
            ] as Array<[AuthMode, string]>
          ).map(([m, label]) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={`text-xs px-2 py-1 rounded border ${
                mode === m
                  ? "bg-brand-purple border-brand-purple text-white"
                  : "bg-gray-950 border-gray-700 text-gray-400 hover:border-gray-500"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {mode === "paste-key" && (
          <textarea
            value={privateKey}
            onChange={(e) => setPrivateKey(e.target.value)}
            rows={4}
            placeholder={"-----BEGIN OPENSSH PRIVATE KEY-----"}
            className="w-full bg-gray-950 border border-gray-700 rounded px-2 py-1.5 text-xs font-mono"
          />
        )}
        {mode === "paste-password" && (
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="root password"
            className="w-full bg-gray-950 border border-gray-700 rounded px-2 py-1.5 text-sm"
          />
        )}
        {mode === "generate-key" && genPubkey && (
          <div className="bg-gray-950 border border-gray-700 rounded p-2">
            <p className="text-xs text-gray-400 mb-1">
              Install this public key on the target before retrying:
            </p>
            <code className="block text-[10px] font-mono break-all whitespace-pre-wrap text-green-300">
              {genPubkey}
            </code>
            <p className="text-xs text-gray-500 mt-1">
              {`echo "${genPubkey}" >> ~/.ssh/authorized_keys`}
            </p>
          </div>
        )}
      </fieldset>

      <label className="block">
        <span className="text-xs uppercase text-gray-500">Scripts path</span>
        <input
          type="text"
          value={scriptsPath}
          onChange={(e) => setScriptsPath(e.target.value)}
          className="w-full bg-gray-950 border border-gray-700 rounded px-2 py-1.5 text-sm font-mono"
        />
      </label>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={handleProbe}
          disabled={probe.isPending || !host || !sshUser}
          className="border border-gray-700 hover:border-gray-500 disabled:opacity-50 px-3 py-1.5 rounded text-sm"
        >
          {probe.isPending ? "Testing…" : "Test connection"}
        </button>
        {probeResult && (
          <span className="text-xs text-gray-500">
            Cloud: {probeResult.cloudProvider} · Host key:{" "}
            <span className="font-mono">
              {probeResult.hostKeyFingerprint.slice(0, 24)}…
            </span>
          </span>
        )}
      </div>

      {submitError && (
        <p className="text-sm text-red-400" role="alert">
          {submitError}
        </p>
      )}

      {report && (
        <CompatibilityReport
          report={report}
          acknowledgedWarnings={acknowledged}
          onAcknowledgeWarning={(id, ack) => {
            setAcknowledged((prev) => {
              const next = new Set(prev);
              if (ack) next.add(id);
              else next.delete(id);
              return next;
            });
          }}
        />
      )}

      <div className="flex justify-end gap-2 pt-1">
        <button
          type="button"
          onClick={onCancel}
          className="px-3 py-1.5 text-sm text-gray-400 hover:text-white"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={saveBlocked || saving}
          className="bg-brand-purple hover:bg-purple-600 disabled:opacity-50 px-3 py-1.5 rounded text-sm font-medium"
        >
          {saving ? "Saving…" : "Save server"}
        </button>
      </div>
    </form>
  );
}
