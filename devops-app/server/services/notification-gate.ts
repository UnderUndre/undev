/**
 * Feature 011 T058 — unified gate between event emitters and the TG send path.
 *
 * Flow per contracts/notification-channel.md:
 *   1. Catalogue check    — orphan event types are dropped silently.
 *   2. Preferences check  — disabled events are dropped (no audit).
 *   3. TG configured?     — token + chatId + lastTestOk all required.
 *   4. Per-pair cooldown  — 5-min window suppresses duplicates with counter.
 *   5. Token bucket       — 20 messages/min global cap (consumed BEFORE send
 *      so a TG-down period cannot burn through unbounded calls).
 *   6. Format payload     — formatter receives suppressed counter.
 *   7. Send w/ retry      — 3 transient retries with backoff [1s, 4s, 16s].
 *   8. Classify response  — success / transient / permanent → audit.
 *
 * Memory hygiene: hourly sweep of the cooldown Map removes entries older
 * than the cooldown window. unref() on the interval lets the process exit.
 */

import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "../db/index.js";
import {
  auditEntries,
  notificationPreferences,
} from "../db/schema.js";
import { catalogueHas } from "../lib/event-catalogue.js";
import { logger } from "../lib/logger.js";
import {
  loadForDispatch,
  recordTestOutcome,
} from "./notification-settings-store.js";

// ── Public types ────────────────────────────────────────────────────────────

export interface DispatchInput {
  eventType: string;
  resourceId: string;
  payloadFormatter: (suppressedCount: number) => string;
}

export type DropReason =
  | "telegram_unconfigured"
  | "preferences_disabled"
  | "throttled_cooldown"
  | "throttled_token_bucket"
  | "delivery_failed_transient"
  | "delivery_failed_permanent"
  | "orphan_event";

export type DispatchResult =
  | { delivered: true; messageId: number | null }
  | { delivered: false; reason: DropReason };

// ── Tunables (exported for test override) ───────────────────────────────────

export const COOLDOWN_WINDOW_MS = 5 * 60 * 1000;
export const BUCKET_MAX = 20;
export const BUCKET_REFILL_PER_MIN = 20;
export const TRANSIENT_BACKOFFS_MS: ReadonlyArray<number> = [
  1_000, 4_000, 16_000,
];
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

// ── In-memory state ─────────────────────────────────────────────────────────

interface CooldownEntry {
  pairKey: string;
  firstSendAt: number;
  suppressedSinceLastSend: number;
}

interface TokenBucketState {
  tokens: number;
  lastRefillAt: number;
}

// ── Classification ──────────────────────────────────────────────────────────

type Classification =
  | { kind: "success" }
  | { kind: "transient"; reason: string; retryAfterMs?: number }
  | {
      kind: "permanent";
      reason: string;
      tgErrorCode?: number;
      tgErrorDescription?: string;
    };

interface TgBody {
  ok: boolean;
  error_code?: number;
  description?: string;
  result?: { message_id: number };
  parameters?: { retry_after?: number };
}

export function classifyTelegramResponse(
  status: number,
  body: TgBody | null,
  err: Error | null,
): Classification {
  if (err !== null) return { kind: "transient", reason: "network_error" };
  if (status >= 200 && status < 300 && body?.ok === true) {
    return { kind: "success" };
  }
  if (status === 429) {
    const retryAfterSec = body?.parameters?.retry_after ?? 1;
    return {
      kind: "transient",
      reason: "rate_limit",
      retryAfterMs: retryAfterSec * 1000,
    };
  }
  if (status >= 500) return { kind: "transient", reason: "server_error" };
  if (status === 400 || status === 401 || status === 403 || status === 404) {
    const reason =
      status === 401
        ? "unauthorized"
        : status === 403
          ? "forbidden"
          : status === 404
            ? "chat_not_found"
            : "bad_request";
    const out: Classification = {
      kind: "permanent",
      reason,
    };
    if (body?.error_code !== undefined) out.tgErrorCode = body.error_code;
    if (body?.description !== undefined)
      out.tgErrorDescription = body.description;
    return out;
  }
  const fallback: Classification = { kind: "permanent", reason: "unknown_4xx" };
  if (body?.error_code !== undefined) fallback.tgErrorCode = body.error_code;
  return fallback;
}

