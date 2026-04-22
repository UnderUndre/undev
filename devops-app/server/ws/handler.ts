import type { WebSocket, WebSocketServer } from "ws";
import type { IncomingMessage } from "node:http";
import { channelManager } from "./channels.js";
import { jobManager } from "../services/job-manager.js";
import { db } from "../db/index.js";
import { sessions } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { parse as parseCookie } from "cookie";

interface ClientMessage {
  action: "subscribe" | "unsubscribe" | "cancel";
  channel?: string;
  jobId?: string;
}

export function setupWebSocket(wss: WebSocketServer): void {
  wss.on("connection", async (ws: WebSocket, req: IncomingMessage) => {
    // Auth: validate session cookie
    const userId = await authenticateWs(req);
    if (!userId) {
      ws.close(4001, "Unauthorized");
      return;
    }

    // Send connected confirmation
    ws.send(
      JSON.stringify({
        type: "connected",
        data: { userId },
        timestamp: new Date().toISOString(),
      }),
    );

    ws.on("message", (raw) => {
      try {
        const msg: ClientMessage = JSON.parse(raw.toString());
        handleMessage(ws, msg);
      } catch {
        ws.send(JSON.stringify({ type: "error", data: { message: "Invalid message format" } }));
      }
    });

    ws.on("close", () => {
      channelManager.unsubscribeAll(ws);
    });

    ws.on("error", () => {
      channelManager.unsubscribeAll(ws);
    });
  });
}

function handleMessage(ws: WebSocket, msg: ClientMessage): void {
  switch (msg.action) {
    case "subscribe":
      if (msg.channel) {
        channelManager.subscribe(ws, msg.channel);

        // If subscribing to a job channel, wire up job events AND replay any
        // logs/status already captured. Otherwise early lines produced by the
        // SSH stream (server-deploy.sh echoes, etc.) that arrived before the
        // client had a chance to subscribe would be silently dropped — UI
        // would just sit on "Waiting for output...".
        if (msg.channel.startsWith("job:")) {
          const jobId = msg.channel.slice(4);
          wireJobToChannel(jobId);
          replayJobBacklog(ws, jobId);
        }
      }
      break;

    case "unsubscribe":
      if (msg.channel) {
        channelManager.unsubscribe(ws, msg.channel);
      }
      break;

    case "cancel":
      if (msg.jobId) {
        jobManager.cancelJob(msg.jobId);
      }
      break;
  }
}

// Replay any logs + current status already captured for this job. Called the
// moment a client subscribes to `job:<id>` so it sees the work-in-progress
// even if it arrived late.
function replayJobBacklog(ws: WebSocket, jobId: string): void {
  const job = jobManager.getJob(jobId);
  if (!job) return;
  const channel = `job:${jobId}`;
  const send = (type: string, data: unknown) => {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(
      JSON.stringify({
        channel,
        type,
        data,
        timestamp: new Date().toISOString(),
      }),
    );
  };
  for (const line of job.logs) {
    send("log", { message: line });
  }
  send("status", { status: job.status });
  if (job.errorMessage) {
    send("error", { message: job.errorMessage });
  }
}

// Wire job events to the channel system so all subscribers get updates
const wiredJobs = new Set<string>();
function wireJobToChannel(jobId: string): void {
  if (wiredJobs.has(jobId)) return;
  wiredJobs.add(jobId);

  const channel = `job:${jobId}`;
  jobManager.onJobEvent(jobId, (_id, event) => {
    channelManager.broadcast(channel, { type: event.type, data: event.data });

    // Cleanup wiring on terminal status
    if (
      event.type === "status" &&
      (event.data as { status: string }).status !== "running"
    ) {
      setTimeout(() => wiredJobs.delete(jobId), 30_000);
    }
  });
}

async function authenticateWs(
  req: IncomingMessage,
): Promise<string | null> {
  try {
    const cookieHeader = req.headers.cookie;
    if (!cookieHeader) return null;

    const cookies = parseCookie(cookieHeader);
    const sessionId = cookies.session;
    if (!sessionId) return null;

    const [session] = await db
      .select()
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);

    if (!session) return null;
    if (new Date(session.expiresAt) < new Date()) return null;

    return session.userId;
  } catch {
    return null;
  }
}
