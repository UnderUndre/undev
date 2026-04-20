import React from "react";
import type { GitCandidate } from "../../hooks/useScan.js";

interface Props {
  candidate: GitCandidate;
  onImport: (c: GitCandidate) => void;
}

function shortSha(sha: string | null): string {
  return sha ? sha.slice(0, 7) : "—";
}

export function GitCandidateRow({ candidate: c, onImport }: Props) {
  const importDisabled = c.alreadyImported || c.detached;
  const importHint = c.detached
    ? "Check out a branch on server first"
    : c.alreadyImported
      ? "Already imported"
      : undefined;

  // First deploy after import runs `git reset --hard FETCH_HEAD`, which wipes
  // local uncommitted changes to tracked files. Warn the admin when the
  // working tree state is dirty or unknown so an accidental import doesn't
  // cost them their hand-edited files.
  const needsResetConfirm = c.dirty === "dirty" || c.dirty === "unknown";

  function handleImportClick() {
    if (needsResetConfirm) {
      const detail =
        c.dirty === "dirty"
          ? "This working tree has uncommitted changes."
          : "Git status could not be read (timeout or permission error) — the working tree may have uncommitted changes.";
      const ok = window.confirm(
        `${detail}\n\nFirst deploy will run "git reset --hard FETCH_HEAD", ` +
          `which discards tracked-file modifications. Untracked files survive.\n\n` +
          `Import anyway?`,
      );
      if (!ok) return;
    }
    onImport(c);
  }

  return (
    <li className="flex items-start justify-between gap-4 rounded-md border border-gray-700 bg-gray-900/50 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-mono text-sm text-gray-100">{c.path}</span>
          {c.detached && (
            <span className="rounded bg-red-900/50 px-2 py-0.5 text-xs text-red-300 border border-red-700">
              Detached HEAD
            </span>
          )}
          {c.dirty === "dirty" && (
            <span className="rounded bg-yellow-900/50 px-2 py-0.5 text-xs text-yellow-300 border border-yellow-700">
              Dirty
            </span>
          )}
          {c.dirty === "unknown" && (
            <span
              className="rounded bg-gray-800 px-2 py-0.5 text-xs text-gray-400 border border-gray-600"
              title="git status failed or timed out"
            >
              Status unknown
            </span>
          )}
          {c.alreadyImported && (
            <span className="rounded bg-blue-900/50 px-2 py-0.5 text-xs text-blue-300 border border-blue-700">
              Already added
            </span>
          )}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-400">
          <span>
            branch: <span className="font-mono text-gray-300">{c.detached ? "—" : c.branch || "—"}</span>
          </span>
          <span>
            sha: <span className="font-mono text-gray-300">{shortSha(c.commitSha)}</span>
          </span>
          {c.githubRepo && (
            <span>
              github: <span className="font-mono text-gray-300">{c.githubRepo}</span>
            </span>
          )}
        </div>
        {c.commitSubject && (
          <div className="mt-1 truncate text-xs text-gray-500" title={c.commitSubject}>
            {c.commitSubject}
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={handleImportClick}
        disabled={importDisabled}
        title={importHint}
        className="shrink-0 rounded-md bg-purple-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-purple-500 disabled:cursor-not-allowed disabled:bg-gray-700 disabled:text-gray-500"
      >
        {c.alreadyImported ? "Added" : "Import"}
      </button>
    </li>
  );
}
