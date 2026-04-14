import type { Request, Response, NextFunction } from "express";
import { randomUUID, timingSafeEqual as cryptoTimingSafeEqual } from "node:crypto";
import { db } from "../db/index.js";
import { sessions } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

const loginSchema = z.object({
  key: z.string().min(1),
});

// Auth middleware — validates session cookie on protected routes
export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const sessionId = req.cookies?.session;
  if (!sessionId) {
    res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Not authenticated" } });
    return;
  }

  try {
    const [session] = await db
      .select()
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);

    if (!session || new Date(session.expiresAt) < new Date()) {
      res.status(401).json({ error: { code: "SESSION_EXPIRED", message: "Session expired" } });
      return;
    }

    (req as Request & { userId: string }).userId = session.userId;
    next();
  } catch {
    res.status(500).json({ error: { code: "AUTH_ERROR", message: "Authentication error" } });
  }
}

// Auth routes
export const authRouter = Router();

// POST /api/auth/login — validate API key
authRouter.post("/login", async (req: Request, res: Response) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "API key is required" } });
    return;
  }

  const { key } = parsed.data;
  const dashboardKey = process.env.DASHBOARD_KEY;

  if (!dashboardKey) {
    res.status(500).json({ error: { code: "CONFIG_ERROR", message: "DASHBOARD_KEY not configured" } });
    return;
  }

  // Constant-time comparison to prevent timing attacks
  if (key.length !== dashboardKey.length || !timingSafeEqual(key, dashboardKey)) {
    res.status(401).json({ error: { code: "INVALID_KEY", message: "Invalid API key" } });
    return;
  }

  // Create session
  const sessionId = randomUUID();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();

  await db.insert(sessions).values({
    id: sessionId,
    userId: "admin",
    expiresAt,
    createdAt: new Date().toISOString(),
  });

  res.cookie("session", sessionId, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    maxAge: SESSION_TTL_MS,
    path: "/",
  });

  res.json({ user: { username: "admin" } });
});

// POST /api/auth/logout
authRouter.post("/logout", async (req: Request, res: Response) => {
  const sessionId = req.cookies?.session;
  if (sessionId) {
    await db.delete(sessions).where(eq(sessions.id, sessionId));
  }
  res.clearCookie("session");
  res.status(204).end();
});

// GET /api/auth/me
authRouter.get("/me", requireAuth, (req: Request, res: Response) => {
  const userId = (req as Request & { userId: string }).userId;
  res.json({ user: { username: userId } });
});

// Constant-time string comparison
function timingSafeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return cryptoTimingSafeEqual(bufA, bufB);
}
