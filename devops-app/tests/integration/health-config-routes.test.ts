/**
 * Feature 006 T044 — integration test for the US4 health config + Check Now
 * routes (T037 / T038 / T039 / T055). Mounts the real `appHealthRouter` and
 * `appsRouter` on an Express test app with mocked db, ssrf-guard, and
 * appHealthPoller.
 */
import express, { type Express } from "express";
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Stateful db mock ─────────────────────────────────────────────────────
type Row = Record<string, unknown>;
const state: { app: Row | null; locks: Row[] } = { app: null, locks: [] };
const updates: Row[] = [];

vi.mock("../../server/db/index.js", () => ({
  db: {
    insert: vi.fn(() => ({
      values: vi.fn((v: Row) => ({
        returning: vi.fn(async () => [v]),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn((v: Row) => ({
        where: vi.fn(() => ({
          returning: vi.fn(async () => {
            updates.push(v);
            if (state.app !== null) state.app = { ...state.app, ...v };
            return state.app !== null ? [state.app] : [];
          }),
        })),
      })),
    })),
    select: vi.fn((proj?: unknown) => {
      void proj;
      return {
        from: vi.fn((tbl: { _?: { name?: string } }) => {
          // Best-effort table-name detection from drizzle table object.
          const name =
            (tbl as { _?: { name?: string } } | undefined)?._?.name ?? "";
          if (name === "deploy_locks") {
            return {
              where: vi.fn(() => ({
                limit: vi.fn(async () => state.locks),
              })),
            };
          }
          return {
            where: vi.fn(() => ({
              limit: vi.fn(async () => (state.app !== null ? [state.app] : [])),
              orderBy: vi.fn(() => ({
                limit: vi.fn(async () => []),
              })),
            })),
          };
        }),
      };
    }),
    delete: vi.fn(() => ({
      where: vi.fn(() => ({ returning: vi.fn(async () => []) })),
    })),
  },
}));

// ── Mock ssrf-guard so we don't hit DNS in the test ──────────────────────
vi.mock("../../server/lib/ssrf-guard.js", () => ({
  validateUrlForProbe: vi.fn(async (url: string) => {
    if (url.includes("169.254.169.254") || url.includes("127.0.0.1")) {
      return { ok: false, code: "private_ip", resolvedIps: [] };
    }
    try {
      // eslint-disable-next-line no-new
      new URL(url);
      return { ok: true, resolvedIps: [] };
    } catch {
      return { ok: false, code: "invalid_url", resolvedIps: [] };
    }
  }),
  isBlockedIp: vi.fn(() => false),
}));

// ── Mock the poller so we observe reload + runOutOfCycleProbe calls ──────
const reloadSpy = vi.fn(async () => undefined);
const checkNowSpy = vi.fn(async () => ({
  effective: "healthy" as const,
  outcomes: [],
}));

vi.mock("../../server/services/app-health-poller.js", () => ({
  appHealthPoller: {
    reloadApp: reloadSpy,
    runOutOfCycleProbe: checkNowSpy,
  },
}));

async function makeApp(): Promise<Express> {
  const { appHealthRouter } = await import("../../server/routes/app-health.js");
  const app = express();
  app.use(express.json());
  app.use("/api", appHealthRouter);
  return app;
}

async function call(
  app: Express,
  method: "GET" | "POST" | "PATCH",
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = (server.address() as { port: number }).port;
      const init: RequestInit = {
        method,
        headers: { "Content-Type": "application/json" },
      };
      if (body !== undefined) init.body = JSON.stringify(body);
      void fetch(`http://127.0.0.1:${port}${path}`, init)
        .then(async (res) => {
          const j = (await res.json().catch(() => ({}))) as unknown;
          server.close();
          resolve({ status: res.status, body: j });
        })
        .catch((e) => {
          server.close();
          reject(e);
        });
    });
  });
}

const APP_ID = "11111111-1111-1111-1111-111111111111";

beforeEach(() => {
  updates.length = 0;
  state.app = {
    id: APP_ID,
    monitoringEnabled: true,
    alertsMuted: false,
    healthUrl: null,
    healthProbeIntervalSec: 60,
    healthDebounceCount: 2,
  };
  state.locks = [];
  reloadSpy.mockClear();
  checkNowSpy.mockClear();
});

