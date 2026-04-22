import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Watchdog unit test (T014).
 *
 * Simulates a stuck lock: acquire, fast-forward 30 minutes of wall clock,
 * let the watchdog tick fire, assert `releaseLock` was invoked and a warn
 * log was emitted.
 */

const loggerWarn = vi.fn();

vi.mock("../../server/lib/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: loggerWarn,
    error: vi.fn(),
    fatal: vi.fn(),
    debug: vi.fn(),
  },
}));

// Minimal postgres mock — just enough to acquire + release.
const rows = new Map<string, unknown>();

vi.mock("../../server/db/index.js", () => {
  const reserved = Object.assign(
    vi.fn((strings: TemplateStringsArray) => {
      const sqlStr = strings.join("?");
      if (sqlStr.includes("pg_try_advisory_lock"))
        return Promise.resolve([{ got: true }]);
      if (sqlStr.includes("INSERT INTO deploy_locks")) {
        rows.set("srv-A", { app_id: "app-A" });
        return Promise.resolve([]);
      }
      if (sqlStr.includes("DELETE FROM deploy_locks")) {
        rows.delete("srv-A");
      }
      return Promise.resolve([]);
    }),
    {
      release: vi.fn(),
    },
  );
  const client = Object.assign(
    vi.fn(() => Promise.resolve([])),
    { reserve: vi.fn(() => Promise.resolve(reserved)) },
  );
  return { client, db: {} };
});

describe("DeployLock — pool-exhaustion watchdog (T014)", () => {
  beforeEach(() => {
    rows.clear();
    loggerWarn.mockClear();
    vi.resetModules();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("force-releases a lock older than DEPLOY_LOCK_MAX_AGE_MS", async () => {
    const { deployLock } = await import("../../server/services/deploy-lock.js");

    // Acquire a lock at t=0.
    const start = new Date("2026-04-21T12:00:00Z").getTime();
    vi.setSystemTime(start);
    const ok = await deployLock.acquireLock("srv-A", "app-A");
    expect(ok).toBe(true);
    expect(deployLock.heldServerIds()).toEqual(["srv-A"]);

    // Start watchdog, then fast-forward past the 30-min threshold.
    deployLock.start();
    vi.setSystemTime(start + 31 * 60 * 1000);

    // Advance timers enough for the 60s interval to fire and the async
    // releaseLock chain to resolve.
    await vi.advanceTimersByTimeAsync(60_000);

    expect(deployLock.heldServerIds()).toEqual([]);
    expect(rows.has("srv-A")).toBe(false);
    expect(loggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx: "deploy-lock-watchdog",
        serverId: "srv-A",
        appId: "app-A",
      }),
      expect.stringContaining("stuck"),
    );

    deployLock.stop();
  });
});
