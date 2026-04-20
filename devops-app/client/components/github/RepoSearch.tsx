import React, { useEffect, useState } from "react";
import {
  useGitHubConnection,
  useRepoSearch,
  type GitHubRepository,
} from "../../hooks/useGitHub.js";
import { GitHubWarning } from "./GitHubWarning.js";
import { ApiError } from "../../lib/api.js";

export interface RepoSelection {
  fullName: string;
  name: string;
  repoUrl: string;
  defaultBranch: string;
}

interface Props {
  onSelect: (repo: RepoSelection) => void;
  selected?: string; // fullName of selected repo, if any
}

export function RepoSearch({ onSelect, selected }: Props) {
  const { data: connection, isLoading: connLoading } = useGitHubConnection();
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");

  // 300 ms debounce
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query), 300);
    return () => clearTimeout(t);
  }, [query]);

  const { data: repos, isLoading, error } = useRepoSearch(debounced);

  if (connLoading) return <div className="text-sm text-gray-400">Loading…</div>;
  if (!connection) return <GitHubWarning variant="not_connected" />;

  const apiError = error instanceof ApiError ? error : null;

  return (
    <div className="space-y-3">
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search your repositories…"
        className="w-full px-3 py-2 bg-gray-950 border border-gray-700 rounded-md text-white focus:outline-none focus:border-brand-purple"
      />

      {apiError?.code === "GITHUB_RATE_LIMITED" && (
        <GitHubWarning variant="rate_limited" />
      )}
      {apiError?.code === "GITHUB_UNAUTHORIZED" && (
        <GitHubWarning variant="token_expired" />
      )}

      {debounced.length >= 2 && isLoading && (
        <div className="text-sm text-gray-400">Searching…</div>
      )}

      {repos && repos.length === 0 && debounced.length >= 2 && !isLoading && (
        <div className="text-sm text-gray-400">No repositories found.</div>
      )}

      {repos && repos.length > 0 && (
        <ul className="max-h-80 overflow-y-auto border border-gray-800 rounded-md divide-y divide-gray-800">
          {repos.map((r) => (
            <RepoRow
              key={r.fullName}
              repo={r}
              isSelected={selected === r.fullName}
              onClick={() =>
                onSelect({
                  fullName: r.fullName,
                  name: r.name,
                  repoUrl: `https://github.com/${r.fullName}`,
                  defaultBranch: r.defaultBranch,
                })
              }
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function RepoRow({
  repo,
  isSelected,
  onClick,
}: {
  repo: GitHubRepository;
  isSelected: boolean;
  onClick: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        className={`w-full text-left px-3 py-2 hover:bg-gray-900 ${
          isSelected ? "bg-gray-900" : ""
        }`}
      >
        <div className="flex items-center gap-2">
          <span className="font-medium text-white">{repo.fullName}</span>
          {repo.isPrivate && (
            <span className="text-xs px-2 py-0.5 rounded bg-gray-800 text-gray-300">
              private
            </span>
          )}
          <span className="text-xs text-gray-500 ml-auto">
            default: {repo.defaultBranch}
          </span>
        </div>
        {repo.description && (
          <div className="text-xs text-gray-400 mt-1 line-clamp-1">
            {repo.description}
          </div>
        )}
      </button>
    </li>
  );
}
