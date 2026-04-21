import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Integration tests for DeployLock (T006–T010).
 *
 * Uses a hand-rolled mock of the `postgres` driver's tagged-template + reserve()
 * surface to exercise the full acquire/check/release/reconcile code paths
 * without a real database. The mock preserves the one invariant that the code
 * actually depends on: `sql.reserve()` returns a dedicated handle, and any
 * queries issued on it go to that same "backend" — the mock uses a sentinel
 * to verify same-connection usage.
 */

// ── Mock shape ───────────────────────────────────────────────────────────────

interface MockBackend {
  pid: number;
  // advisory locks "held" by this backend (namespace+key → boolean).
  // Session-scoped — released on backend "close" or explicit unlock.
  advisoryLocks: Set<string>;
}

interface MockState {
  // Simulated deploy_locks table rows.
  rows: Map<
    string,
    { server_id: string; app_id: string; acquired_at: string; dashboard_pid: number }
  >;
  // Every reserve() call allocates a new mock backend.
  backends: MockBackend[];
  nextPid: number;
  // Set of PIDs currently "alive" (in pg_stat_activity).
  alivePids: Set<number>;
  // Advisory locks already held by OTHER (external) connections — forces
  // pg_try_advisory_lock to return false for the serverId whose hashtext falls here.
  externallyHeld: Set<string>;
  // Flag to force the INSERT to throw (pool-contamination regression).
  forceInsertThrow: boolean;
  // Flag to force DELETE FROM deploy_locks to throw (release-unlock regression).
  forceDeleteThrow: boolean;
}

function createMockState(): MockState {
  return {
    rows: new Map(),
    backends: [],
    nextPid: 10000,
    alivePids: new Set(),
    externallyHeld: new Set(),
    forceInsertThrow: false,
    forceDeleteThrow: false,
  };
}

let state: MockState = createMockState();

function hashKey(serverId: string): string {
  // Mock equivalent of `hashtext(serverId)` — we don't care about the numeric
  // value, only that same input → same key, different inputs → different keys.
  return `key:${serverId}`;
}

function makeReserved(state: MockState) {
  const backend: MockBackend = {
    pid: state.nextPid++,
    advisoryLocks: new Set(),
  };
  state.backends.push(backend);
  state.alivePids.add(backend.pid);

  let released = false;

  const runQuery = (sqlStr: string, values: unknown[]): Promise<unknown[]> => {
    if (released) {
      throw new Error("query on released connection");
    }
    // pg_try_advisory_lock(ns, hashtext($1))
    if (sqlStr.includes("pg_try_advisory_lock")) {
      const serverId = values[1] as string;
      const key = hashKey(serverId);
      // Can't grant if another backend (not this one) already holds it
      // OR if the test marked it as externally held.
      const heldByOther =
        state.externallyHeld.has(key) ||
        state.backends.some(
          (b) => b !== backend && b.advisoryLocks.has(key),
        );
      if (heldByOther) return Promise.resolve([{ got: false }]);
      backend.advisoryLocks.add(key);
      return Promise.resolve([{ got: true }]);
    }
    if (sqlStr.includes("INSERT INTO deploy_locks")) {
      if (state.forceInsertThrow) {
        return Promise.reject(new Error("simulated INSERT failure"));
      }
      const [serverId, appId, acquiredAt] = values as [string, string, string];
      state.rows.set(serverId, {
        server_id: serverId,
        app_id: appId,
        acquired_at: acquiredAt,
        dashboard_pid: backend.pid,
      });
      return Promise.resolve([]);
    }
    if (sqlStr.includes("DELETE FROM deploy_locks WHERE server_id")) {
      if (state.forceDeleteThrow) {
        return Promise.reject(new Error("simulated DELETE failure"));
      }
      const serverId = values[0] as string;
      state.rows.delete(serverId);
      return Promise.resolve([]);
    }
    if (sqlStr.includes("pg_advisory_unlock_all")) {
      backend.advisoryLocks.clear();
      return Promise.resolve([]);
    }
    if (sqlStr.includes("pg_advisory_unlock")) {
      // pg_advisory_unlock(ns, hashtext($1)) — values = [ns, serverId]
      const serverId = values[1] as string;
      backend.advisoryLocks.delete(hashKey(serverId));
      return Promise.resolve([]);
    }
    if (sqlStr.includes("pg_backend_pid")) {
      return Promise.resolve([{ pid: backend.pid }]);
    }
    return Promise.resolve([]);
  };

  const tx = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    const sqlStr = strings.join("?");
    return runQuery(sqlStr, values);
  });

  const reserved = Object.assign(
    vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
      const sqlStr = strings.join("?");
      return runQuery(sqlStr, values);
    }),
    {
      begin: vi.fn(async (fn: (tx: typeof tx) => Promise<void>) => {
        await fn(tx);
      }),
      // porsager/postgres throws on double-release. Mirror that contract so
      // the double-release test can assert the regression fence.
      release: vi.fn(() => {
        if (released) {
          throw new Error("reserved.release() called twice on the same connection");
        }
        released = true;
        state.alivePids.delete(backend.pid);
      }),
      _backend: backend,
    },
  );
  return reserved;
}

