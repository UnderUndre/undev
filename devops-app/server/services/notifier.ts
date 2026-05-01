/**
 * Telegram notifier.
 *
 * Feature 006 additions:
 *   - notifyAppHealthChange / notifyCertExpiring / notifyCaddyUnreachable / notifyCaddyRecovered
 *   - 60s sliding-window coalescing for repeated app-health-change events
 *     (Edge Case "flapping rate-limit" — Gemini review 2026-04-28)
 *   - structured logger replaces previous console.log/error per CLAUDE.md
 */
import { logger } from "../lib/logger.js";

interface NotifyOptions {
  serverId: string;
  event: string;
  details: string;
  botToken?: string;
  chatId?: string;
}

export interface AppHealthChangePayload {
  appId: string;
  appName: string;
  serverLabel: string;
  transition: "to-unhealthy" | "to-healthy";
  reason?: string;
  downtimeMs?: number;
  deepLink: string;
}

export interface CertExpiringPayload {
  appId: string;
  appName: string;
  domain: string;
  daysLeft: number;
  windowDays: number;
  expiresAtIso: string;
  lastRenewAtIso: string | null;
  certStatus: string;
  deepLink: string;
}

export interface CaddyUnreachablePayload {
  serverId: string;
  serverLabel: string;
  lastSuccessAgoMs: number | null;
}

export interface CaddyRecoveredPayload {
  serverId: string;
  serverLabel: string;
  downtimeMs: number;
}

interface CoalesceEntry {
  firstAt: number;
  count: number;
  lastPayload: AppHealthChangePayload;
  summaryTimer: ReturnType<typeof setTimeout> | null;
}

const COALESCE_WINDOW_MS = 60_000;

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return rs === 0 ? `${m}m` : `${m}m ${rs}s`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm === 0 ? `${h}h` : `${h}h ${rm}m`;
}

