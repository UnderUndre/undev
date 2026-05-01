/**
 * Feature 006 T028 — health alert pipeline integration test.
 *
 * Exercises `commitState` end-to-end with mocked db + notifier, asserting:
 *   (a) healthy → unhealthy after debounce fires `notifyAppHealthChange("to-unhealthy")` once
 *   (b) unhealthy → healthy fires "to-healthy" with downtimeMs ≈ now - prevHealthLastChangeAt
 *   (c) unknown → healthy is silent (FR-008)
 *   (d) flapping below debounce does NOT fire
 *   (e) alertsMuted=true — notifier NOT called BUT WS broadcast still happened AND status UPDATE happened (FR-018)
 *   (f) notifier throw caught at warn level — probe loop continues (FR-017)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock db before importing SUT ──────────────────────────────────────────
const updates: Array<{ set: Record<string, unknown> }> = [];
const selectResults: Record<string, unknown[]> = { servers: [] };

vi.mock("../../server/db/index.js", () => {
  const update = vi.fn(() => ({
    set: vi.fn((vals: Record<string, unknown>) => {
      updates.push({ set: vals });
      return { where: vi.fn(async () => undefined) };
    }),
  }));
  const select = vi.fn(() => ({
    from: vi.fn((tbl: { _: { name?: string } } | unknown) => ({
      where: vi.fn(async () => selectResults.servers),
    })),
  }));
  const insert = vi.fn(() => ({ values: vi.fn(async () => undefined) }));
  const del = vi.fn(() => ({
    where: vi.fn(() => ({ returning: vi.fn(async () => []) })),
  }));
  return {
    db: { update, select, insert, delete: del },
    client: vi.fn(),
  };
});

// ── Spy on notifier + channelManager ──────────────────────────────────────
const notifySpy = vi.fn(async () => true);
let notifyShouldThrow = false;

vi.mock("../../server/services/notifier.js", () => ({
  notifier: {
    notifyAppHealthChange: vi.fn(async (payload: unknown) => {
      if (notifyShouldThrow) throw new Error("telegram dead");
      return notifySpy(payload);
    }),
    notifyCaddyUnreachable: vi.fn(async () => true),
    notifyCaddyRecovered: vi.fn(async () => true),
    notifyCertExpiring: vi.fn(async () => true),
  },
}));

const broadcastSpy = vi.fn();
vi.mock("../../server/ws/channels.js", () => ({
  channelManager: { broadcast: broadcastSpy },
}));

// ── Helpers ───────────────────────────────────────────────────────────────
type AppRow = {
  id: string;
  serverId: string;
  name: string;
  remotePath: string;
  healthUrl: string | null;
  healthStatus: string;
  healthLastChangeAt: string | null;
  healthDebounceCount: number;
  alertsMuted: boolean;
  monitoringEnabled: boolean;
  healthProbeIntervalSec: number;
};

function makeApp(overrides: Partial<AppRow> = {}): AppRow {
  return {
    id: "app-1",
    serverId: "srv-1",
    name: "myapp",
    remotePath: "/srv/myapp",
    healthUrl: null,
    healthStatus: "unknown",
    healthLastChangeAt: null,
    healthDebounceCount: 2,
    alertsMuted: false,
    monitoringEnabled: true,
    healthProbeIntervalSec: 60,
    ...overrides,
  };
}

function makeOutcome(o: "healthy" | "unhealthy"): {
  probeType: "container";
  outcome: "healthy" | "unhealthy";
  latencyMs: number | null;
  statusCode: number | null;
  errorMessage: string | null;
  containerStatus: string | null;
} {
  return {
    probeType: "container",
    outcome: o,
    latencyMs: 10,
    statusCode: null,
    errorMessage: o === "unhealthy" ? "container died" : null,
    containerStatus: o,
  };
}

function makeState(): {
  appId: string;
  intervalMs: number;
  isPolling: boolean;
  timer: null;
  consecutive: { healthy: number; unhealthy: number; unknown: number };
} {
  return {
    appId: "app-1",
    intervalMs: 60_000,
    isPolling: false,
    timer: null,
    consecutive: { healthy: 0, unhealthy: 0, unknown: 0 },
  };
}

describe("health alert pipeline (feature 006 T028)", () => {
  beforeEach(() => {
    updates.length = 0;
    selectResults.servers = [{ id: "srv-1", label: "prod" }];
    notifySpy.mockClear();
    broadcastSpy.mockClear();
    notifyShouldThrow = false;
  });

  it("(a) healthy → unhealthy after debounce fires notifyAppHealthChange('to-unhealthy') once", async () => {
    const { commitState } = await import("../../server/services/app-health-poller.js");
    const app = makeApp({ healthStatus: "healthy", healthLastChangeAt: new Date().toISOString() });
    const state = makeState();
    const c1 = makeOutcome("unhealthy");
    // First unhealthy — counter=1, below debounce(2): no commit
    await commitState(app, state, "unhealthy", c1, null);
    expect(notifySpy).not.toHaveBeenCalled();
    // Second unhealthy — commits + alert
    await commitState(app, state, "unhealthy", c1, null);
    expect(notifySpy).toHaveBeenCalledTimes(1);
    const payload = notifySpy.mock.calls[0]?.[0] as { transition: string; appName: string };
    expect(payload.transition).toBe("to-unhealthy");
    expect(payload.appName).toBe("myapp");
  });

  it("(b) unhealthy → healthy fires 'to-healthy' with downtimeMs", async () => {
    const { commitState } = await import("../../server/services/app-health-poller.js");
    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const app = makeApp({ healthStatus: "unhealthy", healthLastChangeAt: tenMinAgo });
    const state = makeState();
    const ok = makeOutcome("healthy");
    await commitState(app, state, "healthy", ok, null);
    await commitState(app, state, "healthy", ok, null);
    expect(notifySpy).toHaveBeenCalledTimes(1);
    const payload = notifySpy.mock.calls[0]?.[0] as {
      transition: string;
      downtimeMs?: number;
    };
    expect(payload.transition).toBe("to-healthy");
    expect(payload.downtimeMs).toBeDefined();
    expect(payload.downtimeMs!).toBeGreaterThanOrEqual(10 * 60 * 1000 - 5_000);
    expect(payload.downtimeMs!).toBeLessThanOrEqual(10 * 60 * 1000 + 5_000);
  });

  it("(c) unknown → healthy is silent per FR-008", async () => {
    const { commitState } = await import("../../server/services/app-health-poller.js");
    const app = makeApp({ healthStatus: "unknown" });
    const state = makeState();
    const ok = makeOutcome("healthy");
    await commitState(app, state, "healthy", ok, null);
    await commitState(app, state, "healthy", ok, null);
    expect(notifySpy).not.toHaveBeenCalled();
  });

  it("(d) flapping below debounce does NOT fire", async () => {
    const { commitState } = await import("../../server/services/app-health-poller.js");
    const app = makeApp({ healthStatus: "healthy", healthLastChangeAt: new Date().toISOString() });
    const state = makeState();
    // healthy → 1 unhealthy → 1 healthy → 1 unhealthy: no debounce ever clears
    await commitState(app, state, "unhealthy", makeOutcome("unhealthy"), null);
    await commitState(app, state, "healthy", makeOutcome("healthy"), null);
    await commitState(app, state, "unhealthy", makeOutcome("unhealthy"), null);
    expect(notifySpy).not.toHaveBeenCalled();
  });

  it("(e) alertsMuted=true skips Telegram BUT broadcasts WS AND writes status (FR-018)", async () => {
    const { commitState } = await import("../../server/services/app-health-poller.js");
    const app = makeApp({
      healthStatus: "healthy",
      healthLastChangeAt: new Date().toISOString(),
      alertsMuted: true,
    });
    const state = makeState();
    const bad = makeOutcome("unhealthy");
    await commitState(app, state, "unhealthy", bad, null);
    await commitState(app, state, "unhealthy", bad, null);

    // Telegram suppressed
    expect(notifySpy).not.toHaveBeenCalled();
    // WS broadcast still fired
    const channels = broadcastSpy.mock.calls.map((c) => c[0]);
    expect(channels).toContain("app-health:app-1");
    expect(channels).toContain("server-apps-health:srv-1");
    // status UPDATE still happened — at least one update set healthStatus to unhealthy
    const setHealthUnhealthy = updates.some(
      (u) => u.set["healthStatus"] === "unhealthy",
    );
    expect(setHealthUnhealthy).toBe(true);
  });

  it("(f) notifier throw is caught at warn — loop continues (FR-017)", async () => {
    const { commitState } = await import("../../server/services/app-health-poller.js");
    notifyShouldThrow = true;
    const app = makeApp({ healthStatus: "healthy", healthLastChangeAt: new Date().toISOString() });
    const state = makeState();
    const bad = makeOutcome("unhealthy");
    await expect(commitState(app, state, "unhealthy", bad, null)).resolves.toBeUndefined();
    await expect(commitState(app, state, "unhealthy", bad, null)).resolves.toBeUndefined();
    // status UPDATE still committed despite notifier failure
    expect(updates.some((u) => u.set["healthStatus"] === "unhealthy")).toBe(true);
  });
});
