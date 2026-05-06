/**
 * Feature 011 T046 + T047 — SSH keys overview + rotation UI.
 *
 * Lists every server with: label, host, auth method, current key
 * fingerprint, last rotation timestamp, "Rotate" button. Rotate opens a
 * confirm dialog with typed-text input and removeOldKeyFromTarget toggle.
 */

import React, { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../../lib/api.js";

interface ServerRow {
  id: string;
  label: string;
  host: string;
  port: number;
  sshAuthMethod: "key" | "password";
  sshKeyFingerprint: string | null;
  sshKeyRotatedAt: string | null;
}

interface RotateResponse {
  ok: true;
  oldFingerprint: string | null;
  newFingerprint: string;
  step5Warning: string | null;
}

export function SshKeysSection(): React.JSX.Element {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ["settings", "ssh-keys"],
    queryFn: () => api.get<ServerRow[]>("/servers"),
  });

  const [rotating, setRotating] = useState<string | null>(null);
  const [removeOld, setRemoveOld] = useState(true);
  const [ackText, setAckText] = useState("");
  const [rotateError, setRotateError] = useState<string | null>(null);

  const rotateMut = useMutation({
    mutationFn: (vars: { serverId: string; removeOldKeyFromTarget: boolean }) =>
      api.post<RotateResponse>(`/servers/${vars.serverId}/rotate-key`, {
        removeOldKeyFromTarget: vars.removeOldKeyFromTarget,
        typedAcknowledgement: "ROTATE",
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["settings", "ssh-keys"] });
      setRotating(null);
      setAckText("");
    },
    onError: (err) => {
      if (err instanceof ApiError) {
        setRotateError(`${err.code}: ${err.message}`);
      } else if (err instanceof Error) {
        setRotateError(err.message);
      }
    },
  });

  if (isLoading) {
    return (
      <section className="bg-gray-900 border border-gray-800 rounded-lg p-4 md:p-6">
        <h2 className="text-xl font-semibold mb-4">SSH keys</h2>
        <p className="text-gray-400">Loading…</p>
      </section>
    );
  }
  if (error) {
    return (
      <section className="bg-gray-900 border border-gray-800 rounded-lg p-4 md:p-6">
        <h2 className="text-xl font-semibold mb-4">SSH keys</h2>
        <p className="text-red-400">
          Failed to load: {error instanceof Error ? error.message : "unknown"}
        </p>
      </section>
    );
  }

  return (
    <section className="bg-gray-900 border border-gray-800 rounded-lg p-4 md:p-6 space-y-3">
      <h2 className="text-xl font-semibold">SSH keys</h2>

      {(!data || data.length === 0) ? (
        <p className="text-sm text-gray-500">No servers configured.</p>
      ) : (
        <table className="w-full text-xs">
          <thead>
            <tr className="text-gray-500">
              <th className="text-left pb-1">Server</th>
              <th className="text-left pb-1">Auth</th>
              <th className="text-left pb-1">Fingerprint</th>
              <th className="text-left pb-1">Rotated</th>
              <th className="text-right pb-1"></th>
            </tr>
          </thead>
          <tbody>
            {data.map((s) => (
              <tr key={s.id} className="border-t border-gray-800 align-top">
                <td className="py-1.5">
                  <span className="text-gray-200">{s.label}</span>
                  <p className="text-[10px] text-gray-500">
                    {s.host}:{s.port}
                  </p>
                </td>
                <td className="py-1.5 font-mono text-gray-400">
                  {s.sshAuthMethod}
                </td>
                <td className="py-1.5 font-mono text-gray-400 break-all">
                  {s.sshKeyFingerprint ?? "—"}
                </td>
                <td className="py-1.5 text-gray-400">
                  {s.sshKeyRotatedAt ?? "never"}
                </td>
                <td className="py-1.5 text-right">
                  <button
                    type="button"
                    onClick={() => {
                      setRotating(s.id);
                      setRotateError(null);
                      setAckText("");
                    }}
                    className="border border-gray-700 hover:border-gray-500 px-2 py-1 rounded text-xs"
                  >
                    Rotate
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {rotating && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
        >
          <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-md mx-4 p-5 space-y-3">
            <h3 className="text-lg font-semibold">Rotate SSH key</h3>
            <p className="text-sm text-gray-300">
              Generates a new Ed25519 keypair, installs the public key on
              the target, verifies access, then atomically swaps the
              dashboard's stored credential.
            </p>
            <label className="inline-flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={removeOld}
                onChange={(e) => setRemoveOld(e.target.checked)}
                className="h-4 w-4 accent-brand-purple"
              />
              Remove old pubkey from target after success (best effort)
            </label>
            <label className="block">
              <span className="text-xs text-gray-500">
                Type{" "}
                <code className="font-mono bg-gray-950 px-1">ROTATE</code> to
                confirm:
              </span>
              <input
                type="text"
                value={ackText}
                onChange={(e) => setAckText(e.target.value)}
                className="w-full bg-gray-950 border border-gray-700 rounded px-2 py-1.5 text-sm font-mono"
              />
            </label>
            {rotateError && (
              <p className="text-sm text-red-400" role="alert">
                {rotateError}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setRotating(null);
                  setRotateError(null);
                  setAckText("");
                }}
                className="px-3 py-1.5 text-sm text-gray-400 hover:text-white"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={ackText !== "ROTATE" || rotateMut.isPending}
                onClick={() =>
                  rotateMut.mutate({
                    serverId: rotating,
                    removeOldKeyFromTarget: removeOld,
                  })
                }
                className="bg-brand-purple hover:bg-purple-600 disabled:opacity-50 px-3 py-1.5 rounded text-sm font-medium"
              >
                {rotateMut.isPending ? "Rotating…" : "Rotate"}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
