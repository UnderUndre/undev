/**
 * SC-002 performance benchmark — synthesises 200 git candidates in the
 * scanner's mocked SSH output pipeline and asserts the orchestration side
 * finishes under 15 s. This exercises the Node-side parse + dedup, which is
 * the realistic upper bound once SSH I/O is removed.
 *
 * Gated by `PERF=1` so it doesn't run on every CI push.
 *
 * To run locally:
 *   PERF=1 npx vitest run --root=. tests/integration/scan-perf.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";

const suite = process.env.PERF === "1" ? describe : describe.skip;

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
  scanRoots: ["/opt", "/srv", "/var/www", "/home"],
  createdAt: "2026-04-20T00:00:00Z",
};

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
      select: vi.fn((cols?: unknown) => chain(cols ? [] : [mockServerRow])),
    },
  };
});

class MockStream extends EventEmitter {
  stderr = new EventEmitter();
}

let mockStdout = "";

vi.mock("../../server/services/ssh-pool.js", () => ({
  sshPool: {
    connect: vi.fn().mockResolvedValue(undefined),
    execStream: vi.fn().mockImplementation(async () => {
      const stream = new MockStream();
      setImmediate(() => {
        if (mockStdout) stream.emit("data", Buffer.from(mockStdout));
        stream.emit("close");
      });
      return { stream, kill: vi.fn() };
    }),
  },
}));

beforeEach(() => {
  mockStdout = "";
});

afterEach(async () => {
  const { __resetScanLocks } = await import("../../server/services/scanner.js");
  __resetScanLocks();
});

suite("SC-002 performance benchmark (PERF=1)", () => {
  it("processes 200 git candidates + 10 compose files in under 15s", async () => {
    const { scan } = await import("../../server/services/scanner.js");

    const lines: string[] = ["TOOL\tgit\tyes", "TOOL\tdocker\tyes"];
    for (let i = 0; i < 200; i++) {
      const path = `/opt/repo${i}`;
      lines.push(`GIT_BRANCH\t${path}\tmain`);
      lines.push(`GIT_SHA\t${path}\t${"a".repeat(40)}`);
      lines.push(`GIT_REMOTE\t${path}\tgit@github.com:acme/r${i}.git`);
    }
    for (let i = 0; i < 10; i++) {
      lines.push(`COMPOSE\t/srv/stack${i}/docker-compose.yml\t`);
    }
    mockStdout = lines.join("\n");

    const t0 = Date.now();
    const result = await scan("srv-1", "user-1");
    const elapsed = Date.now() - t0;

    expect(result.partial).toBe(false);
    expect(result.gitCandidates).toHaveLength(200);
    expect(result.dockerCandidates.length).toBeGreaterThanOrEqual(10);
    expect(elapsed).toBeLessThan(15_000);

    // Log so regressions surface in CI output when PERF=1 is set.
    console.log(`[perf] scan(200 git + 10 compose) = ${elapsed}ms`);
  });
});