describe("PATCH /api/applications/:id/health/config (T037)", () => {
  it("updates fields and triggers reloadApp", async () => {
    const app = await makeApp();
    const r = await call(app, "PATCH", `/api/applications/${APP_ID}/health/config`, {
      healthProbeIntervalSec: 30,
      alertsMuted: true,
    });
    expect(r.status).toBe(200);
    expect(updates[0]).toMatchObject({
      healthProbeIntervalSec: 30,
      alertsMuted: true,
    });
    expect(reloadSpy).toHaveBeenCalledWith(APP_ID);
  });

  it("rejects intervalSec < 10 with 400", async () => {
    const app = await makeApp();
    const r = await call(app, "PATCH", `/api/applications/${APP_ID}/health/config`, {
      healthProbeIntervalSec: 5,
    });
    expect(r.status).toBe(400);
  });

  it("rejects SSRF-blocked healthUrl with 400 + health_url_blocked", async () => {
    const app = await makeApp();
    const r = await call(app, "PATCH", `/api/applications/${APP_ID}/health/config`, {
      healthUrl: "http://169.254.169.254/latest/meta-data/",
    });
    expect(r.status).toBe(400);
    expect((r.body as { error: { code: string } }).error.code).toBe(
      "health_url_blocked",
    );
  });

  it("returns 404 for unknown app", async () => {
    state.app = null;
    const app = await makeApp();
    const r = await call(app, "PATCH", `/api/applications/${APP_ID}/health/config`, {
      alertsMuted: false,
    });
    expect(r.status).toBe(404);
  });
});

describe("POST /api/applications/:id/health/check-now (T039)", () => {
  it("returns 202 and calls runOutOfCycleProbe", async () => {
    const app = await makeApp();
    const r = await call(app, "POST", `/api/applications/${APP_ID}/health/check-now`);
    expect(r.status).toBe(202);
    expect((r.body as { expectedWithinSec: number }).expectedWithinSec).toBe(15);
    expect(checkNowSpy).toHaveBeenCalledWith(APP_ID);
  });

  it("returns 409 DEPLOY_IN_PROGRESS when locked", async () => {
    state.locks = [{ appId: APP_ID }];
    const app = await makeApp();
    const r = await call(app, "POST", `/api/applications/${APP_ID}/health/check-now`);
    expect(r.status).toBe(409);
    expect((r.body as { error: { code: string } }).error.code).toBe(
      "DEPLOY_IN_PROGRESS",
    );
    expect(checkNowSpy).not.toHaveBeenCalled();
  });

  it("returns 409 MONITORING_DISABLED when off", async () => {
    state.app = { ...(state.app as Row), monitoringEnabled: false };
    const app = await makeApp();
    const r = await call(app, "POST", `/api/applications/${APP_ID}/health/check-now`);
    expect(r.status).toBe(409);
    expect((r.body as { error: { code: string } }).error.code).toBe(
      "MONITORING_DISABLED",
    );
  });
});

describe("POST /api/applications/health-url/validate (T055)", () => {
  it("returns ok:true for a public URL", async () => {
    const app = await makeApp();
    const r = await call(app, "POST", `/api/applications/health-url/validate`, {
      url: "https://example.com/health",
    });
    expect(r.status).toBe(200);
    expect((r.body as { ok: boolean }).ok).toBe(true);
  });

  it("returns ok:false private_ip for IMDS address", async () => {
    const app = await makeApp();
    const r = await call(app, "POST", `/api/applications/health-url/validate`, {
      url: "http://169.254.169.254/latest/",
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: false, code: "private_ip" });
  });

  it("rate-limits at 11th call within a second", async () => {
    const app = await makeApp();
    let last = 200;
    for (let i = 0; i < 11; i++) {
      const r = await call(app, "POST", `/api/applications/health-url/validate`, {
        url: "https://example.com/health",
      });
      last = r.status;
    }
    expect(last).toBe(429);
  });
});
