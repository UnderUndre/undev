/**
 * Feature 012 T050 — useInterruptedDeploys.
 *
 * Fetches GET /api/applications/interrupted-deploys on mount + on demand.
 */

import { useCallback, useEffect, useState } from "react";

export interface InterruptedDeployRow {
  appId: string;
  appName: string;
  serverId: string;
  serverLabel: string;
  lastPhase: string;
  lastPhaseStartedAt: string;
  activeColor: "blue" | "green" | null;
  candidate: {
    name: string;
    state: "running" | "exited" | "missing" | "unhealthy";
    exitCode?: number;
  };
  outgoing: {
    name: string;
    state: "running" | "exited" | "missing";
  };
}

export interface UseInterruptedDeploysResult {
  rows: InterruptedDeployRow[];
  isLoading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
}

export function useInterruptedDeploys(): UseInterruptedDeploysResult {
  const [rows, setRows] = useState<InterruptedDeployRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    setIsLoading(true);
    try {
      const res = await fetch("/api/applications/interrupted-deploys", {
        credentials: "include",
      });
      if (!res.ok) {
        setError(`HTTP ${res.status}`);
        return;
      }
      const body = (await res.json()) as { rows: InterruptedDeployRow[] };
      setRows(body.rows ?? []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  return { rows, isLoading, error, refetch };
}
