import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Unit tests for deploy-lock advisory-lock key derivation (T005).
 *
 * Exercises the pure-function guarantees of the acquire code path: the
 * two-arg namespace constant is `1`, and the integer passed as the second
 * argument to `pg_try_advisory_lock` is derived from `hashtext(serverId)`
 * — identical for the same `serverId`, different for different serverIds.
 *
 * We capture the exact value of `$1` in the advisory-lock probe via a mocked
 * `client.reserve()`. The DB never runs `hashtext` — the real guarantee is
 * that the same string goes in each time, so we assert string equality there.
 */

const probeCalls: { ns: unknown; serverId: unknown }[] = [];

vi.mock("../../server/db/index.js", () => {
  const reserved = Object.assign(
    vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
      const sqlStr = strings.join("?");
      if (sqlStr.includes("pg_try_advisory_lock")) {
        probeCalls.push({ ns: values[0], serverId: values[1] });
        return Promise.resolve([{ got: true }]);
      }
      return Promise.resolve([]);
    }),
    {
      release: vi.fn(),
    },
  );

  const client = Object.assign(
    vi.fn(() => Promise.resolve([])),
    {
      reserve: vi.fn(() => Promise.resolve(reserved)),
    },
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

describe("DEPLOY_LOCK_NAMESPACE constant", () => {
  it("is exported and equals 1 (FR-002)", async () => {
    const { DEPLOY_LOCK_NAMESPACE } = await import(
      "../../server/services/deploy-lock.js"
    );
    expect(DEPLOY_LOCK_NAMESPACE).toBe(1);
  });
});

describe("advisory-lock key derivation", () => {
  beforeEach(() => {
    probeCalls.length = 0;
  });

  it("passes the namespace `1` as the first argument to pg_try_advisory_lock", async () => {
    const { deployLock } = await import("../../server/services/deploy-lock.js");
    await deployLock.acquireLock("srv-A", "app-A");
    await deployLock.releaseLock("srv-A");

    expect(probeCalls.length).toBeGreaterThan(0);
    expect(probeCalls[0]?.ns).toBe(1);
  });

  it("passes distinct serverIds through to the probe (different hashtext inputs)", async () => {
    const { deployLock } = await import("../../server/services/deploy-lock.js");
    await deployLock.acquireLock("srv-A", "app-A");
    await deployLock.releaseLock("srv-A");
    await deployLock.acquireLock("srv-B", "app-B");
    await deployLock.releaseLock("srv-B");

    expect(probeCalls[0]?.serverId).toBe("srv-A");
    expect(probeCalls[1]?.serverId).toBe("srv-B");
    expect(probeCalls[0]?.serverId).not.toBe(probeCalls[1]?.serverId);
  });

  it("passes the same serverId through consistently across calls (stable key)", async () => {
    const { deployLock } = await import("../../server/services/deploy-lock.js");
    await deployLock.acquireLock("srv-X", "app-1");
    await deployLock.releaseLock("srv-X");
    await deployLock.acquireLock("srv-X", "app-2");
    await deployLock.releaseLock("srv-X");

    expect(probeCalls).toHaveLength(2);
    expect(probeCalls[0]?.serverId).toBe("srv-X");
    expect(probeCalls[1]?.serverId).toBe("srv-X");
  });
});
