/**
 * Feature 012 T038 — useBlueGreenDeployState.
 *
 * Subscribes to `blue_green:<appId>` WS channel for `blue_green.state-changed`
 * events. Falls back to 2s REST poll on WS disconnect by re-fetching the
 * application row.
 */

import { useEffect, useRef, useState } from "react";
import { wsClient, type WsMessage } from "../lib/ws.js";

export interface BlueGreenDeployState {
  phase: string | null;
  drainRemainingMs: number | null;
  candidateColor: "blue" | "green" | null;
  error: string | null;
}

const POLL_INTERVAL_MS = 2_000;

export function useBlueGreenDeployState(
  appId: string | null,
): BlueGreenDeployState {
  const [state, setState] = useState<BlueGreenDeployState>({
    phase: null,
    drainRemainingMs: null,
    candidateColor: null,
    error: null,
  });
  const lastAppliedRef = useRef<string>("");

  useEffect(() => {
    if (!appId) return;
    let cancelled = false;
    async function refresh() {
      if (!appId) return;
      try {
        const res = await fetch(`/api/apps/${encodeURIComponent(appId)}`, {
          credentials: "include",
        });
        if (!res.ok) return;
        const row = (await res.json()) as {
          deployState: string | null;
          activeColor: "blue" | "green" | null;
        };
        if (cancelled) return;
        setState((prev) => ({
          ...prev,
          phase: row.deployState,
          // Candidate is the opposite of active during a deploy.
          candidateColor:
            row.activeColor === "blue"
              ? "green"
              : row.activeColor === "green"
                ? "blue"
                : null,
          error: null,
        }));
      } catch (err) {
        if (!cancelled) {
          setState((prev) => ({
            ...prev,
            error: err instanceof Error ? err.message : String(err),
          }));
        }
      }
    }
    void refresh();
    const t = setInterval(() => void refresh(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [appId]);

  useEffect(() => {
    if (!appId) return;
    const channel = `blue_green:${appId}`;
    const unsub = wsClient.subscribe(channel, (msg: WsMessage) => {
      const payload = (msg.data ?? msg) as Record<string, unknown>;
      const msgType =
        msg.type ?? (payload.type as string | undefined);
      if (msgType !== "blue_green.state-changed") return;
      const occurredAt = payload.occurredAt as string | undefined;
      if (occurredAt && occurredAt <= lastAppliedRef.current) return;
      if (occurredAt) lastAppliedRef.current = occurredAt;
      const meta = (payload.metadata as Record<string, unknown>) ?? {};
      setState((prev) => ({
        ...prev,
        phase: (payload.toState as string | null) ?? prev.phase,
        drainRemainingMs:
          typeof meta.drainRemainingMs === "number"
            ? meta.drainRemainingMs
            : prev.drainRemainingMs,
        candidateColor:
          (meta.candidateColor as "blue" | "green" | undefined) ??
          prev.candidateColor,
      }));
    });
    return unsub;
  }, [appId]);

  return state;
}
