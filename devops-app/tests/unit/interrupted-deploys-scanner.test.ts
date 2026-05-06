import { describe, it, expect, vi } from "vitest";

// Mock the db module so importing the scanner does not require DATABASE_URL.
vi.mock("../../server/db/index.js", () => ({
  db: {
    select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }),
  },
}));

const { interruptedDeploysCache } = await import(
  "../../server/services/interrupted-deploys-scanner.js"
);

describe("interruptedDeploysCache", () => {
  it("starts empty", () => {
    interruptedDeploysCache.set([]);
    expect(interruptedDeploysCache.get()).toEqual([]);
  });

  it("set + get round-trips rows", () => {
    interruptedDeploysCache.set([
      {
        appId: "a1",
        appName: "demo",
        serverId: "s1",
        serverLabel: "srv1",
        lastPhase: "OUTGOING_DRAINING",
        lastPhaseStartedAt: "2026-05-05T00:00:00Z",
        activeColor: "blue",
        candidate: { name: "api-green", state: "running" },
        outgoing: { name: "api-blue", state: "running" },
      },
    ]);
    expect(interruptedDeploysCache.get()).toHaveLength(1);
    expect(interruptedDeploysCache.get()[0]?.lastPhase).toBe("OUTGOING_DRAINING");
  });

  it("removeForApp drops the matching row", () => {
    interruptedDeploysCache.set([
      {
        appId: "a1",
        appName: "demo",
        serverId: "s1",
        serverLabel: "srv1",
        lastPhase: "OUTGOING_DRAINING",
        lastPhaseStartedAt: "",
        activeColor: "blue",
        candidate: { name: "api-green", state: "running" },
        outgoing: { name: "api-blue", state: "running" },
      },
    ]);
    interruptedDeploysCache.removeForApp("a1");
    expect(interruptedDeploysCache.get()).toEqual([]);
  });
});
