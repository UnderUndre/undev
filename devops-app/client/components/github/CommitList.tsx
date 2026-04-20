import React from "react";
import { useCommits, type GitHubCommit, type CommitStatus } from "../../hooks/useGitHub.js";
import { GitHubWarning } from "./GitHubWarning.js";
import { ApiError } from "../../lib/api.js";

interface Props {
  owner: string | undefined;
  repo: string | undefined;
  branch: string | undefined;
  onDeploy: (sha: string) => void;
  isDeploying?: boolean;
}

export function CommitList({ owner, repo, branch, onDeploy, isDeploying }: Props) {
  const { data: commits, isLoading, error, refresh } = useCommits(owner, repo, branch, 20);

  if (!owner || !repo || !branch) {
    return <div className="text-sm text-gray-400">Select a branch to see commits.</div>;
  }

  if (error instanceof ApiError) {
    if (error.code === "GITHUB_NOT_CONNECTED") return <GitHubWarning variant="not_connected" />;
    if (error.code === "GITHUB_RATE_LIMITED") return <GitHubWarning variant="rate_limited" />;
    if (error.code === "GITHUB_UNAUTHORIZED") return <GitHubWarning variant="token_expired" />;
    return <GitHubWarning variant="error" message={error.message} />;
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-gray-300">
          Recent commits on <span className="font-mono">{branch}</span>
        </h3>
        <button
          type="button"
          onClick={() => refresh()}
          className="text-xs text-gray-500 hover:text-gray-300 underline"
        >
          Refresh
        </button>
      </div>

      {isLoading && <div className="text-sm text-gray-400">Loading commits…</div>}

      {commits && commits.length === 0 && (
        <div className="text-sm text-gray-400">No commits on this branch.</div>
      )}

      {commits && commits.length > 0 && (
        <ul className="border border-gray-800 rounded-md divide-y divide-gray-800">
          {commits.map((c) => (
            <CommitRow key={c.sha} commit={c} onDeploy={onDeploy} isDeploying={isDeploying} />
          ))}
        </ul>
      )}
    </div>
  );
}

function CommitRow({
  commit,
  onDeploy,
  isDeploying,
}: {
  commit: GitHubCommit;
  onDeploy: (sha: string) => void;
  isDeploying?: boolean;
}) {
  return (
    <li className="flex items-center justify-between gap-3 px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <StatusBadge status={commit.status} />
          <span className="text-sm text-white truncate">{commit.message}</span>
        </div>
        <div className="text-xs text-gray-500 mt-0.5 font-mono">
          {commit.shortSha} · {commit.author} · {new Date(commit.date).toLocaleString()}
        </div>
      </div>
      <button
        type="button"
        onClick={() => onDeploy(commit.sha)}
        disabled={isDeploying}
        className="shrink-0 px-3 py-1 text-xs font-medium rounded-md bg-brand-purple hover:bg-purple-600 disabled:opacity-50 transition-colors"
      >
        Deploy
      </button>
    </li>
  );
}

function StatusBadge({ status }: { status: CommitStatus }) {
  const cls =
    status === "success"
      ? "bg-green-600"
      : status === "failure"
        ? "bg-red-600"
        : status === "pending"
          ? "bg-yellow-500"
          : "bg-gray-600";
  const title =
    status === "success"
      ? "CI success"
      : status === "failure"
        ? "CI failed"
        : status === "pending"
          ? "CI pending"
          : "No CI";
  return <span title={title} className={`inline-block w-2 h-2 rounded-full ${cls}`} />;
}
