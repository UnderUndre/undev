/**
 * Feature 007 T015: integration test for the pre-insert wrapper.
 *
 * Mocks `db` + `scriptsRunner` to verify the SC-007 forensics trail invariant:
 * a `script_runs` row exists with status=failed for every dispatch failure
 * mode (Zod, lock, DB, SSH), without overwriting a runner-owned terminal write.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { ZodError } from "zod";
import { tmpdir } from "node:os";

process.env.LOG_DIR = tmpdir();

interface InsertCall {
  values: Record<string, unknown>;
}
interface UpdateCall {
  set: Record<string, unknown>;
  whereStatus?: string;
}

const dbInserts: InsertCall[] = [];
const dbUpdates: UpdateCall[] = [];
// Tracks the "current" status of the row from the wrapper's perspective so
// the conditional `WHERE status = 'pending'` clause behaves like postgres.
let rowStatus: "pending" | "running" | "success" | "failed" = "pending";

vi.mock("../../server/db/index.js", () => ({
  db: {
    insert: vi.fn(() => ({
      values: vi.fn((v: Record<string, unknown>) => {
        dbInserts.push({ values: v });
        rowStatus = (v.status as typeof rowStatus) ?? "pending";
        return Promise.resolve();
      }),
    })),
    update: vi.fn(() => ({
      set: vi.fn((v: Record<string, unknown>) => ({
        where: vi.fn(() => {
          // Wrapper's conditional UPDATE: only apply when row is pending.
          if (rowStatus === "pending") {
            dbUpdates.push({ set: v, whereStatus: "pending" });
            if (typeof v.status === "string") {
              rowStatus = v.status as typeof rowStatus;
            }
          } else {
            // No-op: simulate WHERE clause mismatch.
            dbUpdates.push({ set: v, whereStatus: rowStatus });
          }
          return Promise.resolve();
        }),
      })),
    })),
  },
}));

const runScriptMock = vi.fn();

vi.mock("../../server/services/scripts-runner.js", () => ({
  scriptsRunner: {
    runScript: (...args: unknown[]) => runScriptMock(...args),
  },
}));

const baseInput = {
  scriptId: "deploy/project-local-deploy" as const,
  serverId: "srv-1",
  params: {
    appDir: "/opt/app",
    scriptPath: "scripts/devops-deploy.sh",
    branch: "main",
  },
  userId: "user-1",
  deploymentId: "dep-1",
};

beforeEach(() => {
  dbInserts.length = 0;
  dbUpdates.length = 0;
  rowStatus = "pending";
  runScriptMock.mockReset();
});

describe("dispatchProjectLocalDeploy (T015)", () => {
  it("happy path: insert pending + runner success → no wrapper UPDATE", async () => {
    runScriptMock.mockImplementation(async (_id, _srv, _p, _u, opts) => {
      // Simulate runner taking ownership and finishing successfully.
      rowStatus = "success";
      return { runId: opts.reuseRunId, jobId: "job-1" };
    });
    const { dispatchProjectLocalDeploy } = await import(
      "../../server/services/project-local-deploy-runner.js"
    );
    const r = await dispatchProjectLocalDeploy(baseInput);
    expect(dbInserts).toHaveLength(1);
    expect(dbInserts[0].values).toMatchObject({
      status: "pending",
      scriptId: "deploy/project-local-deploy",
    });
    expect(r.jobId).toBe("job-1");
    expect(r.runId).toBeTruthy();
    // Wrapper's catch block did not fire.
    expect(dbUpdates).toHaveLength(0);
  });

  it("ZodError: row transitions to failed with validation message", async () => {
    runScriptMock.mockImplementation(async () => {
      throw new ZodError([
        {
          code: "custom",
          path: ["scriptPath"],
          message: "Invalid scriptPath",
        },
      ]);
    });
    const {
      dispatchProjectLocalDeploy,
      ProjectLocalValidationError,
    } = await import(
      "../../server/services/project-local-deploy-runner.js"
    );

    await expect(dispatchProjectLocalDeploy(baseInput)).rejects.toBeInstanceOf(
      ProjectLocalValidationError,
    );
    expect(dbInserts).toHaveLength(1);
    expect(dbUpdates).toHaveLength(1);
    expect(dbUpdates[0].set).toMatchObject({ status: "failed" });
    expect(String(dbUpdates[0].set.errorMessage)).toMatch(
      /scriptPath failed runtime validation/,
    );
  });

  it("DeploymentLockedError: row transitions to failed, error re-thrown", async () => {
    class DeploymentLockedError extends Error {
      constructor() {
        super("Another operation is in progress on this server");
        this.name = "DeploymentLockedError";
      }
    }
    runScriptMock.mockImplementation(async () => {
      throw new DeploymentLockedError();
    });
    const { dispatchProjectLocalDeploy } = await import(
      "../../server/services/project-local-deploy-runner.js"
    );
    await expect(dispatchProjectLocalDeploy(baseInput)).rejects.toThrow(
      /Another operation is in progress/,
    );
    expect(dbUpdates).toHaveLength(1);
    expect(dbUpdates[0].set).toMatchObject({ status: "failed" });
    expect(String(dbUpdates[0].set.errorMessage)).toMatch(
      /Deploy dispatch failed:.*Another operation/,
    );
  });

  it("DB/SSH error: row transitions to failed, error re-thrown", async () => {
    runScriptMock.mockImplementation(async () => {
      throw new Error("ECONNRESET");
    });
    const { dispatchProjectLocalDeploy } = await import(
      "../../server/services/project-local-deploy-runner.js"
    );
    await expect(dispatchProjectLocalDeploy(baseInput)).rejects.toThrow(
      /ECONNRESET/,
    );
    expect(dbUpdates).toHaveLength(1);
    expect(dbUpdates[0].set).toMatchObject({ status: "failed" });
  });

  it("runner-owned terminal status: wrapper UPDATE is a no-op", async () => {
    runScriptMock.mockImplementation(async () => {
      // Simulate runner transitioning row to running, then to failed via its
      // own terminal handler, then bubbling an error to the wrapper.
      rowStatus = "running";
      rowStatus = "failed";
      throw new Error("script exited with code 1");
    });
    const { dispatchProjectLocalDeploy } = await import(
      "../../server/services/project-local-deploy-runner.js"
    );
    await expect(dispatchProjectLocalDeploy(baseInput)).rejects.toThrow();
    // Wrapper attempted the UPDATE, but the conditional WHERE didn't match.
    expect(dbUpdates).toHaveLength(1);
    expect(dbUpdates[0].whereStatus).toBe("failed");
  });

  it("invariant: ≤1 INSERT and ≤1 UPDATE per run", async () => {
    runScriptMock.mockImplementation(async () => {
      throw new Error("boom");
    });
    const { dispatchProjectLocalDeploy } = await import(
      "../../server/services/project-local-deploy-runner.js"
    );
    await expect(dispatchProjectLocalDeploy(baseInput)).rejects.toThrow();
    expect(dbInserts.length).toBe(1);
    expect(dbUpdates.length).toBeLessThanOrEqual(1);
  });
});
