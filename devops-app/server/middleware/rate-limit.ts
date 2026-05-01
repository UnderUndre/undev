/**
 * Feature 006 T055 — minimal in-memory rate limiter middleware.
 *
 * Sliding-second window keyed by (userId | ip). Used for the
 * POST /api/applications/health-url/validate endpoint at 10 req/sec/user
 * to prevent enumeration of internal subnets via the validator.
 *
 * Not a distributed limiter — single-process. The dashboard runs as a single
 * Node process so this is enough; if we ever scale horizontally, swap for a
 * Redis-backed bucket.
 */
import type { Request, Response, NextFunction } from "express";

interface Bucket {
  windowStartMs: number;
  count: number;
}

export interface RateLimitOptions {
  windowMs: number;
  max: number;
  keyFn?: (req: Request) => string;
}

export function rateLimit(opts: RateLimitOptions) {
  const buckets = new Map<string, Bucket>();
  const keyFn =
    opts.keyFn ??
    ((req: Request): string => {
      const userId = (req as Request & { userId?: string }).userId;
      if (typeof userId === "string" && userId !== "") return `u:${userId}`;
      return `ip:${req.ip ?? "unknown"}`;
    });

  // Periodic cleanup so the map doesn't leak.
  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [k, b] of buckets) {
      if (now - b.windowStartMs > opts.windowMs * 4) buckets.delete(k);
    }
  }, opts.windowMs * 8);
  cleanup.unref();

  return (req: Request, res: Response, next: NextFunction): void => {
    const key = keyFn(req);
    const now = Date.now();
    const b = buckets.get(key);
    if (b === undefined || now - b.windowStartMs >= opts.windowMs) {
      buckets.set(key, { windowStartMs: now, count: 1 });
      next();
      return;
    }
    if (b.count >= opts.max) {
      res.status(429).json({
        error: {
          code: "RATE_LIMITED",
          message: `Too many requests; max ${opts.max} per ${opts.windowMs}ms`,
        },
      });
      return;
    }
    b.count += 1;
    next();
  };
}
