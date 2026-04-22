import { useState, useEffect } from "react";
import { wsClient, type WsMessage } from "../lib/ws.js";

export interface JobProgress {
  step: string;
  status: string;
}

export interface JobState {
  jobId: string | null;
  status: "idle" | "running" | "success" | "failed" | "cancelled";
  logs: string[];
  progress: JobProgress[];
  error: string | null;
  result: unknown;
}

export function useJob(jobId: string | null) {
  const [state, setState] = useState<JobState>({
    jobId,
    status: jobId ? "running" : "idle",
    logs: [],
    progress: [],
    error: null,
    result: null,
  });

  // Subscribe directly to the WS channel and reduce each message into state.
  // Previously we routed through useChannel's { lastMessage } — which drops
  // intermediate messages when React batches multiple ws pushes in the same
  // tick, so ~948 build-output lines showed as ~6 in the UI. Applying each
  // message inside the subscribe callback means every message hits the
  // reducer individually regardless of batching.
  useEffect(() => {
    if (!jobId) return;

    const channel = `job:${jobId}`;
    const reduce = (msg: WsMessage) => {
      setState((prev) => {
        switch (msg.type) {
          case "log": {
            const data = msg.data as { message: string };
            return { ...prev, logs: [...prev.logs, data.message] };
          }
          case "progress": {
            const data = msg.data as JobProgress;
            return { ...prev, progress: [...prev.progress, data] };
          }
          case "result":
            return { ...prev, result: msg.data };
          case "error": {
            const data = msg.data as { message: string };
            return { ...prev, error: data.message };
          }
          case "status": {
            const data = msg.data as { status: string };
            return { ...prev, status: data.status as JobState["status"] };
          }
          default:
            return prev;
        }
      });
    };

    return wsClient.subscribe(channel, reduce);
  }, [jobId]);

  // Reset when jobId changes
  useEffect(() => {
    setState({
      jobId,
      status: jobId ? "running" : "idle",
      logs: [],
      progress: [],
      error: null,
      result: null,
    });
  }, [jobId]);

  return state;
}