class TelegramNotifier {
  private coalesce = new Map<string, CoalesceEntry>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.cleanupTimer = setInterval(() => this.sweepCoalesce(), COALESCE_WINDOW_MS);
    this.cleanupTimer.unref();
  }

  private get defaultToken(): string | undefined {
    const v = process.env.TELEGRAM_BOT_TOKEN;
    return v === undefined || v === "" ? undefined : v;
  }

  private get defaultChatId(): string | undefined {
    const v = process.env.TELEGRAM_CHAT_ID;
    return v === undefined || v === "" ? undefined : v;
  }

  /** Public for tests + graceful shutdown. Cancels any pending summary timers. */
  stop(): void {
    if (this.cleanupTimer !== null) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    for (const entry of this.coalesce.values()) {
      if (entry.summaryTimer !== null) clearTimeout(entry.summaryTimer);
    }
    this.coalesce.clear();
  }

  /**
   * Defensive sweep — under normal operation each entry is cleared by its own
   * `summaryTimer` callback. The interval-based sweep is a backstop for the
   * pathological case where the timer was somehow lost (e.g. process suspended
   * past the 60s window). It only deletes entries whose timer has already
   * fired (`summaryTimer === null` after cleanup) — never cancels live timers.
   */
  private sweepCoalesce(): void {
    const cutoff = Date.now() - COALESCE_WINDOW_MS * 2;
    for (const [key, entry] of this.coalesce) {
      if (entry.firstAt < cutoff && entry.summaryTimer === null) {
        this.coalesce.delete(key);
      }
    }
  }

  async notify(options: NotifyOptions): Promise<boolean> {
    const token = options.botToken ?? this.defaultToken;
    const chatId = options.chatId ?? this.defaultChatId;
    if (token === undefined || chatId === undefined) {
      logger.info(
        { ctx: "notifier" },
        "Telegram not configured, skipping notification",
      );
      return false;
    }
    const text = `*${options.event}*\nServer: \`${options.serverId}\`\n${options.details}`;
    return this.send(token, chatId, text);
  }

  private async send(
    token: string,
    chatId: string,
    text: string,
  ): Promise<boolean> {
    try {
      const resp = await fetch(
        `https://api.telegram.org/bot${token}/sendMessage`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            text,
            parse_mode: "Markdown",
          }),
        },
      );
      if (!resp.ok) {
        logger.warn(
          { ctx: "notifier", status: resp.status, statusText: resp.statusText },
          "Telegram API error",
        );
        return false;
      }
      return true;
    } catch (err) {
      logger.warn({ ctx: "notifier", err }, "Failed to send Telegram notification");
      return false;
    }
  }

  /**
   * Feature 006 T015 + T059: app health change with 60s leading-edge alert
   * + trailing-edge summary coalescing.
   *
   * Pattern (per Gemini review 2026-04-28 — fixes the "lost-signal" flaw):
   *   1. First event for `(appId, transition)` → send immediately, count=1,
   *      schedule a 60s summary timer.
   *   2. Subsequent events within the window → increment count, update payload
   *      snapshot, do NOT send. Operator already has the leading alert.
   *   3. Timer fires at T+60s → if count > 1, send a single summary message
   *      with "+N more occurrences" suffix; count == 1 means no flapping, no
   *      summary needed. Entry then cleared so the next event after the
   *      window restarts the cycle.
   *
   * Lossless: operator gets (a) the immediate alert AND (b) a summary for
   * flapping bursts. Telegram per-chat 1 msg/sec limit is respected because
   * a flapping app produces at most 2 messages per 60s window per transition.
   */
  async notifyAppHealthChange(payload: AppHealthChangePayload): Promise<boolean> {
    const token = this.defaultToken;
    const chatId = this.defaultChatId;
    const key = `${payload.appId}::${payload.transition}`;
    const now = Date.now();
    const existing = this.coalesce.get(key);

    if (existing !== undefined && existing.summaryTimer !== null) {
      // Within the live window — buffer the event for the summary.
      existing.count += 1;
      existing.lastPayload = payload;
      logger.info(
        {
          ctx: "notifier-coalesce",
          appId: payload.appId,
          state: payload.transition,
          count: existing.count,
        },
        "buffered for summary",
      );
      return true; // operator already alerted by leading-edge send
    }

    // Leading edge: first event in a new window. Send immediately, schedule
    // the trailing summary.
    const summaryTimer = setTimeout(() => {
      this.fireSummary(key);
    }, COALESCE_WINDOW_MS);
    summaryTimer.unref();
    this.coalesce.set(key, {
      firstAt: now,
      count: 1,
      lastPayload: payload,
      summaryTimer,
    });

    if (token === undefined || chatId === undefined) {
      logger.info({ ctx: "notifier" }, "Telegram not configured, skipping");
      return false;
    }
    const text = this.formatAppHealthChange(payload, 1);
    return this.send(token, chatId, text);
  }

  /**
   * Trailing-edge summary dispatch. Fires once 60s after the leading event;
   * sends a "+N more occurrences" message ONLY if count > 1. Always clears
   * the entry so the next leading event opens a fresh window.
   */
  private async fireSummary(key: string): Promise<void> {
    const entry = this.coalesce.get(key);
    if (entry === undefined) return;
    entry.summaryTimer = null; // mark fired (sweepCoalesce safe-delete checks this)

    const additional = entry.count - 1;
    if (additional <= 0) {
      // Single event in window — no flapping, no summary owed.
      this.coalesce.delete(key);
      return;
    }

    const token = this.defaultToken;
    const chatId = this.defaultChatId;
    if (token === undefined || chatId === undefined) {
      this.coalesce.delete(key);
      return;
    }

    const text = this.formatAppHealthChange(entry.lastPayload, entry.count);
    logger.info(
      {
        ctx: "notifier-coalesce",
        appId: entry.lastPayload.appId,
        state: entry.lastPayload.transition,
        count: entry.count,
      },
      "summary dispatched",
    );
    try {
      await this.send(token, chatId, text);
    } finally {
      this.coalesce.delete(key);
    }
  }

  /**
   * Test/inspection helper — returns the count for a given coalesce key.
   * Returns 0 when no entry exists.
   */
  getCoalesceCount(appId: string, transition: "to-unhealthy" | "to-healthy"): number {
    return this.coalesce.get(`${appId}::${transition}`)?.count ?? 0;
  }

  private formatAppHealthChange(p: AppHealthChangePayload, occurrences: number): string {
    const header =
      p.transition === "to-unhealthy"
        ? "❌ App unhealthy"
        : "✅ App healthy again";
    const body =
      p.transition === "to-unhealthy"
        ? `*${p.appName}*\nServer: ${p.serverLabel}\nReason: ${p.reason ?? "unknown"}\n[Open](${p.deepLink})`
        : `*${p.appName}*\nDowntime: ${formatDuration(p.downtimeMs ?? 0)}\nServer: ${p.serverLabel}\n[Open](${p.deepLink})`;
    const suffix = occurrences > 1 ? `\n+${occurrences - 1} occurrences` : "";
    return `*${header}*\n${body}${suffix}`;
  }

  async notifyCertExpiring(payload: CertExpiringPayload): Promise<boolean> {
    const token = this.defaultToken;
    const chatId = this.defaultChatId;
    if (token === undefined || chatId === undefined) return false;
    const lastRenew = payload.lastRenewAtIso ?? "never";
    const text =
      `*🔒 Cert expiring*\n` +
      `App: ${payload.appName}\n` +
      `Domain: ${payload.domain}\n` +
      `Expires: ${payload.expiresAtIso} (${payload.daysLeft} days)\n` +
      `Last renew: ${lastRenew}\n` +
      `Status: ${payload.certStatus}\n` +
      `[Open](${payload.deepLink})`;
    return this.send(token, chatId, text);
  }

  async notifyCaddyUnreachable(payload: CaddyUnreachablePayload): Promise<boolean> {
    const token = this.defaultToken;
    const chatId = this.defaultChatId;
    if (token === undefined || chatId === undefined) return false;
    const ago =
      payload.lastSuccessAgoMs === null
        ? "unknown"
        : formatDuration(payload.lastSuccessAgoMs);
    const text =
      `*🟠 Caddy unreachable*\n` +
      `Server: ${payload.serverLabel}\n` +
      `Last successful: ${ago}\n` +
      `Reverse-proxy reconciliation paused — cert renewals and domain changes will be queued.`;
    return this.send(token, chatId, text);
  }

  async notifyCaddyRecovered(payload: CaddyRecoveredPayload): Promise<boolean> {
    const token = this.defaultToken;
    const chatId = this.defaultChatId;
    if (token === undefined || chatId === undefined) return false;
    const text =
      `*✅ Caddy recovered*\n` +
      `Server: ${payload.serverLabel}\n` +
      `Downtime: ${formatDuration(payload.downtimeMs)}`;
    return this.send(token, chatId, text);
  }
}

export const notifier = new TelegramNotifier();
export { formatDuration as __formatDurationForTests };
