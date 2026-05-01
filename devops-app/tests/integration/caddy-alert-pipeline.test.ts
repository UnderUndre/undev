/**
 * Feature 006 T030 — Caddy alert pipeline integration test.
 *
 * Drives the per-server Caddy tick via fake timers + mocked probe runner,
 * asserting:
 *   (a) 2 consecutive caddy_admin unhealthy → notifier.notifyCaddyUnreachable + WS event
 *   (b) recovery 2 consecutive healthy → notifier.notifyCaddyRecovered + WS event
 *   (c) cross-spec invariant — caddy unhealthy commit publishes a WS event
 *       that feature 008's reconciler can subscribe to in order to mark
 *       app_certs.status = 'pending_reconcile'. We assert the event surface
 *       (channel name + type) — the marking itself is feature 008.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const probeQueue: Array<{
  outcome: "healthy" | "unhealthy" | "error";
  errorMessage: string | null;
  statusCode: number | null;
}> = [];

vi.mock("../../server/services/probes/caddy-admin.js", () => ({
  runCaddyAdminProbe: vi.fn(async () => {
    const next = probeQueue.shift() ?? {
      outcome: "healthy" as const,
      errorMessage: null,
      statusCode: 200,
    };
    return {
      probeType: "caddy_admin",
      outcome: next.outcome,
      latencyMs: 5,
      statusCode: next.statusCode,
      errorMessage: next.errorMessage,
      containerStatus: null,
    };
  }),
}));

const insertedRows: unknown[] = [];

vi.mock("../../server/db/index.js", () => {
  const select = vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn(async () => [
        // server row for caddy tick
        { id: "srv-1", label: "prod" },
      ]),
    })),
  }));
  const insert = vi.fn(() => ({
    values: vi.fn(async (rows: unknown) => {
      insertedRows.push(rows);
    }),
  }));
  const update = vi.fn(() => ({
    set: vi.fn(() => ({ where: vi.fn(async () => undefined) })),
  }));
  const del = vi.fn(() => ({
    where: vi.fn(() => ({ returning: vi.fn(async () => []) })),
  }));
  return {
    db: { select, insert, update, delete: del },
    client: vi.fn(async () => [{ server_id: "srv-1" }]),
  };
});

const caddyUnreachableSpy = vi.fn(async () => true);
const caddyRecoveredSpy = vi.fn(async () => true);

vi.mock("../../server/services/notifier.js", () => ({
  notifier: {
    notifyAppHealthChange: vi.fn(async () => true),
    notifyCaddyUnreachable: caddyUnreachableSpy,
    notifyCaddyRecovered: caddyRecoveredSpy,
    notifyCertExpiring: vi.fn(async () => true),
  },
}));

const broadcastSpy = vi.fn();
vi.mock("../../server/ws/channels.js", () => ({
  channelManager: { broadcast: broadcastSpy },
}));

// Helper: advance fake timers + flush microtasks the tick chain awaits.
async function flushTick(): Promise<void> {
  await vi.advanceTimersByTimeAsync(60_000);
  // Allow chained promises (db awaits, notifier awaits) to settle.
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe("caddy alert pipeline (feature 006 T030)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    probeQueue.length = 0;
    insertedRows.length = 0;
    caddyUnreachableSpy.mockClear();
    caddyRecoveredSpy.mockClear();
    broadcastSpy.mockClear();
    vi.resetModules();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("(a) 2 consecutive unhealthy fires notifyCaddyUnreachable + WS event", async () => {
    probeQueue.push(
      { outcome: "unhealthy", errorMessage: "500", statusCode: 500 },
      { outcome: "unhealthy", errorMessage: "500", statusCode: 500 },
    );
    const { _AppHealthPollerCtor } = await import(
      "../../server/services/app-health-poller.js"
    );
    const poller = new _AppHealthPollerCtor();
    // Skip start(); manually schedule one server's caddy cycle.
    // Use a thin reflection to invoke the private scheduler — we only need
    // the caddy tick. start() also schedules app polls, which we don't care
    // about for this test.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (poller as any).scheduleCaddyCycle("srv-1");

    await flushTick(); // first unhealthy probe
    expect(caddyUnreachableSpy).not.toHaveBeenCalled();
    await flushTick(); // second unhealthy → commit
    expect(caddyUnreachableSpy).toHaveBeenCalledTimes(1);

    const channels = broadcastSpy.mock.calls.map((c) => c[0]);
    expect(channels).toContain("server-caddy:srv-1");
    poller.stop();
  });

  it("(b) recovery fires notifyCaddyRecovered + WS event with downtimeMs", async () => {
    probeQueue.push(
      { outcome: "unhealthy", errorMessage: null, statusCode: 500 },
      { outcome: "unhealthy", errorMessage: null, statusCode: 500 },
      { outcome: "healthy", errorMessage: null, statusCode: 200 },
      { outcome: "healthy", errorMessage: null, statusCode: 200 },
    );
    const { _AppHealthPollerCtor } = await import(
      "../../server/services/app-health-poller.js"
    );
    const poller = new _AppHealthPollerCtor();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (poller as any).scheduleCaddyCycle("srv-1");

    await flushTick();
    await flushTick(); // commit unhealthy
    expect(caddyUnreachableSpy).toHaveBeenCalledTimes(1);
    await flushTick();
    await flushTick(); // commit healthy
    expect(caddyRecoveredSpy).toHaveBeenCalledTimes(1);
    const recoverPayload = caddyRecoveredSpy.mock.calls[0]?.[0] as {
      downtimeMs: number;
    };
    expect(typeof recoverPayload.downtimeMs).toBe("number");
    expect(recoverPayload.downtimeMs).toBeGreaterThanOrEqual(0);

    const recoveredEvents = broadcastSpy.mock.calls.filter(
      (c) =>
        c[0] === "server-caddy:srv-1" &&
        (c[1] as { type: string }).type === "caddy-recovered",
    );
    expect(recoveredEvents).toHaveLength(1);
    poller.stop();
  });

  it("(c) cross-spec invariant — caddy-unreachable WS event surfaces for feature 008's reconciler", async () => {
    probeQueue.push(
      { outcome: "unhealthy", errorMessage: null, statusCode: 503 },
      { outcome: "unhealthy", errorMessage: null, statusCode: 503 },
    );
    const { _AppHealthPollerCtor } = await import(
      "../../server/services/app-health-poller.js"
    );
    const poller = new _AppHealthPollerCtor();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (poller as any).scheduleCaddyCycle("srv-1");

    await flushTick();
    await flushTick();

    // Feature 008's reconciler subscribes to `server-caddy:<serverId>` and
    // reacts to the `caddy-unreachable` event by marking app_certs as
    // pending_reconcile. We assert the surface contract: exactly one such
    // event was emitted on the documented channel with the documented type.
    const unreachable = broadcastSpy.mock.calls.filter(
      (c) =>
        c[0] === "server-caddy:srv-1" &&
        (c[1] as { type: string }).type === "caddy-unreachable",
    );
    expect(unreachable).toHaveLength(1);
    const payload = unreachable[0]?.[1] as { data: { serverId: string } };
    expect(payload.data.serverId).toBe("srv-1");
    poller.stop();
  });
});
