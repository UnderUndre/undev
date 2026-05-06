/**
 * Feature 012 T022 — useDeployStrategy.
 *
 * Reads deploy-strategy fields off an application row and exposes a
 * mutation helper that PATCHes the BG fields. Maps server validation
 * errors to typed result variants for inline UI.
 */

import { useCallback, useState } from "react";

export type DeployStrategy = "recreate" | "blue_green";

export interface DeployStrategyState {
  strategy: DeployStrategy;
  drainSeconds: number;
  greenHealthcheckTimeoutSeconds: number;
  activeColor: "blue" | "green" | null;
  isLoading: boolean;
  error: string | null;
}

export type SaveResult =
  | { ok: true }
  | {
      ok: false;
      code:
        | "blue_green_requires_caddy"
        | "blue_green_replicas_not_supported_v1"
        | "blue_green_incompatible_compose"
        | "volume_sharing_unacknowledged"
        | "VALIDATION_ERROR"
        | "NETWORK_ERROR";
      message: string;
      detail?: unknown;
    };

export interface UseDeployStrategyResult extends DeployStrategyState {
  save: (
    appId: string,
    patch: {
      deployStrategy?: DeployStrategy;
      drainSeconds?: number;
      greenHealthcheckTimeoutSeconds?: number;
      acknowledgeVolumeSharing?: boolean;
    },
  ) => Promise<SaveResult>;
}

export function useDeployStrategy(initial: {
  strategy: DeployStrategy;
  drainSeconds: number;
  greenHealthcheckTimeoutSeconds: number;
  activeColor: "blue" | "green" | null;
}): UseDeployStrategyResult {
  const [state] = useState<DeployStrategyState>({
    ...initial,
    isLoading: false,
    error: null,
  });

  const save = useCallback(
    async (
      appId: string,
      patch: Parameters<UseDeployStrategyResult["save"]>[1],
    ): Promise<SaveResult> => {
      try {
        const res = await fetch(`/api/apps/${encodeURIComponent(appId)}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          credentials: "include",
          body: JSON.stringify(patch),
        });
        if (res.ok) return { ok: true };
        const body = (await res.json().catch(() => ({}))) as {
          error?: { code?: string; message?: string; details?: unknown };
        };
        const code = body.error?.code ?? "VALIDATION_ERROR";
        return {
          ok: false,
          code: code as SaveResult extends { ok: false; code: infer C } ? C : never,
          message: body.error?.message ?? "Validation failed",
          detail: body.error?.details,
        };
      } catch (err) {
        return {
          ok: false,
          code: "NETWORK_ERROR",
          message: err instanceof Error ? err.message : String(err),
        };
      }
    },
    [],
  );

  return { ...state, save };
}
