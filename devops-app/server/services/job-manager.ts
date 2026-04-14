import { randomUUID } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import path from "node:path";

export type JobStatus = "pending" | "running" | "success" | "failed" | "cancelled";

export interface Job {
  id: string;
  type: string;
  serverId: string;
  status: JobStatus;
  metadata: Record<string, unknown>;
  logs: string[];
  createdAt: string;
  finishedAt?: string;
  errorMessage?: string;
}

export interface JobEvent {
  type: "log" | "progress" | "result" | "error" | "status";
  data: unknown;
}

export type JobEventCallback = (jobId: string, event: JobEvent) => void;

const LOG_DIR = process.env.LOG_DIR ?? "/app/data/logs";

class JobManager {
  private jobs = new Map<string, Job>();
  private logStreams = new Map<string, WriteStream>();
  private subscribers = new Map<string, Set<JobEventCallback>>();

  createJob(
    type: string,
    serverId: string,
    metadata: Record<string, unknown> = {},
  ): Job {
    const id = randomUUID();
    const job: Job = {
      id,
      type,
      serverId,
      status: "running",
      metadata,
      logs: [],
      createdAt: new Date().toISOString(),
    };

    this.jobs.set(id, job);

    // Create log file stream
    const logPath = path.join(LOG_DIR, `${id}.log`);
    try {
      const stream = createWriteStream(logPath, { flags: "a" });
      this.logStreams.set(id, stream);
      job.metadata.logFilePath = logPath;
    } catch {
      // Log dir may not exist in dev — fall back to memory-only
      console.warn(`[job-manager] Could not create log file at ${logPath}`);
    }

    this.emitEvent(id, { type: "status", data: { status: "running" } });
    return job;
  }

  getJob(jobId: string): Job | undefined {
    return this.jobs.get(jobId);
  }

  appendLog(jobId: string, line: string): void {
    const job = this.jobs.get(jobId);
    if (!job) return;

    job.logs.push(line);

    // Write to disk
    const stream = this.logStreams.get(jobId);
    if (stream) {
      stream.write(line + "\n");
    }

    // Broadcast to subscribers
    this.emitEvent(jobId, { type: "log", data: { message: line } });
  }

  completeJob(jobId: string): void {
    const job = this.jobs.get(jobId);
    if (!job) return;

    job.status = "success";
    job.finishedAt = new Date().toISOString();

    this.emitEvent(jobId, { type: "status", data: { status: "success" } });
    this.cleanup(jobId);
  }

  failJob(jobId: string, errorMessage: string): void {
    const job = this.jobs.get(jobId);
    if (!job) return;
    if (job.status !== "running") return; // Already terminal

    job.status = "failed";
    job.errorMessage = errorMessage;
    job.finishedAt = new Date().toISOString();

    this.emitEvent(jobId, {
      type: "error",
      data: { message: errorMessage },
    });
    this.emitEvent(jobId, { type: "status", data: { status: "failed" } });
    this.cleanup(jobId);
  }

  cancelJob(jobId: string): void {
    const job = this.jobs.get(jobId);
    if (!job || job.status !== "running") return;

    job.status = "cancelled";
    job.finishedAt = new Date().toISOString();

    this.emitEvent(jobId, { type: "status", data: { status: "cancelled" } });
    this.cleanup(jobId);
  }

  emitEvent(jobId: string, event: JobEvent): void {
    const subs = this.subscribers.get(jobId);
    if (!subs) return;
    for (const cb of subs) {
      try {
        cb(jobId, event);
      } catch (err) {
        console.error(`[job-manager] Subscriber error for job ${jobId}:`, err);
      }
    }
  }

  onJobEvent(jobId: string, callback: JobEventCallback): () => void {
    if (!this.subscribers.has(jobId)) {
      this.subscribers.set(jobId, new Set());
    }
    this.subscribers.get(jobId)!.add(callback);

    return () => {
      this.subscribers.get(jobId)?.delete(callback);
    };
  }

  private cleanup(jobId: string): void {
    const stream = this.logStreams.get(jobId);
    if (stream) {
      stream.end();
      this.logStreams.delete(jobId);
    }
    // Keep subscribers alive for a bit so late messages get delivered
    setTimeout(() => {
      this.subscribers.delete(jobId);
    }, 30_000);
  }
}

export const jobManager = new JobManager();
