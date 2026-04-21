import React, { useMemo, useState } from "react";
import { api, ApiError } from "../../lib/api.js";

export interface FieldDescriptor {
  name: string;
  type: "string" | "number" | "boolean" | "enum";
  required: boolean;
  default?: unknown;
  enumValues?: string[];
  isSecret: boolean;
  description?: string;
}

export interface ManifestEntry {
  id: string;
  category: string;
  description: string;
  locus: string;
  requiresLock: boolean;
  timeout?: number;
  dangerLevel?: string;
  outputArtifact?: { type: string; captureFrom: string };
  fields: FieldDescriptor[];
  valid?: boolean;
  validationError?: string | null;
}

interface Props {
  entry: ManifestEntry;
  serverId: string;
  onClose: () => void;
}

interface RunResponse {
  runId: string;
  jobId: string;
  status: string;
}

function kebabToCamel(s: string): string {
  return s.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

export function RunDialog({ entry, serverId, onClose }: Props): React.JSX.Element {
  const initial = useMemo(() => {
    const out: Record<string, unknown> = {};
    for (const f of entry.fields) {
      if (f.default !== undefined) out[kebabToCamel(f.name)] = f.default;
      else if (f.type === "boolean") out[kebabToCamel(f.name)] = false;
      else out[kebabToCamel(f.name)] = "";
    }
    return out;
  }, [entry]);

  const [values, setValues] = useState<Record<string, unknown>>(initial);
  const [confirmId, setConfirmId] = useState("");
  const [banner, setBanner] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [submitting, setSubmitting] = useState(false);

  const dangerLocked =
    entry.dangerLevel === "high" && confirmId !== entry.id;

  const setValue = (name: string, value: unknown) => {
    setValues((prev) => ({ ...prev, [name]: value }));
  };

  const submit = async () => {
    setBanner(null);
    setFieldErrors({});
    setSubmitting(true);
    try {
      // Coerce numeric strings
      const params: Record<string, unknown> = {};
      for (const f of entry.fields) {
        const key = kebabToCamel(f.name);
        const v = values[key];
        if (v === "" && !f.required) continue;
        if (f.type === "number" && typeof v === "string") {
          params[key] = Number(v);
        } else {
          params[key] = v;
        }
      }
      const res = await api.post<RunResponse>(
        `/scripts/${entry.id}/run`,
        { serverId, params },
      );
      onClose();
      // Navigate to the live run view — simplest is window.location.
      window.location.hash = `/runs/${res.runId}`;
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.code === "INVALID_PARAMS" && err.details) {
          const fe = (err.details as { fieldErrors?: Record<string, string[]> })
            .fieldErrors;
          if (fe) setFieldErrors(fe);
          else setBanner(err.message);
        } else if (err.code === "DEPLOYMENT_LOCKED") {
          const d = err.details as { lockedBy?: string } | undefined;
          setBanner(
            `Another operation is in progress on this server${
              d?.lockedBy ? ` (${d.lockedBy})` : ""
            }`,
          );
        } else {
          setBanner(err.message);
        }
      } else {
        setBanner((err as Error).message);
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-neutral-900 border border-neutral-700 rounded-lg shadow-xl p-5 w-full max-w-lg">
        <div className="flex items-start justify-between mb-4">
          <div>
            <h2 className="text-lg font-semibold">Run {entry.id}</h2>
            <p className="text-sm text-neutral-400 mt-1">{entry.description}</p>
          </div>
          <button
            type="button"
            aria-label="Close"
            className="text-neutral-400 hover:text-white"
            onClick={onClose}
          >
            ✕
          </button>
        </div>
        {banner && (
          <div className="mb-3 p-2 bg-red-900/30 border border-red-700 text-red-200 text-sm rounded">
            {banner}
          </div>
        )}
        <div className="space-y-3">
          {entry.fields.length === 0 && (
            <p className="text-sm text-neutral-500 italic">No parameters.</p>
          )}
          {entry.fields.map((f) => {
            const key = kebabToCamel(f.name);
            const val = values[key];
            const err = fieldErrors[key];
            return (
              <div key={f.name}>
                <label className="block text-xs text-neutral-300 mb-1">
                  {f.name}
                  {f.required && <span className="text-red-400 ml-1">*</span>}
                </label>
                {f.type === "boolean" ? (
                  <input
                    type="checkbox"
                    checked={Boolean(val)}
                    onChange={(e) => setValue(key, e.target.checked)}
                  />
                ) : f.type === "enum" ? (
                  <select
                    className="w-full bg-neutral-800 border border-neutral-700 rounded px-2 py-1 text-sm"
                    value={String(val ?? "")}
                    onChange={(e) => setValue(key, e.target.value)}
                  >
                    <option value="">—</option>
                    {(f.enumValues ?? []).map((v) => (
                      <option key={v} value={v}>
                        {v}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    type={
                      f.isSecret ? "password" : f.type === "number" ? "number" : "text"
                    }
                    autoComplete={f.isSecret ? "new-password" : "off"}
                    className="w-full bg-neutral-800 border border-neutral-700 rounded px-2 py-1 text-sm"
                    value={String(val ?? "")}
                    onChange={(e) => setValue(key, e.target.value)}
                  />
                )}
                {err && (
                  <div className="text-xs text-red-400 mt-1">{err.join(", ")}</div>
                )}
              </div>
            );
          })}
          {entry.dangerLevel === "high" && (
            <div className="mt-3 p-3 bg-red-950/40 border border-red-800 rounded">
              <label className="block text-xs text-red-200 mb-1">
                Type <code>{entry.id}</code> to confirm:
              </label>
              <input
                type="text"
                className="w-full bg-neutral-800 border border-red-700 rounded px-2 py-1 text-sm"
                value={confirmId}
                onChange={(e) => setConfirmId(e.target.value)}
              />
            </div>
          )}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            className="px-3 py-1 text-sm bg-neutral-800 hover:bg-neutral-700 rounded"
            onClick={onClose}
            disabled={submitting}
          >
            Cancel
          </button>
          <button
            type="button"
            className="px-3 py-1 text-sm bg-blue-600 hover:bg-blue-500 disabled:bg-neutral-700 rounded"
            disabled={submitting || dangerLocked}
            onClick={submit}
          >
            {submitting ? "Starting…" : "Run"}
          </button>
        </div>
      </div>
    </div>
  );
}
