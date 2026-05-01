import React, { useState } from "react";
import { ScriptPathField } from "./ScriptPathField.js";
import { HealthSection } from "./AddAppForm.js";

export interface EditAppFormValues {
  name: string;
  branch: string;
  remotePath: string;
  scriptPath: string | null;
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

      <ScriptPathField
        value={form.scriptPath}
        onChange={(v) => update("scriptPath", v)}
      />

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
