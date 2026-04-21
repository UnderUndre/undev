import { describe, it, expect, vi } from "vitest";
import { jobManager } from "../../server/services/job-manager.js";

// Mock SSH pool — jobManager transitively imports ssh-pool via script-runner.
vi.mock("../../server/services/ssh-pool.js", () => ({
  sshPool: {
    connect: vi.fn().mockResolvedValue(undefined),
    exec: vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 }),
    execStream: vi.fn().mockResolvedValue({
      stream: {
        on: vi.fn(),
        stderr: { on: vi.fn() },
      },
      kill: vi.fn(),
    }),
    isConnected: vi.fn().mockReturnValue(true),
    disconnect: vi.fn(),
  },
}));

describe("Job Manager", () => {
  it("creates a job with running status", () => {
    const job = jobManager.createJob("deploy", "server-1", { test: true });

    expect(job.id).toBeDefined();
    expect(job.status).toBe("running");
    expect(job.serverId).toBe("server-1");
    expect(job.type).toBe("deploy");
  });

  it("appends logs to a job", () => {
    const job = jobManager.createJob("deploy", "server-1", {});
    jobManager.appendLog(job.id, "Building...");
    jobManager.appendLog(job.id, "Done.");

    const updated = jobManager.getJob(job.id);
    expect(updated?.logs).toEqual(["Building...", "Done."]);
  });

  it("completes a job with success status", () => {
    const job = jobManager.createJob("deploy", "server-1", {});
    jobManager.completeJob(job.id);

    const updated = jobManager.getJob(job.id);
    expect(updated?.status).toBe("success");
    expect(updated?.finishedAt).toBeDefined();
  });

  it("fails a job with error message", () => {
    const job = jobManager.createJob("deploy", "server-1", {});
    jobManager.failJob(job.id, "SSH connection lost");

    const updated = jobManager.getJob(job.id);
    expect(updated?.status).toBe("failed");
    expect(updated?.errorMessage).toBe("SSH connection lost");
  });

  it("cancels a running job", () => {
    const job = jobManager.createJob("deploy", "server-1", {});
    jobManager.cancelJob(job.id);

    const updated = jobManager.getJob(job.id);
    expect(updated?.status).toBe("cancelled");
  });

  it("does not fail an already-failed job", () => {
    const job = jobManager.createJob("deploy", "server-1", {});
    jobManager.failJob(job.id, "first error");
    jobManager.failJob(job.id, "second error");

    const updated = jobManager.getJob(job.id);
    expect(updated?.errorMessage).toBe("first error");
  });

  it("emits events to subscribers", () => {
    const job = jobManager.createJob("deploy", "server-1", {});
    const events: unknown[] = [];

    jobManager.onJobEvent(job.id, (_id, event) => {
      events.push(event);
    });

    jobManager.appendLog(job.id, "test log");
    jobManager.completeJob(job.id);

    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(events.some((e: any) => e.type === "log")).toBe(true);
    expect(events.some((e: any) => e.type === "status")).toBe(true);
  });
});

// Deploy Lock coverage moved to tests/integration/deploy-lock.test.ts
// (Postgres-backed lock per specs/004-db-deploy-lock — SSH-based lock removed).