// ── Gate implementation ─────────────────────────────────────────────────────

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

class NotificationGate {
  private cooldown = new Map<string, CooldownEntry>();
  private bucket: TokenBucketState = {
    tokens: BUCKET_MAX,
    lastRefillAt: Date.now(),
  };
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  // Test seam — tests inject a fake fetch + sleep.
  fetchFn: typeof fetch = (...args) => fetch(...args);
  sleepFn: (ms: number) => Promise<void> = sleep;
  nowFn: () => number = () => Date.now();

  constructor() {
    this.sweepTimer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    this.sweepTimer.unref();
  }

  stop(): void {
    if (this.sweepTimer !== null) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  /** Test/inspection helper — exposes current cooldown counter for a pair. */
  getCooldownCount(eventType: string, resourceId: string): number {
    return this.cooldown.get(`${eventType}::${resourceId}`)
      ?.suppressedSinceLastSend ?? 0;
  }

  /** Test helper — reset all in-memory state. */
  reset(): void {
    this.cooldown.clear();
    this.bucket = { tokens: BUCKET_MAX, lastRefillAt: this.nowFn() };
  }

  private sweep(): void {
    const cutoff = this.nowFn() - COOLDOWN_WINDOW_MS;
    for (const [k, v] of this.cooldown) {
      if (v.firstSendAt < cutoff) this.cooldown.delete(k);
    }
  }

  private refillBucket(): void {
    const now = this.nowFn();
    const elapsedMin = (now - this.bucket.lastRefillAt) / 60_000;
    if (elapsedMin <= 0) return;
    const refill = Math.min(
      BUCKET_MAX,
      this.bucket.tokens + elapsedMin * BUCKET_REFILL_PER_MIN,
    );
    this.bucket.tokens = refill;
    this.bucket.lastRefillAt = now;
  }

  private async writeAudit(
    action: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    try {
      await db.insert(auditEntries).values({
        id: randomUUID(),
        userId: "system",
        action,
        targetType: "system",
        targetId: (payload.resourceId as string | undefined) ?? "unknown",
        details: JSON.stringify(payload),
        result: action.includes("dropped") ? "failure" : "success",
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      logger.error({ ctx: "notification-gate-audit", err }, "audit write failed");
    }
  }

  async dispatch(input: DispatchInput): Promise<DispatchResult> {
    // 1. Catalogue check — orphan events are dropped silently.
    if (!catalogueHas(input.eventType)) {
      logger.warn(
        { ctx: "notification-gate", eventType: input.eventType },
        "orphan event dropped (not in catalogue)",
      );
      return { delivered: false, reason: "orphan_event" };
    }

    // 2. Preferences check — disabled events are dropped (no audit per FR-031).
    const prefs = await db
      .select({ enabled: notificationPreferences.enabled })
      .from(notificationPreferences)
      .where(eq(notificationPreferences.eventType, input.eventType))
      .limit(1);
    const enabled = prefs[0]?.enabled ?? true; // pre-seeding default
    if (!enabled) {
      return { delivered: false, reason: "preferences_disabled" };
    }

    // 3. TG configured?
    const cfg = await loadForDispatch();
    if (!cfg.token || !cfg.chatId) {
      await this.writeAudit("notification.dropped.telegram_unconfigured", {
        eventType: input.eventType,
        resourceId: input.resourceId,
      });
      return { delivered: false, reason: "telegram_unconfigured" };
    }

    // 4. Per-pair cooldown.
    const pairKey = `${input.eventType}::${input.resourceId}`;
    const now = this.nowFn();
    const existing = this.cooldown.get(pairKey);
    if (existing && now - existing.firstSendAt < COOLDOWN_WINDOW_MS) {
      existing.suppressedSinceLastSend += 1;
      await this.writeAudit("notification.dropped.throttled", {
        eventType: input.eventType,
        resourceId: input.resourceId,
        reason: "cooldown",
        suppressedCount: existing.suppressedSinceLastSend,
        windowExpiresAt: new Date(
          existing.firstSendAt + COOLDOWN_WINDOW_MS,
        ).toISOString(),
      });
      return { delivered: false, reason: "throttled_cooldown" };
    }

    // 5. Global token bucket — consumed BEFORE the send so failed sends
    //    still count toward the cap.
    this.refillBucket();
    if (this.bucket.tokens < 1) {
      await this.writeAudit("notification.dropped.throttled", {
        eventType: input.eventType,
        resourceId: input.resourceId,
        reason: "token_bucket",
      });
      return { delivered: false, reason: "throttled_token_bucket" };
    }
    this.bucket.tokens -= 1;

    // 6. Format payload — suppressedCount is whatever was buffered for the
    //    previous window before it expired (0 on a true first send).
    const suppressed = existing?.suppressedSinceLastSend ?? 0;
    const text = input.payloadFormatter(suppressed);

    // 7. Send with retry.
    const outcome = await this.deliverWithRetry(cfg.token, cfg.chatId, text);

    // Update cooldown bookkeeping regardless of outcome — bucket already
    // consumed; cooldown anchors to "first attempt of this pair this window".
    this.cooldown.set(pairKey, {
      pairKey,
      firstSendAt: now,
      suppressedSinceLastSend: 0,
    });

    if (outcome.ok) {
      return { delivered: true, messageId: outcome.messageId };
    }

    // 8. Permanent or transient drop → audit + flip last_test_ok if permanent.
    const cls = outcome.classification;
    const auditPayload: Record<string, unknown> = {
      eventType: input.eventType,
      resourceId: input.resourceId,
      classification: cls.kind,
      reason: cls.reason,
      retryCount: outcome.attempts,
    };
    if (cls.kind === "permanent") {
      if (cls.tgErrorCode !== undefined) auditPayload.tgErrorCode = cls.tgErrorCode;
      if (cls.tgErrorDescription !== undefined)
        auditPayload.tgErrorDescription = cls.tgErrorDescription;
      await recordTestOutcome(false, "permanent");
    }
    await this.writeAudit(
      "notification.dropped.delivery_failed",
      auditPayload,
    );
    return {
      delivered: false,
      reason:
        cls.kind === "permanent"
          ? "delivery_failed_permanent"
          : "delivery_failed_transient",
    };
  }

  private async deliverWithRetry(
    token: string,
    chatId: string,
    text: string,
  ): Promise<
    | { ok: true; messageId: number | null; attempts: number }
    | {
        ok: false;
        classification: Exclude<Classification, { kind: "success" }>;
        attempts: number;
      }
  > {
    let lastClass: Exclude<Classification, { kind: "success" }> | null = null;
    for (let attempt = 0; attempt <= TRANSIENT_BACKOFFS_MS.length; attempt++) {
      const { cls, body } = await this.sendOnce(token, chatId, text);
      if (cls.kind === "success") {
        return {
          ok: true,
          messageId: body?.result?.message_id ?? null,
          attempts: attempt + 1,
        };
      }
      if (cls.kind === "permanent") {
        return { ok: false, classification: cls, attempts: attempt + 1 };
      }
      // transient
      lastClass = cls;
      if (attempt < TRANSIENT_BACKOFFS_MS.length) {
        const wait = cls.retryAfterMs ?? TRANSIENT_BACKOFFS_MS[attempt]!;
        await this.sleepFn(wait);
      }
    }
    return {
      ok: false,
      classification: lastClass!,
      attempts: TRANSIENT_BACKOFFS_MS.length + 1,
    };
  }

  private async sendOnce(
    token: string,
    chatId: string,
    text: string,
  ): Promise<{ cls: Classification; body: TgBody | null }> {
    let resp: Response | null = null;
    let err: Error | null = null;
    try {
      resp = await this.fetchFn(
        `https://api.telegram.org/bot${token}/sendMessage`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, text }),
        },
      );
    } catch (e) {
      err = e instanceof Error ? e : new Error(String(e));
    }
    let body: TgBody | null = null;
    if (resp) {
      try {
        body = (await resp.json()) as TgBody;
      } catch {
        body = null;
      }
    }
    return {
      cls: classifyTelegramResponse(resp?.status ?? 0, body, err),
      body,
    };
  }
}

export const gate = new NotificationGate();
export { NotificationGate };
