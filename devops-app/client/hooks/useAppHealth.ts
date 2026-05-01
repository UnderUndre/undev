import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api.js";
import { useChannel } from "./useWebSocket.js";

// Feature 006 — per-app health hook.
// Combines react-query initial fetch from GET /api/applications/:id/health
// with WS subscription to `app-health:<appId>` (invalidates query cache on
// each event so the dot/tooltip/sparkline re-render live without polling).

export type HealthStatus = "healthy" | "unhealthy" | "unknown";
export type ProbeOutcome = "healthy" | "unhealthy" | "error";
export type ProbeType = "container" | "http" | "cert_expiry" | "caddy_admin";

export interface HealthProbe {
  id: string;
  probedAt: string;
  probeType: ProbeType;
  outcome: ProbeOutcome;
  latencyMs: number | null;
  statusCode: number | null;
  errorMessage: string | null;
  containerStatus: string | null;
}

export interface HealthConfig {
  healthUrl: string | null;
  intervalSec: number;
  debounceCount: number;
  monitoringEnabled: boolean;
  alertsMuted: boolean;
}

export interface AppHealth {
  appId: string;
  status: HealthStatus;
  checkedAt: string | null;
  lastChangeAt: string | null;
  message: string | null;
  config: HealthConfig;
  probes: HealthProbe[];
}

export interface UseAppHealthResult {
  health: AppHealth | undefined;
  isLoading: boolean;
  error: Error | null;
}

export function useAppHealth(appId: string | null | undefined): UseAppHealthResult {
  const queryClient = useQueryClient();
  const enabled = Boolean(appId);

  const { data, isLoading, error } = useQuery({
    queryKey: ["app", appId, "health"],
    queryFn: () => api.get<AppHealth>(`/applications/${appId}/health`),
    enabled,
  });

  const { lastMessage } = useChannel(enabled && appId ? `app-health:${appId}` : null);

  useEffect(() => {
    if (!lastMessage || !appId) return;
    // Both probe-completed and health-changed → invalidate so the next read
    // pulls a fresh snapshot (probes list is server-side ordered + capped).
    if (lastMessage.type === "probe-completed" || lastMessage.type === "health-changed") {
      queryClient.invalidateQueries({ queryKey: ["app", appId, "health"] });
      queryClient.invalidateQueries({ queryKey: ["app", appId, "health", "history"] });
    }
  }, [lastMessage, queryClient, appId]);

  return {
    health: data,
    isLoading,
    error: error instanceof Error ? error : null,
  };
}
