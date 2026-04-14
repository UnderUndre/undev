import { describe, it, expect, vi, beforeEach } from "vitest";
import { jobManager } from "../../server/services/job-manager.js";
import { deployLock } from "../../server/services/deploy-lock.js";

// Mock SSH pool
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

describe("Deploy Lock", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("acquires lock via SSH mkdir", async () => {
    const { sshPool } = await import("../../server/services/ssh-pool.js");
    (sshPool.exec as any).mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 });

    const result = await deployLock.acquireLock("server-1", "app-1");
    expect(result).toBe(true);
    expect(sshPool.exec).toHaveBeenCalledWith(
      "server-1",
      expect.stringContaining("mkdir /tmp/deploy.lock"),
    );
  });

  it("returns false when lock already exists", async () => {
    const { sshPool } = await import("../../server/services/ssh-pool.js");
    (sshPool.exec as any).mockResolvedValueOnce({ stdout: "", stderr: "mkdir: cannot create", exitCode: 1 });

    const result = await deployLock.acquireLock("server-1", "app-1");
    expect(result).toBe(false);
  });

  it("releases lock via SSH rm -rf", async () => {
    const { sshPool } = await import("../../server/services/ssh-pool.js");
    await deployLock.releaseLock("server-1");

    expect(sshPool.exec).toHaveBeenCalledWith(
      "server-1",
      expect.stringContaining("rm -rf /tmp/deploy.lock"),
    );
  });
});
