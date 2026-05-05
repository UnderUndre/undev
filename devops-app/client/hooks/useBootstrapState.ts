/**
 * Feature 009 T024 — combined REST snapshot + WS subscription for bootstrap
 * state. Returns a single live `state` object that updates as transitions
 * happen. WS events are deduped against `lastAppliedOccurredAt`; reconnect
 * triggers a fresh REST fetch.
 */
import { useEffect, useRef, useState, useCallback } from "react";
import {
  bootstrapApi,
  type BootstrapStateResponse,
  type BootstrapEvent,
} from "../lib/bootstrap-api.js";
import { wsClient, type WsMessage } from "../lib/ws.js";

interface BootstrapLogLine {
  scriptId: string;
  runId: string;
  line: string;
}

export interface UseBootstrapStateResult {
  state: BootstrapStateResponse | null;
  logs: BootstrapLogLine[];
  error: string | null;
  refresh: () => Promise<void>;
}

const POLL_INTERVAL_MS = 2_000;

export function useBootstrapState(appId: string | null): UseBootstrapStateResult {
  const [state, setState] = useState<BootstrapStateResponse | null>(null);
  const [logs, setLogs] = useState<BootstrapLogLine[]>([]);
  const [error, setError] = useState<string | null>(null);
  const lastAppliedRef = useRef<string>("");

  const refresh = useCallback(async () => {
    if (!appId) return;
    try {
      const res = await bootstrapApi.getState(appId);
      setState(res);
      const lastEvent = res.events[res.events.length - 1];
      if (lastEvent && lastEvent.occurredAt > lastAppliedRef.current) {
        lastAppliedRef.current = lastEvent.occurredAt;
      }
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [appId]);

  useEffect(() => {
    if (!appId) return;
    void refresh();
    const t = setInterval(() => {
      // Only poll when state is non-terminal — saves traffic on ACTIVE rows.
      if (state && (state.bootstrapState === "active" || state.bootstrapState.startsWith("failed_"))) {
        return;
      }
      void refresh();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(t);
  }, [appId, refresh, state]);

  useEffect(() => {
    if (!appId) return;
    const unsub = wsClient.subscribe("bootstrap", (msg: WsMessage) => {
      const data = msg.data as Record<string, unknown> | undefined;
      // ws/handler wraps payloads via channelManager.broadcast(channel, message)
      // and clients see the full envelope. The orchestrator broadcasts both
      // `type` and `data` shapes — we tolerate both.
      const payload = (data ?? msg) as Record<string, unknown>;
      const msgType = msg.type ?? (payload.type as string | undefined);
      const msgAppId = (payload.appId as string | undefined) ?? (data?.appId as string | undefined);
      if (msgAppId !== appId) return;
      if (msgType === "bootstrap.state-changed") {
        const occurredAt = payload.occurredAt as string | undefined;
        if (occurredAt && occurredAt <= lastAppliedRef.current) return;
        if (occurredAt) lastAppliedRef.current = occurredAt;
        // Trigger refetch — REST is canonical, WS is just an accelerant.
        void refresh();
      } else if (msgType === "bootstrap.step-log") {
        setLogs((prev) => {
          const next: BootstrapLogLine = {
            scriptId: (payload.scriptId as string) ?? "",
            runId: (payload.runId as string) ?? "",
            line: (payload.line as string) ?? "",
          };
          // Cap to last 500 lines to bound memory.
          const out = prev.length >= 500 ? prev.slice(-499) : prev;
          return [...out, next];
        });
      }
    });
    return unsub;
  }, [appId, refresh]);

  return { state, logs, error, refresh };
}

export type { BootstrapEvent };
