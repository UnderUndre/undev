import React, { useState } from "react";
import { validateScriptPath } from "../../lib/validate-script-path.js";

export interface ScriptPathFieldProps {
  value: string | null;
  onChange: (next: string | null) => void;
  label?: string;
  placeholder?: string;
}

export function ScriptPathField({
  value,
  onChange,
  label = "Project Deploy Script",
  placeholder = "scripts/devops-deploy.sh",
}: ScriptPathFieldProps) {
  // Mirror the parent's value into a local string for cursor-stable editing,
  // but propagate every keystroke back via onChange so the parent never
  // submits a stale value (the operator's last visible input always wins).
  const [draft, setDraft] = useState<string>(value ?? "");
  const [error, setError] = useState<string | null>(null);

  // Sync local draft if parent value changes externally (e.g. after a fetch).
  React.useEffect(() => {
    setDraft(value ?? "");
  }, [value]);

  function pushUpstream(next: string) {
    const result = validateScriptPath(next);
    if (!result.ok) {
      // Keep the parent's last-known-valid value untouched on invalid input —
      // submission is gated by the inline error rendered below.
      return;
    }
    onChange(result.value);
  }

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const next = e.target.value;
    setDraft(next);
    // Live validation feedback as the operator types.
    const result = validateScriptPath(next);
    setError(result.ok ? null : result.error);
    if (result.ok) onChange(result.value);
  }

  function handleBlur() {
    pushUpstream(draft);
  }

  return (
    <label className="block">
      <span className="text-sm text-gray-400 mb-1 block">{label}</span>
      <input
        type="text"
        value={draft}
        onChange={handleChange}
        onBlur={handleBlur}
        placeholder={placeholder}
        className="w-full bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:border-brand-purple"
      />
      <span className="block text-xs text-gray-500 mt-1">
        Relative path to a bash script inside the repo. Shebang is ignored — the
        script is invoked as <code>bash &lt;path&gt;</code>. Non-bash scripts
        (Python, Node, compiled binaries) must be wrapped in a bash entrypoint.
        Leave empty to use the builtin deploy.
      </span>
      {error && (
        <span className="block text-xs text-red-400 mt-1">{error}</span>
      )}
    </label>
  );
}
