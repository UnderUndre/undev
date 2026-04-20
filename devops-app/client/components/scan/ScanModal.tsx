import React, { useEffect } from "react";
import { ApiError } from "../../lib/api.js";
import {
  useScan,
  type GitCandidate,
  type DockerCandidate,
} from "../../hooks/useScan.js";
import { GitCandidateRow } from "./GitCandidateRow.js";
import { DockerCandidateRow } from "./DockerCandidateRow.js";

interface Props {
  serverId: string;
  onClose: () => void;
  onImportGit: (candidate: GitCandidate) => void;
  onImportDocker: (candidate: DockerCandidate) => void;
}

function InProgressBanner({ since, byUserId }: { since: string; byUserId: string }) {
  const when = (() => {
    try {
      return new Date(since).toLocaleString();
    } catch {
      return since;
    }
  })();
  return (
    <div className="rounded-md border border-yellow-700 bg-yellow-900/30 px-4 py-3 text-sm text-yellow-200">
      Another scan is already running on this server
      <div className="mt-1 text-xs text-yellow-300/80">
        started {when} by {byUserId}
      </div>
    </div>
  );
}

export function ScanModal({ serverId, onClose, onImportGit, onImportDocker }: Props) {
  const { mutate, data, isPending, error, reset, abort } = useScan(serverId);

  // Kick off the first scan when the modal opens.
  useEffect(() => {
    mutate();
    return () => abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId]);

  // ESC to close (but not cancel — user can hit Cancel for that).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        if (isPending) {
          abort();
        } else {
          onClose();
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isPending, abort, onClose]);

  const inProgressDetails =
    error instanceof ApiError && error.code === "SCAN_IN_PROGRESS"
      ? (error.details as { since: string; byUserId: string } | undefined)
      : undefined;

  const apiErr = error instanceof ApiError ? error : null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget && !isPending) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-label="Scan Server"
    >
      <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-3xl mx-4 shadow-2xl max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-800">
          <h2 className="text-lg font-semibold">Scan Server</h2>
          <button
            onClick={onClose}
            disabled={isPending}
            className="text-gray-500 hover:text-gray-300 text-xl leading-none disabled:text-gray-700"
            aria-label="Close dialog"
          >
            &times;
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-4">
          {isPending && (
            <div className="flex items-center justify-between rounded-md border border-gray-700 bg-gray-900/50 px-4 py-3">
              <div className="flex items-center gap-3 text-sm text-gray-300">
                <span className="h-4 w-4 animate-spin rounded-full border-2 border-purple-500 border-t-transparent" />
                Scanning server…
              </div>
              <button
                type="button"
                onClick={() => abort()}
                className="rounded-md border border-gray-600 px-3 py-1.5 text-sm text-gray-200 hover:bg-gray-800"
              >
                Cancel
              </button>
            </div>
          )}

          {inProgressDetails && (
            <InProgressBanner
              since={inProgressDetails.since}
              byUserId={inProgressDetails.byUserId}
            />
          )}

          {apiErr && !inProgressDetails && (
            <div className="rounded-md border border-red-700 bg-red-900/30 px-4 py-3 text-sm text-red-200">
              <div className="font-medium">Scan failed</div>
              <div className="mt-1 text-xs text-red-300/80">
                {apiErr.code}: {apiErr.message}
              </div>
              <button
                type="button"
                onClick={() => {
                  reset();
                  mutate();
                }}
                className="mt-2 rounded-md border border-red-600 px-3 py-1.5 text-xs text-red-100 hover:bg-red-900/50"
              >
                Retry
              </button>
            </div>
          )}

          {data && (
            <>
              {data.partial && (
                <div className="rounded-md border border-yellow-700 bg-yellow-900/30 px-4 py-3 text-sm text-yellow-200">
                  Scan timed out after 60s — showing partial results (
                  {data.gitCandidates.length + data.dockerCandidates.length} candidates).
                  Narrow your scan roots in server settings and try again.
                </div>
              )}

              <section>
                <div className="mb-2 flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-gray-200">
                    Git repositories{" "}
                    <span className="text-gray-500">
                      ({data.gitCandidates.length})
                    </span>
                  </h3>
                  {!data.gitAvailable && (
                    <span className="text-xs text-gray-500">git not available on host</span>
                  )}
                </div>
                {data.gitCandidates.length === 0 ? (
                  <div className="rounded-md border border-gray-800 bg-gray-900/30 px-4 py-3 text-sm text-gray-500">
                    No git repositories found under the configured scan roots.
                  </div>
                ) : (
                  <ul className="space-y-2">
                    {data.gitCandidates.map((c) => (
                      <GitCandidateRow
                        key={c.path}
                        candidate={c}
                        onImport={onImportGit}
                      />
                    ))}
                  </ul>
                )}
              </section>

              <section>
                <div className="mb-2 flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-gray-200">
                    Docker apps{" "}
                    <span className="text-gray-500">
                      ({data.dockerCandidates.length})
                    </span>
                  </h3>
                  {!data.dockerAvailable && (
                    <span className="text-xs text-gray-500">
                      docker not available on host
                    </span>
                  )}
                </div>
                {data.dockerCandidates.length === 0 ? (
                  <div className="rounded-md border border-gray-800 bg-gray-900/30 px-4 py-3 text-sm text-gray-500">
                    No Docker apps found.
                  </div>
                ) : (
                  <ul className="space-y-2">
                    {data.dockerCandidates.map((c) => (
                      <DockerCandidateRow
                        key={`${c.kind}:${c.path ?? c.name}`}
                        candidate={c}
                        dockerAvailable={data.dockerAvailable}
                        onImport={onImportDocker}
                      />
                    ))}
                  </ul>
                )}
              </section>
            </>
          )}
        </div>

        <div className="flex items-center justify-between px-6 py-4 border-t border-gray-800 text-xs text-gray-500">
          <span>
            {data && !isPending
              ? `Scanned in ${(data.durationMs / 1000).toFixed(1)}s`
              : ""}
          </span>
          <div className="flex gap-2">
            {data && !isPending && (
              <button
                type="button"
                onClick={() => {
                  reset();
                  mutate();
                }}
                className="rounded-md border border-gray-600 px-3 py-1.5 text-sm text-gray-200 hover:bg-gray-800"
              >
                Re-scan
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              disabled={isPending}
              className="rounded-md bg-gray-700 px-3 py-1.5 text-sm text-gray-100 hover:bg-gray-600 disabled:cursor-not-allowed disabled:bg-gray-800 disabled:text-gray-600"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
