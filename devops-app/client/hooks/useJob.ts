import { useState, useEffect, useCallback } from "react";
import { useChannel } from "./useWebSocket.js";
import type { WsMessage } from "../lib/ws.js";

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

  const channel = jobId ? `job:${jobId}` : null;
  const { lastMessage } = useChannel(channel);

  useEffect(() => {
    if (!lastMessage) return;

    setState((prev) => {
      switch (lastMessage.type) {
        case "log": {
          const data = lastMessage.data as { message: string };
          return { ...prev, logs: [...prev.logs, data.message] };
        }
        case "progress": {
          const data = lastMessage.data as JobProgress;
          return { ...prev, progress: [...prev.progress, data] };
        }
        case "result": {
          return { ...prev, result: lastMessage.data };
        }
        case "error": {
          const data = lastMessage.data as { message: string };
          return { ...prev, error: data.message };
        }
        case "status": {
          const data = lastMessage.data as { status: string };
          return { ...prev, status: data.status as JobState["status"] };
        }
        default:
          return prev;
      }
    });
  }, [lastMessage]);

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
