/**
 * Feature 006 T035 — wait-for-healthy deploy gate integration.
 *
 * Asserts:
 *  (a) waitForHealthy: true + container healthy → status='success', tail appended
 *  (b) container reports unhealthy (exit 1 + log line) → status='failed'
 *      with FR-027 message
 *  (c) timeout (exit 124) → status='timeout' with FR-026 message
 *  (d) container has no healthcheck (silent skip exit 0) → status='success'
 *  (e) waitForHealthy: false / omitted → no tail appended (regression guard)
 *  (f) regression — existing deploy/server-deploy invocation still works
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import path from "node:path";

// ── Mocks ──────────────────────────────────────────────────────────────────
const captured: { buffer: string; command: string }[] = [];

interface FakeStream {
  on: (evt: string, cb: (...a: unknown[]) => void) => void;
  stderr: { on: (evt: string, cb: (...a: unknown[]) => void) => void };
  write: (b: unknown) => void;
  end: () => void;
  _fire: (evt: string, ...args: unknown[]) => void;
}
let lastStream: FakeStream | null = null;

function mkStream(): FakeStream {
  const handlers: Record<string, (...a: unknown[]) => void> = {};
  const stderrHandlers: Record<string, (...a: unknown[]) => void> = {};
  return {
    on: (evt, cb) => {
      handlers[evt] = cb;
    },
    stderr: {
      on: (evt, cb) => {
        stderrHandlers[evt] = cb;
      },
    },
    write: (b) => {
      captured[captured.length - 1].buffer = String(b);
    },
    end: () => undefined,
    _fire: (evt, ...args) => handlers[evt]?.(...args),
  };
}

vi.mock("../../server/services/ssh-pool.js", () => ({
  sshPool: {
    isConnected: vi.fn().mockReturnValue(true),
    connect: vi.fn().mockResolvedValue(undefined),
    execStream: vi.fn((_serverId: string, command: string) => {
      const s = mkStream();
      lastStream = s;
      captured.push({ buffer: "", command });
      return Promise.resolve({ stream: s, kill: vi.fn() });
    }),
  },
}));

const updates: Record<string, unknown>[] = [];
vi.mock("../../server/db/index.js", () => ({
  db: {
    insert: vi.fn(() => ({ values: vi.fn(() => Promise.resolve()) })),
    update: vi.fn(() => ({
      set: vi.fn((v: Record<string, unknown>) => ({
        where: vi.fn(() => {
          updates.push(v);
          return Promise.resolve();
        }),
      })),
    })),
    execute: vi.fn().mockResolvedValue([]),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({ limit: vi.fn().mockResolvedValue([]) })),
      })),
    })),
  },
  client: { reserve: vi.fn() },
}));

vi.mock("../../server/services/deploy-lock.js", () => ({
  deployLock: {
    acquireLock: vi.fn().mockResolvedValue(true),
    releaseLock: vi.fn().mockResolvedValue(undefined),
    checkLock: vi.fn().mockResolvedValue(null),
  },
}));

// Spy on buildHealthCheckTail to assert call/no-call per case (e).
const tailSpy = vi.fn();
vi.mock("../../server/services/build-health-check-tail.js", async (orig) => {
  const real = (await (orig as () => Promise<{ buildHealthCheckTail: (i: { container: string; timeoutMs: number }) => string }>)());
  return {
    buildHealthCheckTail: (input: { container: string; timeoutMs: number }) => {
      tailSpy(input);
      return real.buildHealthCheckTail(input);
    },
  };
});

describe("deploy wait-for-healthy gate (feature 006 T035)", () => {
  beforeEach(() => {
    captured.length = 0;
    updates.length = 0;
    tailSpy.mockClear();
    lastStream = null;
    vi.resetModules();
    process.env.SCRIPTS_ROOT = path.resolve(__dirname, "../../../scripts");
    process.env.LOG_DIR = path.resolve(__dirname, "../../node_modules/.tmp-logs");
  });

  async function dispatch(): Promise<{ runId: string; jobId: string }> {
    const { scriptsRunner } = await import(
      "../../server/services/scripts-runner.js"
    );
    return scriptsRunner.runScript(
      "deploy/server-deploy",
      "srv-A",
      { appDir: "/srv/myapp", noCache: false, skipCleanup: false },
      "admin",
    );
  }

  async function flush(): Promise<void> {
    for (let i = 0; i < 5; i += 1) {
      await new Promise((r) => setImmediate(r));
    }
  }

  it("(a) container healthy (exit 0) → success + tail appended", async () => {
    const { runId } = await dispatch();
    expect(runId).toBeTruthy();
    await flush();
    expect(tailSpy).toHaveBeenCalledTimes(1);
    expect(tailSpy.mock.calls[0][0].timeoutMs).toBe(180_000);
    expect(captured[0].buffer).toMatch(/wait-for-healthy gate/);

    // Simulate container healthy: stream closes with exit 0.
    lastStream?._fire("close", 0);
    await flush();
    const finalUpdate = updates.find((u) => u.status === "success");
    expect(finalUpdate).toBeDefined();
  });

  it("(b) container reports unhealthy (exit 1 + log) → failed with FR-027 msg", async () => {
    const { jobId } = await dispatch();
    await flush();
    const { jobManager } = await import(
      "../../server/services/job-manager.js"
    );
    jobManager.appendLog(jobId, "[wait-for-healthy] healthcheck reported unhealthy");
    lastStream?._fire("close", 1);
    await flush();
    const failed = updates.find((u) => u.status === "failed");
    expect(failed).toBeDefined();
    expect(failed?.errorMessage).toBe(
      "healthcheck reported unhealthy during startup",
    );
  });

  it("(c) timeout (exit 124) → status='timeout' (FR-026)", async () => {
    const { jobId } = await dispatch();
    await flush();
    const { jobManager } = await import(
      "../../server/services/job-manager.js"
    );
    jobManager.appendLog(jobId, "[wait-for-healthy] timeout waiting for healthy");
    lastStream?._fire("close", 124);
    await flush();
    const timeout = updates.find((u) => u.status === "timeout");
    expect(timeout).toBeDefined();
    expect(String(timeout?.errorMessage)).toMatch(
      /healthcheck did not turn healthy within 180000ms/,
    );
  });

  it("(d) container has no healthcheck (silent skip exit 0) → success", async () => {
    await dispatch();
    await flush();
    lastStream?._fire("close", 0);
    await flush();
    const success = updates.find((u) => u.status === "success");
    expect(success).toBeDefined();
  });

  it("(e) entry without waitForHealthy → no tail appended", async () => {
    // Patch manifest to remove waitForHealthy on the deploy entry.
    vi.doMock("../../server/scripts-manifest.js", async (orig) => {
      const m = (await (orig as () => Promise<Record<string, unknown>>)()) as {
        manifest: Array<Record<string, unknown>>;
        CATEGORY_FOLDER_MAP: Record<string, string>;
      };
      const patched = m.manifest.map((entry) =>
        entry.id === "deploy/server-deploy"
          ? { ...entry, waitForHealthy: false }
          : entry,
      );
      return { ...m, manifest: patched };
    });
    const { scriptsRunner } = await import(
      "../../server/services/scripts-runner.js"
    );
    await scriptsRunner.runScript(
      "deploy/server-deploy",
      "srv-A",
      { appDir: "/srv/myapp", noCache: false, skipCleanup: false },
      "admin",
    );
    await flush();
    expect(tailSpy).not.toHaveBeenCalled();
    expect(captured[0].buffer).not.toMatch(/wait-for-healthy gate/);
    vi.doUnmock("../../server/scripts-manifest.js");
  });

  it("(f) regression — feature 005 dispatch unchanged for non-deploy entries", async () => {
    const { scriptsRunner } = await import(
      "../../server/services/scripts-runner.js"
    );
    await scriptsRunner.runScript(
      "db/backup",
      "srv-A",
      { databaseName: "mydb", retentionDays: 30 },
      "admin",
    );
    await flush();
    expect(tailSpy).not.toHaveBeenCalled();
  });
});
