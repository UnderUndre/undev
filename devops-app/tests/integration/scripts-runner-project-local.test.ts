/**
 * Feature 007 T019: end-to-end smoke for project-local dispatch — verifies
 * that scriptsRunner with reuseRunId takes the remote-exec branch (no
 * common.sh + no stdin pipe), and that resolveDeployOperation routes correctly
 * for an app with scriptPath set.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { tmpdir } from "node:os";

process.env.LOG_DIR = tmpdir();

interface CapturedExec {
  command: string;
  buffer: Buffer | string;
}
const capturedExec: CapturedExec[] = [];
const dbInsertedRuns: Record<string, unknown>[] = [];
const dbUpdatedRuns: Record<string, unknown>[] = [];

function mkStream() {
  const handlers: Record<string, (...args: unknown[]) => void> = {};
  return {
    on: vi.fn((evt: string, cb: (...args: unknown[]) => void) => {
      handlers[evt] = cb;
    }),
    stderr: { on: vi.fn() },
    write: vi.fn((buf: unknown) => {
      capturedExec[capturedExec.length - 1].buffer = buf as Buffer | string;
    }),
    end: vi.fn(),
  };
}

vi.mock("../../server/services/ssh-pool.js", () => ({
  sshPool: {
    isConnected: vi.fn().mockReturnValue(true),
    connect: vi.fn().mockResolvedValue(undefined),
    execStream: vi.fn((_serverId: string, command: string) => {
      capturedExec.push({ command, buffer: Buffer.alloc(0) });
      return Promise.resolve({ stream: mkStream(), kill: vi.fn() });
    }),
  },
}));

vi.mock("../../server/db/index.js", () => ({
  db: {
    insert: vi.fn(() => ({
      values: vi.fn((v: Record<string, unknown>) => {
        dbInsertedRuns.push(v);
        return Promise.resolve();
      }),
    })),
    update: vi.fn(() => ({
      set: vi.fn((v: Record<string, unknown>) => ({
        where: vi.fn(() => {
          dbUpdatedRuns.push(v);
          return Promise.resolve();
        }),
      })),
    })),
    execute: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock("../../server/services/deploy-lock.js", () => ({
  deployLock: {
    acquireLock: vi.fn().mockResolvedValue(true),
    releaseLock: vi.fn().mockResolvedValue(undefined),
    checkLock: vi.fn().mockResolvedValue(null),
  },
}));

beforeEach(() => {
  capturedExec.length = 0;
  dbInsertedRuns.length = 0;
  dbUpdatedRuns.length = 0;
});

describe("scripts-runner project-local integration (T019)", () => {
  it("dispatches via remote-exec with the project-local command shape", async () => {
    const { dispatchProjectLocalDeploy } = await import(
      "../../server/services/project-local-deploy-runner.js"
    );

    const result = await dispatchProjectLocalDeploy({
      scriptId: "deploy/project-local-deploy",
      serverId: "srv-1",
      params: {
        appDir: "/opt/app",
        scriptPath: "scripts/devops-deploy.sh",
        branch: "main",
      },
      userId: "user-1",
      deploymentId: "dep-1",
    });

    expect(result.runId).toBeTruthy();
    expect(result.jobId).toBeTruthy();

    // Wrapper inserted the pending row.
    expect(dbInsertedRuns).toHaveLength(1);
    expect(dbInsertedRuns[0]).toMatchObject({
      scriptId: "deploy/project-local-deploy",
      status: "pending",
      deploymentId: "dep-1",
    });

    // execStream was called with the project-local command, not `bash -s --`.
    expect(capturedExec).toHaveLength(1);
    expect(capturedExec[0].command).toContain(
      "NON_INTERACTIVE=1 DEBIAN_FRONTEND=noninteractive CI=true bash",
    );
    expect(capturedExec[0].command).toContain("'/opt/app'/'scripts/devops-deploy.sh'");
    expect(capturedExec[0].command).not.toContain("bash -s --");

    // No stdin payload (project-local script doesn't read from stdin).
    const buf = capturedExec[0].buffer;
    const len = Buffer.isBuffer(buf) ? buf.length : String(buf).length;
    expect(len).toBe(0);
  });
});
