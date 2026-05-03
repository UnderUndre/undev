import React, { useState } from "react";
import { ScriptPathField } from "./ScriptPathField.js";
import { HealthSection } from "./AddAppForm.js";

export interface EditAppFormValues {
  name: string;
  branch: string;
  remotePath: string;
  scriptPath: string | null;
  composePath: string;
  // Phase 3 (008-revised) — labels for caddy-docker-proxy. Both required for
  // the dashboard to write a docker-compose.dashboard.yml override.
  upstreamService: string;
  upstreamPort: string; // input is text; transform to int|null on submit
  // Feature 006 T040 — health config fields surfaced in the edit form.
  healthUrl: string | null;
  monitoringEnabled: boolean;
  alertsMuted: boolean;
  healthProbeIntervalSec: number;
  healthDebounceCount: number;
}

export interface EditAppFormProps {
  initialValues: EditAppFormValues;
  onSubmit: (values: EditAppFormValues) => void;
  onCancel: () => void;
  mutation: { isPending: boolean; isError: boolean; error: Error | null };
}

export function EditAppForm({
  initialValues,
  onSubmit,
  onCancel,
  mutation,
}: EditAppFormProps) {
  const [form, setForm] = useState<EditAppFormValues>(initialValues);

  function update<K extends keyof EditAppFormValues>(
    key: K,
    value: EditAppFormValues[K],
  ) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    onSubmit(form);
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="bg-gray-900 border border-gray-800 rounded-lg p-4 mb-4 space-y-3"
    >
      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          <span className="text-sm text-gray-400 mb-1 block">Name</span>
          <input
            type="text"
            value={form.name}
            onChange={(e) => update("name", e.target.value)}
            className="w-full bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-brand-purple"
          />
        </label>
        <label className="block">
          <span className="text-sm text-gray-400 mb-1 block">Branch</span>
          <input
            type="text"
            value={form.branch}
            onChange={(e) => update("branch", e.target.value)}
            className="w-full bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-brand-purple"
          />
        </label>
      </div>
      <label className="block">
        <span className="text-sm text-gray-400 mb-1 block">Remote Path</span>
        <input
          type="text"
          value={form.remotePath}
          onChange={(e) => update("remotePath", e.target.value)}
          className="w-full bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-brand-purple"
        />
      </label>

      <label className="block">
        <span className="text-sm text-gray-400 mb-1 block">Compose Path</span>
        <input
          type="text"
          value={form.composePath}
          onChange={(e) => update("composePath", e.target.value)}
          placeholder="docker-compose.yml"
          className="w-full bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-brand-purple"
        />
        <p className="text-xs text-gray-500 mt-1">
          Repo-relative path to the compose file. Leave empty for default
          (<code className="text-gray-400">docker-compose.yml</code> →{" "}
          <code className="text-gray-400">compose.yml</code>). Set for non-standard names
          like <code className="text-gray-400">docker-compose.local.yml</code>.
        </p>
      </label>

      <ScriptPathField
        value={form.scriptPath}
        onChange={(v) => update("scriptPath", v)}
      />

      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          <span className="text-sm text-gray-400 mb-1 block">Upstream Service</span>
          <input
            type="text"
            value={form.upstreamService}
            onChange={(e) => update("upstreamService", e.target.value)}
            placeholder="app"
            className="w-full bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:border-brand-purple"
          />
          <p className="text-xs text-gray-500 mt-1">
            Compose service name (e.g. <code className="text-gray-400">app</code>,{" "}
            <code className="text-gray-400">9router</code>). Required for Caddy labels.
          </p>
        </label>
        <label className="block">
          <span className="text-sm text-gray-400 mb-1 block">Upstream Port</span>
          <input
            type="number"
            min={1}
            max={65535}
            value={form.upstreamPort}
            onChange={(e) => update("upstreamPort", e.target.value)}
            placeholder="3000"
            className="w-full bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:border-brand-purple"
          />
          <p className="text-xs text-gray-500 mt-1">
            Container port the service listens on (e.g. 3000, 8317, 20128).
          </p>
        </label>
      </div>

      <HealthSection
        values={form}
        onUrl={(v) => update("healthUrl", v)}
        onMonitoring={(v) => update("monitoringEnabled", v)}
        onMuted={(v) => update("alertsMuted", v)}
        onInterval={(v) => update("healthProbeIntervalSec", v)}
        onDebounce={(v) => update("healthDebounceCount", v)}
      />

      {mutation.isError && (
        <div className="text-sm text-red-400">
          {mutation.error instanceof Error
            ? mutation.error.message
            : "Failed to update application"}
        </div>
      )}

      <div className="flex justify-end gap-3">
        <button
          type="button"
          onClick={onCancel}
          className="px-3 py-1.5 text-sm text-gray-400 hover:text-white transition-colors"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={mutation.isPending}
          className="bg-brand-purple hover:bg-purple-600 disabled:opacity-50 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors"
        >
          {mutation.isPending ? "Saving..." : "Save"}
        </button>
      </div>
    </form>
  );
}
