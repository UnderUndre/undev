import React, { useEffect, useId, useRef, useState } from "react";
import { useBranches, type GitHubBranch } from "../../hooks/useGitHub.js";
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
 * Searchable branch picker.
 *
 * Architectural note: `onChange` is called only when the user **commits** a
 * choice (blur, Enter, or selecting an option from the datalist), NOT on
 * every keystroke. Reason: callers (e.g. AppPage) often wire onChange to a
 * server mutation which then refetches the parent's data and forces a
 * re-render — a per-keystroke pipeline like that loses input focus on
 * every character. By buffering keystrokes in a local `draft` state and
 * only emitting on commit, the input stays focused while typing.
 *
 * The `value` prop is reflected into `draft` only while the input is NOT
 * focused, so external updates (e.g. server-side branch change) are
 * respected without trampling user input mid-typing.
 */
export function BranchSelect({ owner, repo, value, onChange, disabled, className = "" }: Props) {
  const listId = useId();
  const { data: branches, isLoading, error } = useBranches(owner, repo);

  const [draft, setDraft] = useState(value);
  const focusedRef = useRef(false);

  // Pull external value into the draft only while not focused — preserves
  // typing in progress.
  useEffect(() => {
    if (!focusedRef.current) setDraft(value);
  }, [value]);

  function commit(next: string) {
    const trimmed = next.trim();
    if (trimmed === value) return; // no-op, avoid spurious mutations
    if (!isKnownBranch(branches, trimmed)) {
      // Not a real branch — revert the draft to last committed value.
      setDraft(value);
      return;
    }
    onChange(trimmed);
  }

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
        value={draft}
        disabled={disabled}
        onFocus={() => {
          focusedRef.current = true;
        }}
        onChange={(e) => {
          // Detect "select from datalist" — browser fires `input` event
          // synchronously when an option is picked (not a keystroke). The
          // simplest heuristic that works cross-browser: if the new value is
          // an exact match of a known branch, commit immediately.
          const next = e.target.value;
          setDraft(next);
          if (isKnownBranch(branches, next)) commit(next);
        }}
        onBlur={() => {
          focusedRef.current = false;
          commit(draft);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit(draft);
            (e.currentTarget as HTMLInputElement).blur();
          } else if (e.key === "Escape") {
            setDraft(value); // discard
            (e.currentTarget as HTMLInputElement).blur();
          }
        }}
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

function isKnownBranch(branches: GitHubBranch[] | undefined, name: string): boolean {
  if (!name || !branches) return false;
  return branches.some((b) => b.name === name);
}