function makeClient() {
  const client = Object.assign(
    vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
      const sqlStr = strings.join("?");
      if (sqlStr.includes("DELETE FROM deploy_locks") && sqlStr.includes("NOT IN")) {
        // Reconciliation query.
        const deleted: { server_id: string }[] = [];
        for (const [k, row] of state.rows) {
          if (!state.alivePids.has(row.dashboard_pid)) {
            deleted.push({ server_id: row.server_id });
            state.rows.delete(k);
          }
        }
        return Promise.resolve(deleted);
      }
      if (sqlStr.includes("SELECT app_id FROM deploy_locks")) {
        const serverId = values[0] as string;
        const row = state.rows.get(serverId);
        if (!row) return Promise.resolve([]);
        if (!state.alivePids.has(row.dashboard_pid)) return Promise.resolve([]);
        return Promise.resolve([{ app_id: row.app_id }]);
      }
      return Promise.resolve([]);
    }),
    {
      reserve: vi.fn(() => Promise.resolve(makeReserved(state))),
    },
  );
  return client;
}

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("../../server/db/index.js", () => {
  const client = makeClient();
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

// SSH pool mock — T010 asserts this is never touched by the lock code path.
vi.mock("../../server/services/ssh-pool.js", () => ({
  sshPool: {
    connect: vi.fn(),
    exec: vi.fn(() => {
      throw new Error("SSH should never be called by deploy-lock (US5 regression)");
    }),
    execStream: vi.fn(),
    isConnected: vi.fn(),
    disconnect: vi.fn(),
  },
}));

// ── Tests ────────────────────────────────────────────────────────────────────

async function freshLock() {
  vi.resetModules();
  state = createMockState();
  const { deployLock, DEPLOY_LOCK_NAMESPACE } = await import(
    "../../server/services/deploy-lock.js"
  );
  return { deployLock, DEPLOY_LOCK_NAMESPACE };
}

beforeEach(() => {
  state = createMockState();
});

describe("DeployLock — US1: acquire instantly, no SSH", () => {
  it("happy path: acquire → check → release, zero SSH calls", async () => {
    const { deployLock } = await freshLock();
    const { sshPool } = await import("../../server/services/ssh-pool.js");

    const ok = await deployLock.acquireLock("srv-A", "app-A");
    expect(ok).toBe(true);
    expect(state.rows.get("srv-A")?.app_id).toBe("app-A");
    expect(state.rows.get("srv-A")?.dashboard_pid).toBeGreaterThan(0);

    const owner = await deployLock.checkLock("srv-A");
    expect(owner).toBe("app-A");

    await deployLock.releaseLock("srv-A");
    expect(state.rows.has("srv-A")).toBe(false);

    expect(sshPool.exec).not.toHaveBeenCalled();
  });

  it("pool-contamination regression: INSERT failure runs pg_advisory_unlock_all before release", async () => {
    const { deployLock } = await freshLock();
    state.forceInsertThrow = true;

    await expect(deployLock.acquireLock("srv-A", "app-A")).rejects.toThrow(
      /simulated INSERT failure/,
    );

    // Advisory lock must have been cleared on the reserved backend before release.
    const backend = state.backends[0];
    expect(backend?.advisoryLocks.size).toBe(0);
    // `held` must stay empty so re-acquire is possible.
    expect(deployLock.heldServerIds()).toEqual([]);
    // No lingering row.
    expect(state.rows.has("srv-A")).toBe(false);
  });
});

describe("DeployLock — releaseLock regression fences", () => {
  it("advisory unlock runs even when DELETE throws (pool-poisoning guard)", async () => {
    const { deployLock } = await freshLock();

    await deployLock.acquireLock("srv-A", "app-A");
    const backend = state.backends[0];
    expect(backend?.advisoryLocks.size).toBe(1);

    // Force the DELETE to fail — the subsequent pg_advisory_unlock MUST still run,
    // otherwise the released connection returns to the pool with our session-held
    // advisory lock still attached and poisons the next consumer.
    state.forceDeleteThrow = true;
    await expect(deployLock.releaseLock("srv-A")).resolves.toBeUndefined();

    expect(backend?.advisoryLocks.size).toBe(0);
    expect(deployLock.heldServerIds()).toEqual([]);
  });

  it("concurrent releaseLock calls do not double-release the same reserved connection", async () => {
    const { deployLock } = await freshLock();

    await deployLock.acquireLock("srv-A", "app-A");
    // Two callers race — e.g. the deploy route's completion handler and the
    // pool-exhaustion watchdog. Both must converge without throwing or calling
    // reserved.release() twice (porsager/postgres rejects the second call).
    await expect(
      Promise.all([
        deployLock.releaseLock("srv-A"),
        deployLock.releaseLock("srv-A"),
      ]),
    ).resolves.toBeDefined();

    expect(deployLock.heldServerIds()).toEqual([]);
    expect(state.rows.has("srv-A")).toBe(false);
  });
});

describe("DeployLock — US2: concurrent same-server blocked", () => {
  it("second acquire returns false when another connection holds the advisory lock", async () => {
    const { deployLock } = await freshLock();

    // First acquire in this process succeeds.
    const first = await deployLock.acquireLock("srv-A", "app-1");
    expect(first).toBe(true);

    // Simulate a second *external* dashboard process already holding the same
    // advisory lock — pg_try_advisory_lock returns false to us.
    state.externallyHeld.add(hashKey("srv-B"));
    const second = await deployLock.acquireLock("srv-B", "app-2");
    expect(second).toBe(false);
    expect(state.rows.has("srv-B")).toBe(false);
  });

  it("same-process re-entrancy throws before hitting SQL", async () => {
    const { deployLock } = await freshLock();
    await deployLock.acquireLock("srv-A", "app-1");
    await expect(deployLock.acquireLock("srv-A", "app-2")).rejects.toThrow(
      /lock already held by this instance/,
    );
  });
});

describe("DeployLock — US3: different servers parallel", () => {
  it("both acquires succeed on distinct servers and consume distinct reserved handles", async () => {
    const { deployLock } = await freshLock();

    const backendsBefore = state.backends.length;

    const [a, b] = await Promise.all([
      deployLock.acquireLock("srv-A", "app-1"),
      deployLock.acquireLock("srv-B", "app-2"),
    ]);
    expect(a).toBe(true);
    expect(b).toBe(true);

    expect(await deployLock.checkLock("srv-A")).toBe("app-1");
    expect(await deployLock.checkLock("srv-B")).toBe("app-2");

    // Two new backends were allocated (one per reserve() call) with distinct PIDs.
    const newBackends = state.backends.slice(backendsBefore);
    expect(newBackends).toHaveLength(2);
    expect(newBackends[0]?.pid).not.toBe(newBackends[1]?.pid);

    await deployLock.releaseLock("srv-A");
    await deployLock.releaseLock("srv-B");
    expect(state.rows.size).toBe(0);
  });
});

describe("DeployLock — US4: restart releases locks (reconcile)", () => {
  it("deletes rows whose dashboard_pid is no longer in pg_stat_activity", async () => {
    const { deployLock } = await freshLock();

    // Seed one orphan row with a PID that's NOT in alivePids.
    state.rows.set("srv-ghost", {
      server_id: "srv-ghost",
      app_id: "app-dead",
      acquired_at: new Date().toISOString(),
      dashboard_pid: 999999,
    });

    // Seed one LIVE row whose PID IS alive — should be preserved.
    const livePid = 42;
    state.alivePids.add(livePid);
    state.rows.set("srv-live", {
      server_id: "srv-live",
      app_id: "app-live",
      acquired_at: new Date().toISOString(),
      dashboard_pid: livePid,
    });

    const count = await deployLock.reconcileOrphanLocks();
    expect(count).toBe(1);
    expect(state.rows.has("srv-ghost")).toBe(false);
    expect(state.rows.has("srv-live")).toBe(true);

    // Fresh acquire on the previously-orphaned server succeeds.
    const ok = await deployLock.acquireLock("srv-ghost", "app-new");
    expect(ok).toBe(true);
  });
});

describe("DeployLock — US5: SSH-unreachable server, lock still usable", () => {
  it("full acquire → check → release cycle never touches sshPool", async () => {
    const { deployLock } = await freshLock();
    const { sshPool } = await import("../../server/services/ssh-pool.js");

    await deployLock.acquireLock("srv-A", "app-A");
    await deployLock.checkLock("srv-A");
    await deployLock.releaseLock("srv-A");

    // sshPool.exec was wired to throw on any call — presence of this assertion
    // is the sentinel: if a future regression reintroduces SSH-based locking,
    // this test fails immediately.
    expect(sshPool.exec).toHaveBeenCalledTimes(0);
  });
});
