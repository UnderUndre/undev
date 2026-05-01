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

  /** Public for tests + graceful shutdown. */
  stop(): void {
    if (this.cleanupTimer !== null) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  private sweepCoalesce(): void {
    const cutoff = Date.now() - COALESCE_WINDOW_MS;
    for (const [key, entry] of this.coalesce) {
      if (entry.firstAt < cutoff) this.coalesce.delete(key);
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
   * Feature 006 T015 + T059: app health change with 60s coalescing.
   * Identical (appId, transition) within the window collapses into a single
   * outgoing message with `+N occurrences` suffix.
   */
  async notifyAppHealthChange(payload: AppHealthChangePayload): Promise<boolean> {
    const token = this.defaultToken;
    const chatId = this.defaultChatId;
    const key = `${payload.appId}::${payload.transition}`;
    const now = Date.now();
    const existing = this.coalesce.get(key);
    if (existing !== undefined && now - existing.firstAt < COALESCE_WINDOW_MS) {
      existing.count += 1;
      existing.lastPayload = payload;
      logger.info(
        {
          ctx: "notifier-coalesce",
          appId: payload.appId,
          state: payload.transition,
          count: existing.count,
        },
        "coalesced",
      );
      return true; // collapsed — caller treats as delivered
    }
    this.coalesce.set(key, { firstAt: now, count: 1, lastPayload: payload });

    if (token === undefined || chatId === undefined) {
      logger.info({ ctx: "notifier" }, "Telegram not configured, skipping");
      return false;
    }
    const text = this.formatAppHealthChange(payload, 1);
    return this.send(token, chatId, text);
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
