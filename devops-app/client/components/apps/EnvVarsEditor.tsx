/**
 * Feature 011 T039 — Per-app environment variables editor.
 *
 * Independent of the surrounding EditAppForm: fetches its own state via
 * GET /api/apps/:id/env-vars and submits via PATCH /api/apps/:id/env-vars.
 * This avoids a double-write race with the main app PUT handler — env
 * vars now live in their own endpoint.
 *
 * No `dangerouslySetInnerHTML`, controlled inputs only.
 */

import React, { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../../lib/api.js";

interface EnvVarsResponse {
  vars: Record<string, string>;
}

interface PatchResponse {
  ok: true;
  added: string[];
  removed: string[];
  changed: string[];
}

interface PlaceholderError {
  code: "placeholder_values_detected";
  details: { changeMeKeys: string[] };
}

interface EnvVarsEditorProps {
  appId: string;
  /** Optional: shown when an associated app has a `.env.example` on the target. */
  showImportButton?: boolean;
}

interface Row {
  id: string; // stable React key (uuid-ish, scoped to this editor instance)
  key: string;
  value: string;
  reveal: boolean;
}

let _rowCounter = 0;
function makeRowId(): string {
  _rowCounter += 1;
  return `r${_rowCounter}`;
}

function generateSecretHex32(): string {
  // 32 bytes → 64 hex chars. Crypto-grade, runs client-side; never round-trips.
  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

const KEY_RE = /^[A-Z_][A-Z0-9_]*$/;

export function EnvVarsEditor({
  appId,
  showImportButton = true,
}: EnvVarsEditorProps): React.JSX.Element {
  const qc = useQueryClient();
  const queryKey = useMemo(() => ["app", appId, "env-vars"], [appId]);

  const { data, isLoading, error: loadError } = useQuery({
    queryKey,
    queryFn: () => api.get<EnvVarsResponse>(`/apps/${appId}/env-vars`),
    enabled: Boolean(appId),
  });

  const [rows, setRows] = useState<Row[]>([]);
  const [savedSnapshot, setSavedSnapshot] = useState<string>("");
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    if (!data) return;
    const next = Object.entries(data.vars).map(([k, v]) => ({
      id: makeRowId(),
      key: k,
      value: v,
      reveal: false,
    }));
    setRows(next);
    setSavedSnapshot(JSON.stringify(data.vars));
  }, [data]);

  const dirty = useMemo(() => {
    const current: Record<string, string> = {};
    for (const r of rows) {
      if (r.key) current[r.key] = r.value;
    }
    return JSON.stringify(current) !== savedSnapshot;
  }, [rows, savedSnapshot]);

  const duplicateKeys = useMemo(() => {
    const seen = new Set<string>();
    const dupes = new Set<string>();
    for (const r of rows) {
      if (!r.key) continue;
      if (seen.has(r.key)) dupes.add(r.key);
      seen.add(r.key);
    }
    return dupes;
  }, [rows]);

  const invalidKeys = useMemo(
    () =>
      new Set(rows.filter((r) => r.key !== "" && !KEY_RE.test(r.key)).map((r) => r.key)),
    [rows],
  );

  const patch = useMutation({
    mutationFn: (payload: {
      vars: Record<string, string>;
      acknowledgePlaceholders: boolean;
    }) =>
      api.patch<PatchResponse>(`/apps/${appId}/env-vars`, payload),
    onSuccess: (_res, payload) => {
      setSavedSnapshot(JSON.stringify(payload.vars));
      setSubmitError(null);
      void qc.invalidateQueries({ queryKey });
    },
  });

  const importMut = useMutation({
    mutationFn: () => api.post<{ ok: true; importedKeys: string[] }>(
      `/apps/${appId}/env-vars/import`,
    ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey });
    },
  });

  function update(id: string, patch: Partial<Row>) {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }

  function addRow() {
    setRows((prev) => [
      ...prev,
      { id: makeRowId(), key: "", value: "", reveal: true },
    ]);
  }

  function removeRow(id: string) {
    setRows((prev) => prev.filter((r) => r.id !== id));
  }

  function buildVars(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const r of rows) {
      if (!r.key) continue;
      out[r.key] = r.value;
    }
    return out;
  }

  async function handleSave() {
    setSubmitError(null);
    if (duplicateKeys.size > 0) {
      setSubmitError(`Duplicate keys: ${[...duplicateKeys].join(", ")}`);
      return;
    }
    if (invalidKeys.size > 0) {
      setSubmitError(
        `Invalid keys (must match A-Z, 0-9, _): ${[...invalidKeys].join(", ")}`,
      );
      return;
    }
    const vars = buildVars();
    try {
      await patch.mutateAsync({ vars, acknowledgePlaceholders: false });
    } catch (err) {
      if (
        err instanceof ApiError &&
        err.code === "placeholder_values_detected"
      ) {
        const details = (err.details as PlaceholderError["details"]) ?? {
          changeMeKeys: [],
        };
        const ok = window.confirm(
          `These keys still have placeholder values: ${details.changeMeKeys.join(
            ", ",
          )}\n\nSave anyway?`,
        );
        if (!ok) return;
        try {
          await patch.mutateAsync({ vars, acknowledgePlaceholders: true });
        } catch (err2) {
          setSubmitError(err2 instanceof Error ? err2.message : "Save failed");
        }
        return;
      }
      setSubmitError(err instanceof Error ? err.message : "Save failed");
    }
  }

  if (isLoading) {
    return (
      <div className="text-xs text-gray-500 py-2">Loading env vars…</div>
    );
  }
  if (loadError) {
    return (
      <div className="text-xs text-red-400" role="alert">
        Failed to load env vars:{" "}
        {loadError instanceof Error ? loadError.message : "unknown error"}
      </div>
    );
  }

  return (
    <section className="border border-gray-800 rounded-lg p-3 space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-gray-200">
          Environment variables
        </h3>
        <div className="flex gap-2">
          {showImportButton && (
            <button
              type="button"
              onClick={() => importMut.mutate()}
              disabled={importMut.isPending}
              className="text-xs text-gray-400 hover:text-white px-2 py-1 border border-gray-700 rounded"
              title="Read .env.example over SSH and merge new keys"
            >
              {importMut.isPending ? "Importing…" : "Import .env.example"}
            </button>
          )}
          <button
            type="button"
            onClick={addRow}
            className="text-xs px-2 py-1 border border-gray-700 rounded hover:bg-gray-800"
          >
            + Add row
          </button>
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="text-xs text-gray-500 py-2">No env vars defined.</div>
      ) : (
        <table className="w-full text-xs font-mono">
          <thead>
            <tr className="text-gray-500">
              <th className="text-left font-normal pb-1">KEY</th>
              <th className="text-left font-normal pb-1">VALUE</th>
              <th className="w-24" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const dupe = r.key && duplicateKeys.has(r.key);
              const invalid = r.key && !KEY_RE.test(r.key);
              return (
                <tr key={r.id} className="border-t border-gray-800">
                  <td className="py-1 pr-2">
                    <input
                      type="text"
                      value={r.key}
                      onChange={(e) =>
                        update(r.id, { key: e.target.value.toUpperCase() })
                      }
                      placeholder="JWT_SECRET"
                      className={`w-full bg-gray-950 border rounded px-2 py-1 ${
                        dupe || invalid
                          ? "border-red-600"
                          : "border-gray-700"
                      }`}
                      aria-invalid={dupe || invalid ? "true" : "false"}
                    />
                  </td>
                  <td className="py-1 pr-2">
                    <input
                      type={r.reveal ? "text" : "password"}
                      value={r.value}
                      onChange={(e) => update(r.id, { value: e.target.value })}
                      placeholder="value"
                      className="w-full bg-gray-950 border border-gray-700 rounded px-2 py-1"
                    />
                  </td>
                  <td className="py-1 text-right space-x-1">
                    <button
                      type="button"
                      onClick={() => update(r.id, { reveal: !r.reveal })}
                      title={r.reveal ? "Hide value" : "Reveal value"}
                      className="text-gray-400 hover:text-white px-1"
                    >
                      {r.reveal ? "👁" : "•"}
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        update(r.id, { value: generateSecretHex32(), reveal: true })
                      }
                      title="Generate 32-byte hex secret"
                      className="text-gray-400 hover:text-white px-1"
                    >
                      🎲
                    </button>
                    <button
                      type="button"
                      onClick={() => removeRow(r.id)}
                      title="Remove row"
                      className="text-red-400 hover:text-red-300 px-1"
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {submitError && (
        <div className="text-xs text-red-400" role="alert">
          {submitError}
        </div>
      )}
      {importMut.isError && (
        <div className="text-xs text-red-400" role="alert">
          Import failed:{" "}
          {importMut.error instanceof Error
            ? importMut.error.message
            : "unknown error"}
        </div>
      )}

      <div className="flex justify-end gap-2 pt-1">
        <button
          type="button"
          onClick={handleSave}
          disabled={!dirty || patch.isPending}
          className="bg-brand-purple hover:bg-purple-600 disabled:opacity-50 px-3 py-1 rounded text-xs font-medium"
        >
          {patch.isPending ? "Saving…" : "Save env vars"}
        </button>
      </div>
    </section>
  );
}
