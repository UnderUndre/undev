import React, { useId } from "react";
import { useBranches } from "../../hooks/useGitHub.js";
import { GitHubWarning } from "./GitHubWarning.js";
import { ApiError } from "../../lib/api.js";

interface Props {
  owner: string | undefined;
  repo: string | undefined;
  value: string;
  onChange: (branch: string) => void;
  disabled?: boolean;
  className?: string;
}

/**
 * Searchable branch picker. Uses a text input bound to a native <datalist> —
 * gives us free fuzzy search + arrow-key navigation without pulling in a
 * combobox library. Repos with 200+ branches no longer need a scroll marathon
 * to find `main`; the default branch is hoisted to the top of the list.
 */
export function BranchSelect({ owner, repo, value, onChange, disabled, className = "" }: Props) {
  const listId = useId();
  const { data: branches, isLoading, error } = useBranches(owner, repo);

  if (!owner || !repo) {
    return (
      <input
        disabled
        value=""
        placeholder="Select a repository first"
        className={`${className} w-full px-3 py-2 bg-gray-950 border border-gray-700 rounded-md text-gray-500`}
      />
    );
  }

  if (error instanceof ApiError) {
    if (error.code === "GITHUB_RATE_LIMITED") return <GitHubWarning variant="rate_limited" />;
    if (error.code === "GITHUB_UNAUTHORIZED") return <GitHubWarning variant="token_expired" />;
    if (error.code === "GITHUB_NOT_CONNECTED") return <GitHubWarning variant="not_connected" />;
    return <GitHubWarning variant="error" message={error.message} />;
  }

  if (isLoading) {
    return (
      <input
        disabled
        value=""
        placeholder="Loading branches…"
        className={`${className} w-full px-3 py-2 bg-gray-950 border border-gray-700 rounded-md text-gray-500`}
      />
    );
  }

  const total = branches?.length ?? 0;
  const placeholder =
    total > 0
      ? `Type to search ${total} branch${total === 1 ? "" : "es"}…`
      : "No branches";

  return (
    <>
      <input
        type="text"
        list={listId}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        className={`${className} w-full px-3 py-2 bg-gray-950 border border-gray-700 rounded-md text-white focus:outline-none focus:border-brand-purple`}
      />
      <datalist id={listId}>
        {branches?.map((b) => (
          <option key={b.name} value={b.name}>
            {b.isDefault ? "default" : ""}
          </option>
        ))}
      </datalist>
    </>
  );
}
