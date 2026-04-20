import { Router } from "express";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { githubConnection } from "../db/schema.js";
import { validateBody } from "../middleware/validate.js";
import {
  githubService,
  GitHubUnauthorizedError,
  GitHubRateLimitError,
  GitHubApiError,
} from "../services/github.js";

export const settingsRouter = Router();

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
