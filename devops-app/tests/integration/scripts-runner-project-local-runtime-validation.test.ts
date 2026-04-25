/**
 * Feature 007 T033: SC-007 forensics-trail invariant.
 *
 * Simulates DB tampering — params with a `scriptPath` that the route layer
 * would never accept. The wrapper inserts the pending row, the runner's Zod
 * refine throws, the wrapper's catch transitions the row to `failed` with the
 * runtime-validation error message. sshPool.execStream is NEVER called.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const dbInsertedRuns: Record<string, unknown>[] = [];
const dbUpdatedRuns: Record<string, unknown>[] = [];
const sshExecCalls: string[] = [];
let pendingStatus: string = "pending";

vi.mock("../../server/services/ssh-pool.js", () => ({
  sshPool: {
    isConnected: vi.fn().mockReturnValue(true),
    connect: vi.fn().mockResolvedValue(undefined),
    execStream: vi.fn((_id: string, cmd: string) => {
      sshExecCalls.push(cmd);
      return Promise.resolve({
        stream: { on: vi.fn(), stderr: { on: vi.fn() }, write: vi.fn(), end: vi.fn() },
        kill: vi.fn(),
      });
    }),
  },
}));

vi.mock("../../server/db/index.js", () => ({
  db: {
    insert: vi.fn(() => ({
      values: vi.fn((v: Record<string, unknown>) => {
        dbInsertedRuns.push(v);
        pendingStatus = (v.status as string) ?? "pending";
        return Promise.resolve();
      }),
    })),
    update: vi.fn(() => ({
      set: vi.fn((v: Record<string, unknown>) => ({
        where: vi.fn(() => {
          if (pendingStatus === "pending") {
            dbUpdatedRuns.push(v);
            if (typeof v.status === "string") pendingStatus = v.status;
          }
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
  dbInsertedRuns.length = 0;
  dbUpdatedRuns.length = 0;
  sshExecCalls.length = 0;
  pendingStatus = "pending";
});

describe("project-local runtime validation (T033, SC-007)", () => {
  it("tampered scriptPath: row exists with status=failed, ssh never called", async () => {
    const { dispatchProjectLocalDeploy, ProjectLocalValidationError } =
      await import(
        "../../server/services/project-local-deploy-runner.js"
      );

    await expect(
      dispatchProjectLocalDeploy({
        scriptId: "deploy/project-local-deploy",
        serverId: "srv-1",
        params: {
          appDir: "/opt/app",
          scriptPath: "../../etc/passwd",
          branch: "main",
        },
        userId: "user-1",
        deploymentId: "dep-1",
      }),
    ).rejects.toBeInstanceOf(ProjectLocalValidationError);

    // Forensics row exists.
    expect(dbInsertedRuns).toHaveLength(1);
    expect(dbInsertedRuns[0]).toMatchObject({
      scriptId: "deploy/project-local-deploy",
      status: "pending",
    });

    // Wrapper transitioned it to failed with the runtime-validation message.
    expect(dbUpdatedRuns).toHaveLength(1);
    expect(dbUpdatedRuns[0]).toMatchObject({ status: "failed" });
    expect(String(dbUpdatedRuns[0].errorMessage)).toMatch(
      /scriptPath failed runtime validation/,
    );

    // SSH never executed — fail-closed invariant.
    expect(sshExecCalls).toHaveLength(0);
  });
});
