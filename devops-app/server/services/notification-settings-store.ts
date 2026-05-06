/**
 * Feature 011 T057 — singleton CRUD over `notification_settings`.
 *
 * Token is sealed via envelope-cipher on every UPDATE; load() never
 * returns the plaintext token (only `botTokenConfigured: boolean`).
 *
 * `testConnection` bypasses the gate per contracts/notification-channel.md
 * § Test connection bypass — single-attempt POST to TG, no retry, no
 * cooldown, no bucket consumption.
 */

import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "../db/index.js";
import { auditEntries, notificationSettings } from "../db/schema.js";
import {
  seal,
  open,
  type EnvelopeBlob,
} from "../lib/envelope-cipher.js";
import { logger } from "../lib/logger.js";

export interface NotificationSettingsView {
  botTokenConfigured: boolean;
  chatId: string | null;
  lastTestAt: string | null;
  lastTestOk: boolean;
  updatedAt: string;
}

export type TelegramTestClassification =
  | "success"
  | "transient"
  | "permanent"
  | "unconfigured";

export interface TelegramTestResult {
  ok: boolean;
  classification: TelegramTestClassification;
  httpStatus?: number;
  tgErrorCode?: number;
  tgErrorDescription?: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

async function loadRow() {
  const rows = await db
    .select()
    .from(notificationSettings)
    .where(eq(notificationSettings.id, 1))
    .limit(1);
  return rows[0] ?? null;
}

export async function load(): Promise<NotificationSettingsView> {
  const row = await loadRow();
  if (!row) {
    // Migration 0010 inserts the singleton, so this should not happen in
    // a healthy deployment. Surface as fatal — boot-checks will catch it.
    throw new Error(
      "notification_settings singleton missing — run migration 0010",
    );
  }
  return {
    botTokenConfigured: row.telegramBotTokenEncrypted !== null,
    chatId: row.telegramChatId,
    lastTestAt: row.telegramLastTestAt,
    lastTestOk: row.telegramLastTestOk,
    updatedAt: row.updatedAt,
  };
}

/** Internal helper — used by the gate to source the live token+chatId. */
export async function loadForDispatch(): Promise<{
  token: string | null;
  chatId: string | null;
  lastTestOk: boolean;
}> {
  const row = await loadRow();
  if (!row) return { token: null, chatId: null, lastTestOk: false };
  if (!row.telegramBotTokenEncrypted) {
    return { token: null, chatId: row.telegramChatId, lastTestOk: row.telegramLastTestOk };
  }
  let blob: EnvelopeBlob;
  try {
    blob = JSON.parse(row.telegramBotTokenEncrypted) as EnvelopeBlob;
  } catch {
    logger.error(
      { ctx: "notification-settings-store" },
      "telegram_bot_token_encrypted is not valid JSON",
    );
    return { token: null, chatId: row.telegramChatId, lastTestOk: false };
  }
  return {
    token: open(blob),
    chatId: row.telegramChatId,
    lastTestOk: row.telegramLastTestOk,
  };
}

export async function updateTelegram(
  token: string | null,
  chatId: string | null,
  userId: string,
): Promise<NotificationSettingsView> {
  const sealed = token === null ? null : JSON.stringify(seal(token));
  await db
    .update(notificationSettings)
    .set({
      telegramBotTokenEncrypted: sealed,
      telegramChatId: chatId,
      // Mutating credentials invalidates the previous Test result.
      telegramLastTestOk: false,
      updatedAt: nowIso(),
    })
    .where(eq(notificationSettings.id, 1));

  await db.insert(auditEntries).values({
    id: randomUUID(),
    userId,
    action: "notification.settings_changed",
    targetType: "system",
    targetId: "notification_settings",
    // Token value NEVER appears in audit payloads.
    details: JSON.stringify({
      field: "telegram_credentials",
      tokenChanged: token !== null,
      chatIdChanged: chatId !== null,
    }),
    result: "success",
    timestamp: nowIso(),
  });

  return load();
}

export async function recordTestOutcome(
  ok: boolean,
  classification: TelegramTestClassification,
): Promise<void> {
  await db
    .update(notificationSettings)
    .set({
      telegramLastTestAt: nowIso(),
      telegramLastTestOk: ok,
      updatedAt: nowIso(),
    })
    .where(eq(notificationSettings.id, 1));
  logger.info(
    { ctx: "notification-settings-store", ok, classification },
    "telegram test outcome recorded",
  );
}

/**
 * Single-attempt POST to Telegram, bypassing the gate. No retry, no
 * cooldown, no bucket consumption. Used only by Test connection.
 */
export async function testConnection(): Promise<TelegramTestResult> {
  const { token, chatId } = await loadForDispatch();
  if (!token || !chatId) {
    await recordTestOutcome(false, "unconfigured");
    return { ok: false, classification: "unconfigured" };
  }

  let resp: Response | null = null;
  let err: Error | null = null;
  try {
    resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: "✅ Test connection from devops-dashboard",
      }),
    });
  } catch (e) {
    err = e instanceof Error ? e : new Error(String(e));
  }

  if (err) {
    await recordTestOutcome(false, "transient");
    return { ok: false, classification: "transient" };
  }

  interface TgBody {
    ok: boolean;
    error_code?: number;
    description?: string;
  }
  const status = resp!.status;
  let body: TgBody | null = null;
  try {
    body = (await resp!.json()) as TgBody;
  } catch {
    body = null;
  }

  if (status >= 200 && status < 300 && body?.ok === true) {
    await recordTestOutcome(true, "success");
    return { ok: true, classification: "success", httpStatus: status };
  }

  if (status === 429 || status >= 500) {
    await recordTestOutcome(false, "transient");
    return {
      ok: false,
      classification: "transient",
      httpStatus: status,
      tgErrorCode: body?.error_code,
      tgErrorDescription: body?.description,
    };
  }

  await recordTestOutcome(false, "permanent");
  return {
    ok: false,
    classification: "permanent",
    httpStatus: status,
    tgErrorCode: body?.error_code,
    tgErrorDescription: body?.description,
  };
}
