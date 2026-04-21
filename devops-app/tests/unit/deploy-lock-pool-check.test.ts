import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Pool-safety self-check unit test (T015).
 *
 * Simulates a transaction-mode pooler between dashboard and Postgres by
 * returning divergent backend PIDs on two queries over the "same" reserved
 * handle. assertDirectConnection() must throw.
 */

let pidQueue: number[] = [];

vi.mock("../../server/db/index.js", () => {
  const reserved = Object.assign(
    vi.fn(() => {
      const pid = pidQueue.shift() ?? 0;
      return Promise.resolve([{ pid }]);
    }),
    {
      begin: vi.fn(),
      release: vi.fn(),
    },
  );
  const client = Object.assign(
    vi.fn(() => Promise.resolve([])),
    { reserve: vi.fn(() => Promise.resolve(reserved)) },
  );
  return { client, db: {} };
});

vi.mock("../../server/lib/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    debug: vi.fn(),
  },
}));

describe("DeployLock — assertDirectConnection (T015)", () => {
  beforeEach(() => {
    vi.resetModules();
    pidQueue = [];
    delete process.env.DEPLOY_LOCK_SKIP_POOL_CHECK;
  });

  it("passes when both pg_backend_pid() calls return the same PID", async () => {
    pidQueue = [12345, 12345];
    const { deployLock } = await import("../../server/services/deploy-lock.js");
    await expect(deployLock.assertDirectConnection()).resolves.toBeUndefined();
  });

  it("throws when PIDs diverge (transaction-mode pooler detected)", async () => {
    pidQueue = [12345, 67890];
    const { deployLock } = await import("../../server/services/deploy-lock.js");
    await expect(deployLock.assertDirectConnection()).rejects.toThrow(
      /transaction-mode pooler detected/,
    );
  });

  it("skips the check when DEPLOY_LOCK_SKIP_POOL_CHECK=1", async () => {
    process.env.DEPLOY_LOCK_SKIP_POOL_CHECK = "1";
    pidQueue = [1, 2]; // divergent — would normally throw
    const { deployLock } = await import("../../server/services/deploy-lock.js");
    await expect(deployLock.assertDirectConnection()).resolves.toBeUndefined();
  });
});
