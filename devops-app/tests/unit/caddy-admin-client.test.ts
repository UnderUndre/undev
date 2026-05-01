import { describe, it, expect } from "vitest";
import http from "node:http";
import { CaddyAdminClient, CaddyAdminError } from "../../server/services/caddy-admin-client.js";

interface FakeServerHandler {
  (req: http.IncomingMessage, res: http.ServerResponse): void;
}

async function startFakeCaddy(handler: FakeServerHandler): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address() as { port: number };
      resolve({
        port: addr.port,
        close: () => srv.close(),
      });
    });
  });
}

describe("CaddyAdminClient (T009)", () => {
  it("load() POSTs JSON and resolves on 2xx", async () => {
    const fake = await startFakeCaddy((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        expect(req.method).toBe("POST");
        expect(req.url).toBe("/load");
        const parsed = JSON.parse(body);
        expect(parsed.admin.listen).toBe("127.0.0.1:2019");
        res.statusCode = 200;
        res.end();
      });
    });
    try {
      const client = new CaddyAdminClient({
        async open() {
          return { localPort: fake.port, close: () => undefined };
        },
      });
      await client.load("srv1", {
        admin: { listen: "127.0.0.1:2019" },
        apps: { http: { servers: {} } },
      });
    } finally {
      fake.close();
    }
  });

  it("load() rejects with kind=http on 5xx", async () => {
    const fake = await startFakeCaddy((_req, res) => {
      res.statusCode = 500;
      res.end("boom");
    });
    try {
      const client = new CaddyAdminClient({
        async open() {
          return { localPort: fake.port, close: () => undefined };
        },
      });
      await expect(
        client.load("srv1", { admin: { listen: "127.0.0.1:2019" }, apps: { http: { servers: {} } } }),
      ).rejects.toMatchObject({ name: "CaddyAdminError", kind: "http" });
    } finally {
      fake.close();
    }
  });

  it("ssh tunnel failure → kind=ssh", async () => {
    const client = new CaddyAdminClient({
      async open() {
        throw new Error("connection refused");
      },
    });
    await expect(
      client.load("srv1", { admin: { listen: "127.0.0.1:2019" }, apps: { http: { servers: {} } } }),
    ).rejects.toMatchObject({ name: "CaddyAdminError", kind: "ssh" });
  });

  it("getConfig() parses returned JSON", async () => {
    const fake = await startFakeCaddy((_req, res) => {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          admin: { listen: "127.0.0.1:2019" },
          apps: { http: { servers: { srv0: { listen: [":80"], routes: [] } } } },
        }),
      );
    });
    try {
      const client = new CaddyAdminClient({
        async open() {
          return { localPort: fake.port, close: () => undefined };
        },
      });
      const cfg = await client.getConfig("srv1");
      expect(cfg.apps.http.servers.srv0).toBeDefined();
    } finally {
      fake.close();
    }
  });

  it("getConfig() rejects malformed JSON", async () => {
    const fake = await startFakeCaddy((_req, res) => {
      res.statusCode = 200;
      res.end("not-json");
    });
    try {
      const client = new CaddyAdminClient({
        async open() {
          return { localPort: fake.port, close: () => undefined };
        },
      });
      await expect(client.getConfig("srv1")).rejects.toMatchObject({ kind: "http" });
    } finally {
      fake.close();
    }
  });

  it("CaddyAdminError exposes kind/cause/status", () => {
    const err = new CaddyAdminError("timeout", "msg", new Error("inner"), 504);
    expect(err.kind).toBe("timeout");
    expect(err.status).toBe(504);
    expect(err.cause).toBeInstanceOf(Error);
  });
});
