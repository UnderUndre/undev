import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";

const dbState = {
  app: {
    id: "app1",
    name: "demo",
    serverId: "s1",
    remotePath: "/opt/demo",
    domain: "demo.example.com",
    upstreamService: "api",
    upstreamPort: 3000,
    activeColor: "blue" as "blue" | "green" | null,
    deployState: "OUTGOING_DRAINING" as string | null,
    deployStateStartedAt: null as string | null,
    drainSeconds: 30,
  },
  audits: [] as string[],
};

vi.mock("../../server/db/index.js", () => {
  const select = vi.fn(() => ({
    from: () => ({
      where: () => ({ limit: () => Promise.resolve([dbState.app]) }),
    }),
  }));
  const update = vi.fn(() => ({
    set: (patch: Record<string, unknown>) => ({
      where: () => {
        Object.assign(dbState.app, patch);
        return Promise.resolve();
      },
    }),
  }));
  const insert = vi.fn(() => ({
    values: (v: Record<string, unknown>) => {
      dbState.audits.push(String(v.action));
      return Promise.resolve();
    },
  }));
  return { db: { select, update, insert } };
});

vi.mock("../../server/services/ssh-pool.js", () => ({
  sshPool: {
    exec: vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 })),
  },
}));

vi.mock("../../server/services/caddy-upstream-switcher.js", () => ({
  caddyUpstreamSwitcher: {
    switchUpstream: vi.fn(async () => ({
      ok: true,
      switchedAt: new Date().toISOString(),
      previousUpstream: "api-blue:3000",
      newUpstream: "api-green:3000",
    })),
  },
}));

vi.mock("../../server/services/drain-timer.js", () => ({
  drainTimer: {
    start: vi.fn(),
    cancel: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    getRemainingMs: vi.fn(() => 12_000),
  },
}));

vi.mock("../../server/lib/compose-override-generator.js", () => ({
  generateOverride: () => "",
  writeOverride: async () => {},
  deleteOverride: async () => {},
  overridePath: () => "/opt/demo/.dashboard/x.yml",
}));

vi.mock("../../server/services/blue-green-orchestrator.js", () => ({
  blueGreenOrchestrator: {
    startDeploy: vi.fn(async () => ({ ok: true, deployId: "d1" })),
  },
}));

const { blueGreenRouter } = await import("../../server/routes/blue-green.js");
const { interruptedDeploysCache } = await import(
  "../../server/services/interrupted-deploys-scanner.js"
);

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/api", blueGreenRouter);
  return app;
}

async function postJson(
  app: ReturnType<typeof makeApp>,
  path: string,
  body: unknown,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close();
        resolve({ status: 0, body: null });
        return;
      }
      const port = addr.port;
      fetch(`http://127.0.0.1:${port}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
        .then(async (r) => ({ status: r.status, body: await r.json() }))
        .then((out) => {
          server.close();
          resolve(out);
        })
        .catch(() => {
          server.close();
          resolve({ status: 0, body: null });
        });
    });
  });
}

async function getJson(
  app: ReturnType<typeof makeApp>,
  path: string,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close();
        resolve({ status: 0, body: null });
        return;
      }
      const port = addr.port;
      fetch(`http://127.0.0.1:${port}${path}`)
        .then(async (r) => ({ status: r.status, body: await r.json() }))
        .then((out) => {
          server.close();
          resolve(out);
        })
        .catch(() => {
          server.close();
          resolve({ status: 0, body: null });
        });
    });
  });
}

describe("blue-green routes", () => {
  beforeEach(() => {
    dbState.app.deployState = "OUTGOING_DRAINING";
    dbState.app.activeColor = "blue";
    dbState.audits.length = 0;
    interruptedDeploysCache.set([]);
  });

  it("abort: typed_confirmation_mismatch returns 400", async () => {
    const app = makeApp();
    const r = await postJson(app, "/api/applications/app1/blue-green/abort", {
      confirmAppName: "wrong",
    });
    expect(r.status).toBe(400);
    expect((r.body as { error: { code: string } }).error.code).toBe(
      "typed_confirmation_mismatch",
    );
  });

  it("abort: happy path returns 200 and emits deploy.aborted", async () => {
    const app = makeApp();
    const r = await postJson(app, "/api/applications/app1/blue-green/abort", {
      confirmAppName: "demo",
    });
    expect(r.status).toBe(200);
    expect(dbState.audits).toContain("deploy.aborted");
  });

  it("abort: 409 when deploy_state is idle (too_late_to_abort)", async () => {
    dbState.app.deployState = null;
    const app = makeApp();
    const r = await postJson(app, "/api/applications/app1/blue-green/abort", {
      confirmAppName: "demo",
    });
    expect(r.status).toBe(409);
    expect((r.body as { error: { code: string } }).error.code).toBe(
      "too_late_to_abort",
    );
    expect(dbState.audits).toContain("deploy.too_late_to_abort");
  });

  it("recover-caddy/mark-recovered: typed_confirmation_mismatch returns 400", async () => {
    dbState.app.deployState = "FAILED_CADDY_ADMIN_POST_SWITCH";
    const app = makeApp();
    const r = await postJson(
      app,
      "/api/applications/app1/blue-green/recover-caddy/mark-recovered",
      { confirmAppName: "wrong" },
    );
    expect(r.status).toBe(400);
  });

  it("recover-caddy/mark-recovered: happy path 200", async () => {
    dbState.app.deployState = "FAILED_CADDY_ADMIN_POST_SWITCH";
    const app = makeApp();
    const r = await postJson(
      app,
      "/api/applications/app1/blue-green/recover-caddy/mark-recovered",
      { confirmAppName: "demo" },
    );
    expect(r.status).toBe(200);
    expect(dbState.audits).toContain(
      "deploy.caddy_admin_marked_recovered_by_operator",
    );
  });

  it("interrupted/abort-cleanup: clears deploy_state and emits audit", async () => {
    const app = makeApp();
    const r = await postJson(
      app,
      "/api/applications/app1/blue-green/interrupted/abort-cleanup",
      { confirmAppName: "demo" },
    );
    expect(r.status).toBe(200);
    expect((r.body as { ok: boolean }).ok).toBe(true);
    expect(dbState.app.deployState).toBeNull();
    expect(dbState.audits).toContain("deploy.interrupted_aborted_cleanup");
  });

  it("interrupted/mark-complete: sets active_color and clears state", async () => {
    const app = makeApp();
    const r = await postJson(
      app,
      "/api/applications/app1/blue-green/interrupted/mark-complete",
      { confirmAppName: "demo", finalActiveColor: "green" },
    );
    expect(r.status).toBe(200);
    expect(dbState.app.activeColor).toBe("green");
    expect(dbState.app.deployState).toBeNull();
    expect(dbState.audits).toContain(
      "deploy.interrupted_marked_complete_by_operator",
    );
  });

  it("GET interrupted-deploys returns cache contents", async () => {
    interruptedDeploysCache.set([
      {
        appId: "x",
        appName: "n",
        serverId: "s",
        serverLabel: "lbl",
        lastPhase: "OUTGOING_DRAINING",
        lastPhaseStartedAt: "",
        activeColor: "blue",
        candidate: { name: "api-green", state: "running" },
        outgoing: { name: "api-blue", state: "running" },
      },
    ]);
    const app = makeApp();
    const r = await getJson(app, "/api/applications/interrupted-deploys");
    expect(r.status).toBe(200);
    expect((r.body as { rows: unknown[] }).rows).toHaveLength(1);
  });
});
