/**
 * Feature 007 T018: integration test for /api/apps scriptPath normalisation.
 *
 * Mounts the appsRouter on an Express test app with a mocked db so we exercise
 * the real Zod schema + the real validateScriptPath wiring without postgres.
 */

import express, { type Express } from "express";
import { describe, it, expect, vi, beforeEach } from "vitest";

const dbInsertedRows: Record<string, unknown>[] = [];
const dbUpdatedRows: Record<string, unknown>[] = [];

vi.mock("../../server/db/index.js", () => ({
  db: {
    insert: vi.fn(() => ({
      values: vi.fn((v: Record<string, unknown>) => ({
        returning: vi.fn(async () => {
          dbInsertedRows.push(v);
          return [v];
        }),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn((v: Record<string, unknown>) => ({
        where: vi.fn(() => ({
          returning: vi.fn(async () => {
            dbUpdatedRows.push(v);
            return [{ id: "app-1", ...v }];
          }),
        })),
      })),
    })),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => []),
        })),
      })),
    })),
    delete: vi.fn(() => ({
      where: vi.fn(() => ({
        returning: vi.fn(async () => [{ id: "app-1" }]),
      })),
    })),
  },
}));

async function makeApp(): Promise<Express> {
  const { appsRouter } = await import("../../server/routes/apps.js");
  const app = express();
  app.use(express.json());
  app.use("/api", appsRouter);
  return app;
}

async function post(
  app: Express,
  body: unknown,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = (server.address() as { port: number }).port;
      void fetch(`http://127.0.0.1:${port}/api/servers/srv-1/apps`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
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

async function put(
  app: Express,
  body: unknown,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = (server.address() as { port: number }).port;
      void fetch(`http://127.0.0.1:${port}/api/apps/app-1`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
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

const validBase = {
  name: "myapp",
  repoUrl: "git@github.com:x/y.git",
  remotePath: "/opt/app",
};

beforeEach(() => {
  dbInsertedRows.length = 0;
  dbUpdatedRows.length = 0;
});

describe("apps scriptPath normalisation (T018)", () => {
  it("POST with valid scriptPath persists trimmed value", async () => {
    const app = await makeApp();
    const r = await post(app, {
      ...validBase,
      scriptPath: "scripts/devops-deploy.sh",
    });
    expect(r.status).toBe(201);
    expect(dbInsertedRows[0]).toMatchObject({
      scriptPath: "scripts/devops-deploy.sh",
    });
  });

  it("POST with empty string normalises to null", async () => {
    const app = await makeApp();
    const r = await post(app, { ...validBase, scriptPath: "" });
    expect(r.status).toBe(201);
    expect(dbInsertedRows[0]).toMatchObject({ scriptPath: null });
  });

  it("POST with whitespace-only normalises to null", async () => {
    const app = await makeApp();
    const r = await post(app, { ...validBase, scriptPath: "   " });
    expect(r.status).toBe(201);
    expect(dbInsertedRows[0]).toMatchObject({ scriptPath: null });
  });

  for (const [label, value, expectedMessageFragment] of [
    ["traversal", "../evil", /parent-directory/],
    ["non-ASCII", "скрипты.sh", /printable ASCII/],
    ["over length", "a".repeat(257), /≤256 characters/],
    ["paren", "scripts/(cmd).sh", /not allowed/],
    ["windows numbering", "scripts/foo(1).sh", /not allowed/],
  ] as const) {
    it(`POST ${label} → 400`, async () => {
      const app = await makeApp();
      const r = await post(app, { ...validBase, scriptPath: value });
      expect(r.status).toBe(400);
      const body = r.body as {
        error: {
          details: { fieldErrors: { scriptPath: string[] } };
        };
      };
      expect(body.error.details.fieldErrors.scriptPath[0]).toMatch(
        expectedMessageFragment,
      );
    });
  }

  for (const [label, value] of [
    ["number", 123],
    ["boolean", false],
    ["object", {}],
    ["array", []],
  ] as const) {
    it(`POST scriptPath=${label} → 400 (Zod rejects non-string non-null)`, async () => {
      const app = await makeApp();
      const r = await post(app, { ...validBase, scriptPath: value });
      expect(r.status).toBe(400);
    });
  }

  it("PUT with explicit null clears scriptPath", async () => {
    const app = await makeApp();
    const r = await put(app, { scriptPath: null });
    expect(r.status).toBe(200);
    expect(dbUpdatedRows[0]).toMatchObject({ scriptPath: null });
  });

  it("PUT omitting scriptPath leaves it untouched", async () => {
    const app = await makeApp();
    const r = await put(app, { name: "renamed" });
    expect(r.status).toBe(200);
    expect("scriptPath" in (dbUpdatedRows[0] ?? {})).toBe(false);
  });

  it("PUT with valid string updates", async () => {
    const app = await makeApp();
    const r = await put(app, { scriptPath: "scripts/x.sh" });
    expect(r.status).toBe(200);
    expect(dbUpdatedRows[0]).toMatchObject({ scriptPath: "scripts/x.sh" });
  });
});
