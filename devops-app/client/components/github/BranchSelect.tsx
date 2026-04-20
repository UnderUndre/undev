import React from "react";
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

export function BranchSelect({ owner, repo, value, onChange, disabled, className = "" }: Props) {
  const { data: branches, isLoading, error } = useBranches(owner, repo);

  if (!owner || !repo) {
    return (
      <select disabled className={`${className} w-full px-3 py-2 bg-gray-950 border border-gray-700 rounded-md`}>
        <option>Select a repository first</option>
      </select>
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
      <select disabled className={`${className} w-full px-3 py-2 bg-gray-950 border border-gray-700 rounded-md`}>
        <option>Loading branches…</option>
      </select>
    );
  }

  return (
    <select
      disabled={disabled}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={`${className} w-full px-3 py-2 bg-gray-950 border border-gray-700 rounded-md text-white focus:outline-none focus:border-brand-purple`}
    >
      {branches?.map((b) => (
        <option key={b.name} value={b.name}>
          {b.name}
          {b.isDefault ? " (default)" : ""}
        </option>
      ))}
    </select>
  );
}
