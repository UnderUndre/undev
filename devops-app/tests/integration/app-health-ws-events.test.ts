/**
 * Feature 006 T020 — WS broadcast contract for the health subsystem.
 *
 * Asserts that `commitState` (state-machine commit, debounce-satisfied) emits:
 *   1. `app-health:<appId>` with `type: "health-changed"`
 *   2. `server-apps-health:<serverId>` with `type: "app-health-changed"`
 *
 * Per-probe `probe-completed` events are wired in `runOnce()` and exercised
 * by the existing poller integration suite — here we cover the commit path
 * end-to-end against mocked DB + notifier.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const broadcastMock = vi.fn();

vi.mock("../../server/db/index.js", () => {
  // Drizzle update().set().where() is fluent; both insert and update return
  // thenables so the poller's `await db.update(...)...` chain resolves.
  const fluent = (): Record<string, unknown> => {
    const proxy: Record<string, unknown> = {};
    const methods = ["set", "where", "values", "from", "returning", "limit"];
    for (const m of methods) {
      proxy[m] = vi.fn(() => proxy);
    }
    proxy.then = (resolve: (v: unknown) => void) => resolve([]);
    return proxy;
  };
  return {
    db: {
      select: vi.fn(() => fluent()),
      update: vi.fn(() => fluent()),
      insert: vi.fn(() => fluent()),
      delete: vi.fn(() => fluent()),
    },
    client: () => Promise.resolve([]),
  };
});

vi.mock("../../server/ws/channels.js", () => ({
  channelManager: { broadcast: broadcastMock },
}));

vi.mock("../../server/services/notifier.js", () => ({
  notifier: {
    notifyAppHealthChange: vi.fn(async () => true),
    notifyCaddyUnreachable: vi.fn(async () => true),
    notifyCaddyRecovered: vi.fn(async () => true),
    notifyCertExpiring: vi.fn(async () => true),
  },
}));

interface AppRowLike {
  id: string;
  serverId: string;
  name: string;
  healthStatus: string;
  healthLastChangeAt: string | null;
  healthDebounceCount: number;
  alertsMuted: boolean;
  healthUrl: string | null;
  remotePath: string;
  healthProbeIntervalSec: number;
}

function appRow(over: Partial<AppRowLike> = {}): AppRowLike {
  return {
    id: "app-1",
    serverId: "srv-1",
    name: "demo",
    healthStatus: "healthy",
    healthLastChangeAt: "2026-04-28T11:00:00.000Z",
    healthDebounceCount: 2,
    alertsMuted: false,
    healthUrl: null,
    remotePath: "/opt/demo",
    healthProbeIntervalSec: 60,
    ...over,
  };
}

function makePollState(appId: string): {
  appId: string;
  intervalMs: number;
  isPolling: boolean;
  timer: null;
  consecutive: { healthy: number; unhealthy: number; unknown: number };
} {
  return {
    appId,
    intervalMs: 60_000,
    isPolling: false,
    timer: null,
    consecutive: { healthy: 0, unhealthy: 0, unknown: 0 },
  };
}

describe("feature 006 T020 — WS broadcast on commitState", () => {
  beforeEach(() => {
    broadcastMock.mockReset();
  });

  it("emits app-health:<appId> health-changed AND server-apps-health:<serverId> on healthy→unhealthy commit", async () => {
    const { commitState } = await import(
      "../../server/services/app-health-poller.js"
    );
    const app = appRow({ healthStatus: "healthy" });
    const state = makePollState(app.id);

    // First unhealthy tick — below debounce, no broadcast.
    await commitState(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      app as any,
      state,
      "unhealthy",
      {
        outcome: "unhealthy",
        probeType: "container",
        latencyMs: 5,
        statusCode: null,
        containerStatus: "unhealthy",
        errorMessage: "container down",
      },
      null,
      {
        loadServer: async () => ({ id: "srv-1", label: "S1" }) as unknown as never,
        buildDeepLink: () => "http://x/apps/app-1",
      },
    );
    const broadcastsAfterFirst = broadcastMock.mock.calls.length;

    // Second unhealthy tick — debounce satisfied, both channels fire.
    await commitState(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      app as any,
      state,
      "unhealthy",
      {
        outcome: "unhealthy",
        probeType: "container",
        latencyMs: 5,
        statusCode: null,
        containerStatus: "unhealthy",
        errorMessage: "container down",
      },
      null,
      {
        loadServer: async () => ({ id: "srv-1", label: "S1" }) as unknown as never,
        buildDeepLink: () => "http://x/apps/app-1",
      },
    );

    const channels = broadcastMock.mock.calls
      .slice(broadcastsAfterFirst)
      .map((c) => c[0] as string);
    expect(channels).toContain(`app-health:${app.id}`);
    expect(channels).toContain(`server-apps-health:${app.serverId}`);

    const appHealthCall = broadcastMock.mock.calls.find(
      (c) => c[0] === `app-health:${app.id}`,
    );
    expect(appHealthCall).toBeDefined();
    const payload = appHealthCall![1] as { type: string; data: unknown };
    expect(payload.type).toBe("health-changed");
  });

  it("FR-018 — broadcasts WS even when alertsMuted=true (mute filters Telegram only)", async () => {
    const { commitState } = await import(
      "../../server/services/app-health-poller.js"
    );
    const app = appRow({ healthStatus: "healthy", alertsMuted: true });
    const state = makePollState(app.id);
    const o = {
      outcome: "unhealthy" as const,
      probeType: "container" as const,
      latencyMs: 5,
      statusCode: null,
      containerStatus: "unhealthy",
      errorMessage: "down",
    };
    await commitState(app as never, state, "unhealthy", o, null);
    await commitState(app as never, state, "unhealthy", o, null);
    const channels = broadcastMock.mock.calls.map((c) => c[0] as string);
    expect(channels).toContain(`app-health:${app.id}`);
    expect(channels).toContain(`server-apps-health:${app.serverId}`);
  });
});
