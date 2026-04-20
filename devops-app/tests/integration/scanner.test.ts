import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";

// ── Mocks ───────────────────────────────────────────────────────────────────

const mockServerRow = {
  id: "srv-1",
  label: "test",
  host: "127.0.0.1",
  port: 22,
  sshUser: "ubuntu",
  sshAuthMethod: "key",
  sshPrivateKey: "KEY",
  sshPassword: null,
  scriptsPath: "",
  status: "online",
  lastHealthCheck: null,
  scanRoots: ["/opt", "/srv"],
  createdAt: "2026-04-20T00:00:00Z",
};

// db.select() chainable fluent mock — returns different data by table.
let existingApps: Array<{ id: string; remotePath: string; repoUrl: string }> = [];

vi.mock("../../server/db/index.js", () => {
  const chain = (data: unknown[]) => ({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(data),
        then: (fn: (v: unknown[]) => unknown) => Promise.resolve(fn(data)),
      }),
    }),
  });
  return {
    db: {
      select: vi.fn((cols?: unknown) => {
        // First .select(...) in scanner.ts is for servers (no cols arg),
        // second is for applications (with cols arg).
        const data = cols ? existingApps : [mockServerRow];
        return chain(data);
      }),
    },
  };
});

// SSH pool mock
class MockStream extends EventEmitter {
  stderr = new EventEmitter();
}

let mockStdout = "";
let killCalls = 0;
// When true, execStream returns a stream that NEVER closes automatically.
// Test code must call releasePendingStream() to let the scan finish.
let holdStream = false;
let pendingEmit: (() => void) | null = null;

function releasePendingStream() {
  pendingEmit?.();
  pendingEmit = null;
}

vi.mock("../../server/services/ssh-pool.js", () => ({
  sshPool: {
    connect: vi.fn().mockResolvedValue(undefined),
    execStream: vi.fn().mockImplementation(async () => {
      const stream = new MockStream();
      const emit = () => {
        if (mockStdout) stream.emit("data", Buffer.from(mockStdout));
        stream.emit("close");
      };
      if (holdStream) {
        pendingEmit = emit;
      } else {
        setImmediate(emit);
      }
      return {
        stream,
        kill: () => {
          killCalls += 1;
          stream.emit("close");
        },
      };
    }),
  },
}));

// ── Tests ───────────────────────────────────────────────────────────────────

describe("scanner orchestrator (integration with mocked sshPool)", () => {
  beforeEach(() => {
    existingApps = [];
    mockStdout = "";
    killCalls = 0;
    holdStream = false;
    pendingEmit = null;
  });

  afterEach(async () => {
    const { __resetScanLocks } = await import("../../server/services/scanner.js");
    __resetScanLocks();
  });

  it("returns parsed candidates on happy path", async () => {
    const { scan } = await import("../../server/services/scanner.js");
    mockStdout = [
      "TOOL\tgit\tyes",
      "TOOL\tdocker\tyes",
      "GIT_BRANCH\t/opt/app\tmain",
      "GIT_SHA\t/opt/app\tdeadbeef00000000000000000000000000000000",
      "GIT_REMOTE\t/opt/app\tgit@github.com:acme/app.git",
      "COMPOSE\t/srv/stack/docker-compose.yml\t",
    ].join("\n");

    const result = await scan("srv-1", "user-1");

    expect(result.gitAvailable).toBe(true);
    expect(result.dockerAvailable).toBe(true);
    expect(result.gitCandidates).toHaveLength(1);
    expect(result.gitCandidates[0].path).toBe("/opt/app");
    expect(result.gitCandidates[0].githubRepo).toBe("acme/app");
    expect(result.gitCandidates[0].detached).toBe(false);
    expect(result.gitCandidates[0].dirty).toBe("clean");
    expect(result.dockerCandidates.some((c) => c.kind === "compose")).toBe(true);
    expect(result.partial).toBe(false);
  });

  it("marks alreadyImported for existing paths", async () => {
    existingApps = [
      { id: "app-1", remotePath: "/opt/app", repoUrl: "git@github.com:acme/app.git" },
    ];
    const { scan } = await import("../../server/services/scanner.js");
    mockStdout = [
      "TOOL\tgit\tyes",
      "GIT_BRANCH\t/opt/app\tmain",
    ].join("\n");

    const result = await scan("srv-1", "user-1");
    expect(result.gitCandidates[0].alreadyImported).toBe(true);
    expect(result.gitCandidates[0].existingApplicationId).toBe("app-1");
  });

  it("throws ScanInProgressError on concurrent scan of same server (FR-074)", async () => {
    const { scan, ScanInProgressError } = await import(
      "../../server/services/scanner.js"
    );
    mockStdout = "TOOL\tgit\tyes";
    holdStream = true;

    // Start first scan; it will hold until we release the pending emit.
    const first = scan("srv-1", "user-1");
    // Give the first scan a tick to acquire the lock.
    await new Promise((r) => setImmediate(r));

    // Second call should reject with ScanInProgressError.
    await expect(scan("srv-1", "user-2")).rejects.toBeInstanceOf(ScanInProgressError);

    // Release the first scan so the lock is freed.
    releasePendingStream();
    await first;

    // Third call succeeds — use non-holding mode for a quick completion.
    holdStream = false;
    const third = await scan("srv-1", "user-3");
    expect(third.gitAvailable).toBe(true);
  });

  it("releases lock after error so subsequent scans succeed", async () => {
    const { scan, __resetScanLocks } = await import(
      "../../server/services/scanner.js"
    );
    __resetScanLocks();

    // Force db.select to throw on the server row lookup, then restore.
    const dbMod = await import("../../server/db/index.js");
    const orig = dbMod.db.select;
    const fail = vi.fn().mockImplementation(() => {
      throw new Error("boom");
    });
    (dbMod.db as unknown as { select: unknown }).select = fail;

    await expect(scan("srv-1", "user-1")).rejects.toThrow("boom");

    // Restore and retry — lock must not be held.
    (dbMod.db as unknown as { select: unknown }).select = orig;
    mockStdout = "TOOL\tgit\tyes";
    const retry = await scan("srv-1", "user-1");
    expect(retry.gitAvailable).toBe(true);
  });
});
