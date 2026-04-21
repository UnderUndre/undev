/**
 * Feature 005 T023 + T024 + T025 + T026: integration smoke test for
 * scripts-runner against mocked ssh-pool + mocked DB + real file system
 * (scripts/common.sh + target files at repo root).
 *
 * Kept light to avoid a full DB double — we mock `../../server/db/index.js`
 * so the runner's drizzle calls are captured for assertions without touching
 * postgres.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ──────────────────────────────────────────────────────────────────
const capturedStdin: { buffer: string; command: string }[] = [];

function mkStream() {
  const handlers: Record<string, (...args: unknown[]) => void> = {};
  return {
    on: vi.fn((evt: string, cb: (...args: unknown[]) => void) => {
      handlers[evt] = cb;
    }),
    stderr: { on: vi.fn() },
    write: vi.fn((buf: unknown) => {
      capturedStdin[capturedStdin.length - 1].buffer = String(buf);
    }),
    end: vi.fn(),
    signal: vi.fn(),
    close: vi.fn(),
    _fire: (evt: string, ...args: unknown[]) => handlers[evt]?.(...args),
  };
}

let currentStream = mkStream();

vi.mock("../../server/services/ssh-pool.js", () => ({
  sshPool: {
    isConnected: vi.fn().mockReturnValue(true),
    connect: vi.fn().mockResolvedValue(undefined),
    execStream: vi.fn((serverId: string, command: string) => {
      currentStream = mkStream();
      capturedStdin.push({ buffer: "", command });
      return Promise.resolve({
        stream: currentStream,
        kill: vi.fn(),
      });
    }),
  },
}));

const dbInserted: Record<string, unknown>[] = [];
const dbUpdated: Record<string, unknown>[] = [];

vi.mock("../../server/db/index.js", () => ({
  db: {
    insert: vi.fn(() => ({
      values: vi.fn((v: Record<string, unknown>) => {
        dbInserted.push(v);
        return Promise.resolve();
      }),
    })),
    update: vi.fn(() => ({
      set: vi.fn((v: Record<string, unknown>) => ({
        where: vi.fn(() => {
          dbUpdated.push(v);
          return Promise.resolve();
        }),
      })),
    })),
    execute: vi.fn().mockResolvedValue([]),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn().mockResolvedValue([]),
        })),
      })),
    })),
  },
  client: {
    reserve: vi.fn(),
  },
}));

// deploy-lock mock — configurable per test
const lockState = { acquired: true, owner: null as string | null };
vi.mock("../../server/services/deploy-lock.js", () => ({
  deployLock: {
    acquireLock: vi.fn().mockImplementation(async () =>
      lockState.acquired,
    ),
    releaseLock: vi.fn().mockResolvedValue(undefined),
    checkLock: vi.fn().mockImplementation(async () => lockState.owner),
  },
}));

// ── Test ───────────────────────────────────────────────────────────────────
describe("scripts-runner integration (feature 005 T023/T024/T025/T026)", () => {
  beforeEach(() => {
    capturedStdin.length = 0;
    dbInserted.length = 0;
    dbUpdated.length = 0;
    lockState.acquired = true;
    lockState.owner = null;
  });

  it("dispatches a manifest-listed script and persists script_runs row", async () => {
    vi.resetModules();
    // Point scripts-runner at a real scripts dir for common.sh + target reads.
    process.env.SCRIPTS_ROOT = require("node:path").resolve(
      __dirname,
      "../../../scripts",
    );
    const { scriptsRunner } = await import(
      "../../server/services/scripts-runner.js"
    );
    const { jobManager } = await import(
      "../../server/services/job-manager.js"
    );

    const { runId, jobId } = await scriptsRunner.runScript(
      "db/backup",
      "srv-A",
      { databaseName: "mydb", retentionDays: 30 },
      "admin",
    );

    expect(runId).toBeTruthy();
    expect(jobId).toBeTruthy();

    // script_runs insert with pending status
    expect(dbInserted.length).toBeGreaterThanOrEqual(1);
    const insert = dbInserted[0];
    expect(insert.scriptId).toBe("db/backup");
    expect(insert.serverId).toBe("srv-A");
    expect(insert.status).toBe("pending");
    expect(insert.params).toMatchObject({
      databaseName: "mydb",
      retentionDays: 30,
    });

    // Transition to running
    await new Promise((r) => setImmediate(r));
    expect(dbUpdated.some((u) => u.status === "running")).toBe(true);

    // SSH dispatch: non-secret argv is in the COMMAND (after `bash -s --`),
    // common.sh is in the stdin buffer.
    await new Promise((r) => setImmediate(r));
    expect(capturedStdin.length).toBe(1);
    expect(capturedStdin[0].command).toMatch(/^bash -s --/);
    expect(capturedStdin[0].command).toContain("--database-name='mydb'");
    expect(capturedStdin[0].command).toContain("--retention-days='30'");
    expect(capturedStdin[0].buffer).toContain("# --- begin common.sh");
  });

  it("masks secret params in DB, routes them to stdin env, never to argv", async () => {
    vi.resetModules();
    process.env.SCRIPTS_ROOT = require("node:path").resolve(
      __dirname,
      "../../../scripts",
    );
    // Patch manifest to add a temp secret-bearing entry via module mock.
    const { z } = await import("zod");
    vi.doMock("../../server/scripts-manifest.js", async (orig) => {
      const m = (await (orig as () => Promise<Record<string, unknown>>)()) as {
        manifest: unknown[];
        CATEGORY_FOLDER_MAP: Record<string, string>;
      };
      return {
        ...m,
        manifest: [
          ...(m.manifest as { id: string }[]).filter(
            (e) => e.id !== "db/backup",
          ),
          {
            id: "db/backup",
            category: "db",
            description: "Backup (test with secret)",
            locus: "target",
            params: z.object({
              databaseName: z.string(),
              adminKey: z.string().describe("secret"),
            }),
          },
        ],
      };
    });

    const { scriptsRunner } = await import(
      "../../server/services/scripts-runner.js"
    );
    await scriptsRunner.runScript(
      "db/backup",
      "srv-A",
      { databaseName: "mydb", adminKey: "s3cretXYZ" },
      "admin",
    );
    await new Promise((r) => setImmediate(r));

    // DB row stored with masked secret
    expect((dbInserted[0].params as Record<string, string>).adminKey).toBe(
      "***",
    );
    // SSH command invariant (no per-invocation env prefix)
    expect(capturedStdin[0].command).toMatch(/^bash -s/);
    expect(capturedStdin[0].command).not.toContain("s3cretXYZ");
    expect(capturedStdin[0].command).not.toMatch(/env\s+SECRET_/);
    // Stdin buffer DOES contain the secret (encrypted SSH channel)
    expect(capturedStdin[0].buffer).toContain(
      "export SECRET_ADMIN_KEY='s3cretXYZ'",
    );
    // argv in buffer does NOT contain the secret
    expect(capturedStdin[0].buffer).not.toContain("--admin-key=");
    vi.doUnmock("../../server/scripts-manifest.js");
  });

  it("requiresLock=true + lock held → throws DeploymentLockedError", async () => {
    vi.resetModules();
    process.env.SCRIPTS_ROOT = require("node:path").resolve(
      __dirname,
      "../../../scripts",
    );
    lockState.acquired = false;
    lockState.owner = "prior-app";

    const { scriptsRunner, DeploymentLockedError } = await import(
      "../../server/services/scripts-runner.js"
    );
    await expect(
      scriptsRunner.runScript(
        "db/restore",
        "srv-A",
        { databaseName: "mydb", backupPath: "/tmp/x.sql" },
        "admin",
      ),
    ).rejects.toBeInstanceOf(DeploymentLockedError);
  });
});
