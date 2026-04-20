import { useMutation } from "@tanstack/react-query";
import { useRef } from "react";
import { ApiError } from "../lib/api.js";

export type DirtyState = "clean" | "dirty" | "unknown";

export interface GitCandidate {
  path: string;
  remoteUrl: string | null;
  githubRepo: string | null;
  branch: string;
  detached: boolean;
  commitSha: string | null;
  commitSubject: string | null;
  commitDate: string | null;
  dirty: DirtyState;
  suggestedDeployScripts: string[];
  alreadyImported: boolean;
  existingApplicationId: string | null;
}

export interface DockerCandidate {
  kind: "compose" | "container";
  path: string | null;
  extraComposeFiles: string[];
  name: string;
  services: Array<{ name: string; image: string; running: boolean }>;
  alreadyImported: boolean;
  existingApplicationId: string | null;
}

export interface ScanResult {
  gitCandidates: GitCandidate[];
  dockerCandidates: DockerCandidate[];
  gitAvailable: boolean;
  dockerAvailable: boolean;
  partial: boolean;
  durationMs: number;
}

export interface ScanInProgressDetails {
  since: string;
  byUserId: string;
}

/**
 * Scan a server for existing repositories and Docker apps.
 *
 * Uses a local AbortController so the modal's Cancel button can tear down
 * the in-flight fetch; the server-side route listens for `req.on("close")`
 * and kills the SSH pipeline (see scanner.ts).
 */
export function useScan(serverId: string) {
  const controllerRef = useRef<AbortController | null>(null);

  const mutation = useMutation<ScanResult, ApiError, void>({
    mutationFn: async () => {
      // Cancel any prior in-flight request before starting a new one.
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;

      const res = await fetch(`/api/servers/${serverId}/scan`, {
        method: "POST",
        credentials: "same-origin",
        signal: controller.signal,
      });

      if (res.status === 204) {
        throw new ApiError(204, "EMPTY", "No content");
      }

      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        const err = body.error ?? {};
        throw new ApiError(
          res.status,
          err.code ?? "UNKNOWN",
          err.message ?? "Scan failed",
          // FR-074: 409 body carries `since` + `byUserId`.
          err.since || err.byUserId
            ? { since: err.since, byUserId: err.byUserId }
            : err.details,
        );
      }
      return body as ScanResult;
    },
  });

  return {
    ...mutation,
    abort: () => controllerRef.current?.abort(),
  };
}
