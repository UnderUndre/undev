/** Feature 010 T065 — typed FailureCallbacks for the wiring helper. */
import { useMemo } from "react";
import { api } from "../lib/api.js";
import type { FailureCallbacks } from "../lib/failure-state-wiring.js";

export interface UseFailureCallbacksOptions {
  /** Fired when a deploy retry is requested. Defaults to a POST against the deploy endpoint. */
  onRetryDeploy?: (jobId: string) => void;
  onRetryFromStep?: (appId: string, fromStep: string) => void;
  onForceRenew?: (certId: string) => void;
  onOpenHardDeleteDialog?: (appId: string) => void;
  onOpenForceDeleteDialog?: (appId: string) => void;
}

export function useFailureCallbacks(opts: UseFailureCallbacksOptions = {}): FailureCallbacks {
  return useMemo<FailureCallbacks>(
    () => ({
      retryDeploy: (jobId) => {
        if (opts.onRetryDeploy) {
          opts.onRetryDeploy(jobId);
          return;
        }
        // Best-effort default: re-trigger via the deployments retry endpoint.
        void api.post(`/jobs/${encodeURIComponent(jobId)}/retry`).catch(() => {
          /* surfaced upstream */
        });
      },
      retryFromStep: (appId, fromStep) => {
        if (opts.onRetryFromStep) {
          opts.onRetryFromStep(appId, fromStep);
          return;
        }
        void api
          .post(`/applications/${encodeURIComponent(appId)}/bootstrap/retry?from=${encodeURIComponent(fromStep)}`)
          .catch(() => {
            /* surfaced upstream */
          });
      },
      forceRenew: (certId) => {
        opts.onForceRenew?.(certId);
      },
      openHardDeleteDialog: (appId) => {
        opts.onOpenHardDeleteDialog?.(appId);
      },
      openForceDeleteDialog: (appId) => {
        opts.onOpenForceDeleteDialog?.(appId);
      },
    }),
    [
      opts.onRetryDeploy,
      opts.onRetryFromStep,
      opts.onForceRenew,
      opts.onOpenHardDeleteDialog,
      opts.onOpenForceDeleteDialog,
    ],
  );
}
