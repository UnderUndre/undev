import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";

// Shared mocks for scenario tests (US3 docker import, US4 re-scan, US5 cancel).
// Mirrors the harness in scanner.test.ts.

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
        const data = cols ? existingApps : [mockServerRow];
        return chain(data);
      }),
    },
  };
});

class MockStream extends EventEmitter {
  stderr = new EventEmitter();
}

let mockStdout = "";
let killCalls = 0;
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
      if (holdStream) pendingEmit = emit;
      else setImmediate(emit);
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

// ── US3 — Docker import ────────────────────────────────────────────────────

describe("US3 — Docker candidate import surface (scanner output shape)", () => {
  it("emits a compose candidate with services from COMPOSE_CONFIG", async () => {
    const { scan } = await import("../../server/services/scanner.js");
    const config = JSON.stringify({
      services: { api: { image: "ghcr.io/x/api:1" }, db: { image: "postgres:16" } },
    });
    const b64 = Buffer.from(config).toString("base64");
    mockStdout = [
      "TOOL\tgit\tyes",
      "TOOL\tdocker\tyes",
      "COMPOSE\t/srv/stack/docker-compose.yml\t",
      `COMPOSE_CONFIG\t/srv/stack/docker-compose.yml\t${b64}`,
    ].join("\n");

    const result = await scan("srv-1", "user-1");
    const compose = result.dockerCandidates.find((c) => c.kind === "compose");
    expect(compose).toBeDefined();
    expect(compose?.name).toBe("stack"); // parent dir
    expect(compose?.path).toBe("/srv/stack/docker-compose.yml");
    const names = compose?.services.map((s) => s.name).sort();
    expect(names).toEqual(["api", "db"]);
  });

  it("folds a running container into the compose candidate's running flag", async () => {
    const { scan } = await import("../../server/services/scanner.js");
    const config = JSON.stringify({
      services: { api: { image: "ghcr.io/x/api:1" } },
    });
    const b64 = Buffer.from(config).toString("base64");
    const container = JSON.stringify({
      Names: "stack-api-1",
      Image: "ghcr.io/x/api:1",
      State: "running",
      Status: "Up 2h",
      Labels: "com.docker.compose.project=stack",
    });
    mockStdout = [
      "TOOL\tdocker\tyes",
      "COMPOSE\t/srv/stack/docker-compose.yml\t",
      `COMPOSE_CONFIG\t/srv/stack/docker-compose.yml\t${b64}`,
      `CONTAINER\t${container}`,
    ].join("\n");

    const result = await scan("srv-1", "user-1");
    const compose = result.dockerCandidates.find((c) => c.kind === "compose");
    expect(compose?.services[0].running).toBe(true);
    // Container should NOT appear as a standalone candidate — it was claimed.
    const standalone = result.dockerCandidates.filter((c) => c.kind === "container");
    expect(standalone).toHaveLength(0);
  });

  it("surfaces unclaimed containers as standalone candidates", async () => {
    const { scan } = await import("../../server/services/scanner.js");
    const container = JSON.stringify({
      Names: "orphan",
      Image: "nginx:1.27",
      State: "running",
      Status: "Up 1d",
      Labels: "",
    });
    mockStdout = [
      "TOOL\tdocker\tyes",
      `CONTAINER\t${container}`,
    ].join("\n");

    const result = await scan("srv-1", "user-1");
    const standalone = result.dockerCandidates.filter((c) => c.kind === "container");
    expect(standalone).toHaveLength(1);
    expect(standalone[0].name).toBe("orphan");
  });
});

// ── US4 — Re-scan ──────────────────────────────────────────────────────────

describe("US4 — Re-scan flips alreadyImported for imported candidates", () => {
  it("first scan shows candidate as fresh, second scan (after import) flags it", async () => {
    const { scan } = await import("../../server/services/scanner.js");
    mockStdout = [
      "TOOL\tgit\tyes",
      "GIT_BRANCH\t/opt/app\tmain",
    ].join("\n");

    const first = await scan("srv-1", "user-1");
    expect(first.gitCandidates[0].alreadyImported).toBe(false);

    // Simulate import between scans.
    existingApps = [{ id: "a1", remotePath: "/opt/app", repoUrl: "" }];

    const second = await scan("srv-1", "user-1");
    expect(second.gitCandidates[0].alreadyImported).toBe(true);
    expect(second.gitCandidates[0].existingApplicationId).toBe("a1");
  });
});

// ── US5 — Cancel ───────────────────────────────────────────────────────────

describe("US5 — Cancel / lock lifecycle", () => {
  it("second scan succeeds after first is cancelled (abort from the lock)", async () => {
    const { scan, getActiveScan } = await import(
      "../../server/services/scanner.js"
    );
    holdStream = true;
    mockStdout = "TOOL\tgit\tyes";

    const first = scan("srv-1", "user-1");
    await new Promise((r) => setImmediate(r));
    expect(getActiveScan("srv-1")?.userId).toBe("user-1");

    // Abort via the lock entry (what req.on("close") would trigger).
    getActiveScan("srv-1")?.abort();

    // The aborted first call resolves when kill() fires stream close.
    const firstResult = await first;
    expect(firstResult).toBeDefined();

    // Lock is released → second user can scan.
    holdStream = false;
    const second = await scan("srv-1", "user-2");
    expect(second.gitAvailable).toBe(true);
  });

  it("kill() is invoked when abort() is called during a held scan", async () => {
    const { scan, getActiveScan } = await import(
      "../../server/services/scanner.js"
    );
    holdStream = true;
    mockStdout = "TOOL\tgit\tyes";
    const initialKills = killCalls;

    const p = scan("srv-1", "user-1");
    await new Promise((r) => setImmediate(r));
    getActiveScan("srv-1")?.abort();
    await p;

    expect(killCalls).toBeGreaterThan(initialKills);
  });
});
