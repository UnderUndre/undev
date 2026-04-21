/**
 * Feature 005 T044: runs API pagination + filtering + archived detection.
 *
 * Mocks the DB layer — we assert the route computes the archived flag from
 * the manifest cache rather than exercising postgres.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockRows: Record<string, unknown>[] = [];

vi.mock("../../server/db/index.js", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn((cond?: unknown) => ({
          orderBy: vi.fn(() => ({
            limit: vi.fn(() => ({
              offset: vi.fn(async () => mockRows),
            })),
          })),
          limit: vi.fn(async () => mockRows.slice(0, 1)),
        })),
        orderBy: vi.fn(() => ({
          limit: vi.fn(() => ({
            offset: vi.fn(async () => mockRows),
          })),
        })),
      })),
    })),
  },
}));

vi.mock("../../server/services/scripts-runner.js", () => ({
  scriptsRunner: {
    getManifestDescriptor: () => [
      { id: "db/backup" },
      { id: "deploy/deploy" },
    ],
  },
}));

describe("runs API (feature 005 T044)", () => {
  beforeEach(() => {
    mockRows.length = 0;
  });

  it("flags archived=true for rows whose scriptId is not in manifest", async () => {
    mockRows.push(
      {
        id: "r1",
        scriptId: "db/backup",
        serverId: "srv-A",
        userId: "u",
        status: "success",
        startedAt: "2026-04-22T10:00:00Z",
        finishedAt: "2026-04-22T10:01:00Z",
        duration: 60_000,
      },
      {
        id: "r2",
        scriptId: "db/removed-op",
        serverId: "srv-A",
        userId: "u",
        status: "success",
        startedAt: "2026-04-22T09:00:00Z",
        finishedAt: null,
        duration: null,
      },
    );
    const { runsRouter } = await import("../../server/routes/runs.js");

    // Express handler extraction
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const layer = (runsRouter as any).stack.find(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (l: any) => l.route?.path === "/runs",
    );
    const handler = layer.route.stack[0].handle;
    const req = { query: { limit: 10, offset: 0 } };
    let body: unknown;
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn((b: unknown) => {
        body = b;
      }),
    };
    await handler(req, res, vi.fn());
    expect(body).toBeDefined();
    const runs = (body as { runs: { id: string; archived: boolean }[] }).runs;
    expect(runs[0]).toMatchObject({ id: "r1", archived: false });
    expect(runs[1]).toMatchObject({ id: "r2", archived: true });
  });
});
