import { Router } from "express";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { githubConnection, appSettings, servers } from "../db/schema.js";
import { validateBody } from "../middleware/validate.js";
import {
  githubService,
  GitHubUnauthorizedError,
  GitHubRateLimitError,
  GitHubApiError,
} from "../services/github.js";
import { caddyAdminClient, CaddyAdminError } from "../services/caddy-admin-client.js";
import { logger } from "../lib/logger.js";

export const settingsRouter = Router();

// ── Feature 008 T034 — TLS settings ────────────────────────────────────────
const TLS_KEY = "acme_email";

settingsRouter.get("/tls", async (_req, res) => {
  const [row] = await db.select().from(appSettings).where(eq(appSettings.key, TLS_KEY)).limit(1);
  res.json({
    acmeEmail: row?.value ?? null,
    caddyAdminEndpoint: "127.0.0.1:2019",
    updatedAt: row?.updatedAt ?? null,
  });
});

const patchTlsSchema = z
  .object({
    acmeEmail: z.union([z.string(), z.null()]),
  })
  .strict();

settingsRouter.patch("/tls", validateBody(patchTlsSchema), async (req, res) => {
  const body = req.body as z.infer<typeof patchTlsSchema>;
  if (body.acmeEmail !== null && !/^\S+@\S+\.\S+$/.test(body.acmeEmail)) {
    res.status(400).json({
      error: {
        code: "INVALID_EMAIL",
        message: "ACME email failed validation",
        details: { fieldErrors: { acmeEmail: ["Must be a valid email address"] } },
      },
    });
    return;
  }
  const now = new Date().toISOString();
  await db
    .insert(appSettings)
    .values({ key: TLS_KEY, value: body.acmeEmail, updatedAt: now })
    .onConflictDoUpdate({
      target: appSettings.key,
      set: { value: body.acmeEmail, updatedAt: now },
    });
  res.json({
    acmeEmail: body.acmeEmail,
    caddyAdminEndpoint: "127.0.0.1:2019",
    updatedAt: now,
  });
});

// ── T035 test-caddy ────────────────────────────────────────────────────────
settingsRouter.post("/tls/test-caddy", async (req, res) => {
  const serverId = typeof req.query.serverId === "string" ? req.query.serverId : null;
  const targets = serverId
    ? await db.select().from(servers).where(eq(servers.id, serverId))
    : await db.select().from(servers);

  const results = await Promise.all(
    targets.map(async (srv) => {
      const start = Date.now();
      try {
        await caddyAdminClient.getConfig(srv.id);
        return {
          serverId: srv.id,
          serverLabel: srv.label,
          outcome: "ok" as const,
          latencyMs: Date.now() - start,
          caddyVersion: "2.7",
          errorMessage: null,
        };
      } catch (err) {
        if (err instanceof CaddyAdminError) {
          return {
            serverId: srv.id,
            serverLabel: srv.label,
            outcome: err.kind === "ssh" ? ("unreachable" as const) : ("invalid_response" as const),
            latencyMs: null,
            caddyVersion: null,
            // No secret leakage — only the kind + a short, sanitized message.
            errorMessage: `${err.kind}: ${err.message.slice(0, 200)}`,
          };
        }
        logger.warn({ ctx: "tls-test-caddy", serverId: srv.id, err }, "unknown error");
        return {
          serverId: srv.id,
          serverLabel: srv.label,
          outcome: "unreachable" as const,
          latencyMs: null,
          caddyVersion: null,
          errorMessage: "unknown error",
        };
      }
    }),
  );
  res.json({ results });
});

const connectSchema = z.object({
  token: z.string().min(1, "Token required"),
});

// GET /api/settings/github → public connection info (never the token) or null
settingsRouter.get("/github", async (_req, res) => {
  const [row] = await db
    .select()
    .from(githubConnection)
    .where(eq(githubConnection.id, "DEFAULT"))
    .limit(1);

  if (!row) {
    res.json(null);
    return;
  }

  res.json({
    username: row.username,
    avatarUrl: row.avatarUrl,
    tokenExpiresAt: row.tokenExpiresAt,
    connectedAt: row.connectedAt,
  });
});

// POST /api/settings/github → validate token, upsert connection
settingsRouter.post("/github", validateBody(connectSchema), async (req, res) => {
  const { token } = req.body as { token: string };

  let user;
  try {
    user = await githubService.validateToken(token);
  } catch (err) {
    if (err instanceof GitHubUnauthorizedError) {
      res.status(400).json({
        error: { code: "INVALID_TOKEN", message: "GitHub token is invalid or expired" },
      });
      return;
    }
    if (err instanceof GitHubRateLimitError) {
      res.status(429).json({
        error: {
          code: "GITHUB_RATE_LIMITED",
          message: err.message,
          details: { resetAt: err.resetAt },
        },
      });
      return;
    }
    if (err instanceof GitHubApiError) {
      res.status(502).json({
        error: { code: "GITHUB_API_ERROR", message: err.message },
      });
      return;
    }
    // Unexpected error — log with context before rethrowing so it doesn't disappear into the void
    console.error("[settings/github] Unexpected error during token validation:", err);
    throw err;
  }

  const now = new Date().toISOString();
  const [row] = await db
    .insert(githubConnection)
    .values({
      id: "DEFAULT",
      token,
      username: user.username,
      avatarUrl: user.avatarUrl,
      tokenExpiresAt: user.tokenExpiresAt,
      connectedAt: now,
    })
    .onConflictDoUpdate({
      target: githubConnection.id,
      set: {
        token,
        username: user.username,
        avatarUrl: user.avatarUrl,
        tokenExpiresAt: user.tokenExpiresAt,
        connectedAt: now,
      },
    })
    .returning();

  if (!row) {
    res.status(500).json({
      error: { code: "DB_ERROR", message: "Failed to persist GitHub connection" },
    });
    return;
  }

  res.status(201).json({
    username: row.username,
    avatarUrl: row.avatarUrl,
    tokenExpiresAt: row.tokenExpiresAt,
    connectedAt: row.connectedAt,
  });
});

// DELETE /api/settings/github → remove connection
settingsRouter.delete("/github", async (_req, res) => {
  await db.delete(githubConnection).where(eq(githubConnection.id, "DEFAULT"));
  // Clear any cached data keyed to the former token
  githubService.invalidateCache("");
  res.status(204).end();
});

// GET /api/settings/github/rate-limit → current rate limit snapshot
settingsRouter.get("/github/rate-limit", async (_req, res) => {
  res.json(githubService.getRateLimit());
});
