import React, { useState } from "react";
import { RepoSearch, type RepoSelection } from "../github/RepoSearch.js";
import { BranchSelect } from "../github/BranchSelect.js";
import { useGitHubConnection } from "../../hooks/useGitHub.js";
import { ScriptPathField } from "./ScriptPathField.js";
import { HealthCheckUrlInput } from "./HealthCheckUrlInput.js";

export type AppSource = "manual" | "scan";

export interface AddAppFormValues {
  name: string;
  repoUrl: string;
  branch: string;
  remotePath: string;
  githubRepo: string | null;
  scriptPath: string | null;
  // Feature 006 T042 — health config defaults applied at form mount.
  healthUrl: string | null;
  monitoringEnabled: boolean;
  alertsMuted: boolean;
  healthProbeIntervalSec: number;
  healthDebounceCount: number;
}

export interface AddAppFormProps {
  initialValues: AddAppFormValues;
  source: AppSource;
  /**
   * When set, indicates a Docker-only import (repoUrl starts with `docker://`).
   * Hides branch/repoUrl inputs and shows a badge.
   */
  dockerMode?: boolean;
  onSubmit: (values: AddAppFormValues & { source: AppSource }) => void;
  onCancel: () => void;
  mutation: { isPending: boolean; isError: boolean; error: Error | null };
}

export function AddAppForm({
  initialValues,
  source,
  dockerMode = false,
  onSubmit,
  onCancel,
  mutation,
}: AddAppFormProps) {
  const [form, setForm] = useState<AddAppFormValues>(initialValues);
  const { data: ghConnection } = useGitHubConnection();
  const [manualMode, setManualMode] = useState(source === "scan"); // scan imports skip GH picker

  const useGhPicker = !dockerMode && Boolean(ghConnection) && !manualMode;

  function update<K extends keyof AddAppFormValues>(key: K, value: AddAppFormValues[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function handleRepoSelect(repo: RepoSelection) {
    setForm((prev) => ({
      ...prev,
      name: repo.name || prev.name,
      repoUrl: repo.repoUrl,
      branch: repo.defaultBranch,
      githubRepo: repo.fullName,
    }));
  }

  const [ghOwner, ghRepo] = form.githubRepo?.split("/") ?? [undefined, undefined];

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    onSubmit({ ...form, source });
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="bg-gray-900 border border-gray-800 rounded-lg p-4 mb-4 space-y-3"
    >
      {dockerMode && (
        <div className="flex items-center gap-2 pb-3 border-b border-gray-800">
          <span className="rounded bg-purple-900/50 px-2 py-0.5 text-xs text-purple-300 border border-purple-700">
            Docker app
          </span>
          <span className="text-xs text-gray-500">
            Repository and branch are not used for Docker-only imports.
          </span>
        </div>
      )}

      {!dockerMode && useGhPicker && (
        <div className="space-y-2 pb-3 border-b border-gray-800">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-gray-300">Select GitHub repository</span>
            <button
              type="button"
              onClick={() => {
                setManualMode(true);
                update("githubRepo", null);
              }}
              className="text-xs text-gray-500 hover:text-gray-300 underline"
            >
              Enter manually
            </button>
          </div>
          <RepoSearch onSelect={handleRepoSelect} selected={form.githubRepo ?? undefined} />
          {form.githubRepo && (
            <div className="space-y-1">
              <span className="text-xs text-gray-400">Branch</span>
              <BranchSelect
                owner={ghOwner}
                repo={ghRepo}
                value={form.branch}
                onChange={(b) => update("branch", b)}
              />
            </div>
          )}
        </div>
      )}
      {!dockerMode && !useGhPicker && ghConnection && (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => setManualMode(false)}
            className="text-xs text-gray-500 hover:text-gray-300 underline"
          >
            Pick from GitHub
          </button>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          <span className="text-sm text-gray-400 mb-1 block">
            Name <span className="text-red-500">*</span>
          </span>
          <input
            type="text"
            value={form.name}
            onChange={(e) => update("name", e.target.value)}
            placeholder="my-api"
            required
            className="w-full bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-brand-purple"
          />
        </label>
        {!dockerMode && (
          <label className="block">
            <span className="text-sm text-gray-400 mb-1 block">Branch</span>
            <input
              type="text"
              value={form.branch}
              onChange={(e) => update("branch", e.target.value)}
              placeholder="main"
              disabled={useGhPicker && Boolean(form.githubRepo)}
              className="w-full bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-brand-purple disabled:opacity-60"
            />
          </label>
        )}
      </div>

      {!dockerMode && (
        <label className="block">
          <span className="text-sm text-gray-400 mb-1 block">
            Repository URL <span className="text-red-500">*</span>
          </span>
          <input
            type="text"
            value={form.repoUrl}
            onChange={(e) => update("repoUrl", e.target.value)}
            placeholder="git@github.com:org/repo.git"
            required
            disabled={useGhPicker && Boolean(form.githubRepo)}
            className="w-full bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-brand-purple disabled:opacity-60"
          />
        </label>
      )}

      <label className="block">
        <span className="text-sm text-gray-400 mb-1 block">
          Remote Path <span className="text-red-500">*</span>
        </span>
        <input
          type="text"
          value={form.remotePath}
          onChange={(e) => update("remotePath", e.target.value)}
          placeholder="/var/www/my-api"
          required
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
          {mutation.error instanceof Error ? mutation.error.message : "Failed to add application"}
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
          {mutation.isPending ? "Adding..." : "Add"}
        </button>
      </div>
    </form>
  );
}

// Feature 006 T042 / T040 — shared Health section, used in Add & Edit forms.
interface HealthSectionValues {
  healthUrl: string | null;
  monitoringEnabled: boolean;
  alertsMuted: boolean;
  healthProbeIntervalSec: number;
  healthDebounceCount: number;
}
interface HealthSectionProps {
  values: HealthSectionValues;
  onUrl: (v: string | null) => void;
  onMonitoring: (v: boolean) => void;
  onMuted: (v: boolean) => void;
  onInterval: (v: number) => void;
  onDebounce: (v: number) => void;
}
export function HealthSection({
  values,
  onUrl,
  onMonitoring,
  onMuted,
  onInterval,
  onDebounce,
}: HealthSectionProps) {
  return (
    <fieldset className="space-y-3 pt-3 border-t border-gray-800">
      <legend className="text-sm font-medium text-gray-300">Health monitoring</legend>
      <HealthCheckUrlInput value={values.healthUrl} onChange={onUrl} />
      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          <span className="text-sm text-gray-400 mb-1 block">
            Probe interval (seconds, min 10)
          </span>
          <input
            type="number"
            min={10}
            value={values.healthProbeIntervalSec}
            onChange={(e) => {
              const n = Number.parseInt(e.target.value, 10);
              onInterval(Number.isFinite(n) ? n : 60);
            }}
            className="w-full bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-brand-purple"
          />
        </label>
        <label className="block">
          <span className="text-sm text-gray-400 mb-1 block">
            Debounce count (min 1)
          </span>
          <input
            type="number"
            min={1}
            value={values.healthDebounceCount}
            onChange={(e) => {
              const n = Number.parseInt(e.target.value, 10);
              onDebounce(Number.isFinite(n) ? n : 2);
            }}
            className="w-full bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-brand-purple"
          />
        </label>
      </div>
      <div className="flex flex-wrap gap-4">
        <label className="inline-flex items-center gap-2 text-sm text-gray-300">
          <input
            type="checkbox"
            checked={values.monitoringEnabled}
            onChange={(e) => onMonitoring(e.target.checked)}
          />
          Monitoring enabled
        </label>
        <label className="inline-flex items-center gap-2 text-sm text-gray-300">
          <input
            type="checkbox"
            checked={values.alertsMuted}
            onChange={(e) => onMuted(e.target.checked)}
          />
          Alerts muted (UI tracks, Telegram silent)
        </label>
      </div>
    </fieldset>
  );
}
