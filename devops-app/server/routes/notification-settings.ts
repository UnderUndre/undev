/**
 * Feature 011 T060 — Notification settings + per-event toggle routes.
 *
 * Endpoints:
 *   GET  /api/settings/notifications                       — combined state
 *   PUT  /api/settings/notifications/telegram              — update TG creds
 *   POST /api/settings/notifications/telegram/test         — test connection
 *   PUT  /api/settings/notifications/events/:eventType     — toggle one event
 */

import { Router } from "express";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { notificationPreferences, auditEntries } from "../db/schema.js";
import { validateBody } from "../middleware/validate.js";
import {
  EVENT_CATALOGUE,
  catalogueGet,
} from "../lib/event-catalogue.js";
import {
  load as loadSettings,
  updateTelegram,
  testConnection,
} from "../services/notification-settings-store.js";
import { logger } from "../lib/logger.js";
import { randomUUID } from "node:crypto";

export const notificationSettingsRouter = Router();

const TG_TOKEN_RE = /^\d+:[A-Za-z0-9_-]{30,}$/;
const CHAT_ID_RE = /^(@[A-Za-z][A-Za-z0-9_]{4,31}|-?\d{1,16})$/;

// ── GET /api/settings/notifications ─────────────────────────────────────────

notificationSettingsRouter.get("/settings/notifications", async (_req, res) => {
  const tg = await loadSettings();
  const prefRows = await db
    .select({
      eventType: notificationPreferences.eventType,
      enabled: notificationPreferences.enabled,
    })
    .from(notificationPreferences);
  const prefIndex = new Map(prefRows.map((r) => [r.eventType, r.enabled]));

  const events = EVENT_CATALOGUE.map((e) => ({
    type: e.type,
    description: e.description,
    category: e.category,
    enabled: prefIndex.get(e.type) ?? e.defaultEnabled,
    defaultEnabled: e.defaultEnabled,
  }));

  res.json({ telegram: tg, events });
});

// ── PUT /api/settings/notifications/telegram ────────────────────────────────

const updateTelegramSchema = z
  .object({
    botToken: z
      .string()
      .regex(TG_TOKEN_RE, "Telegram bot token format: <id>:<secret>")
      .nullable(),
    chatId: z
      .string()
      .regex(
        CHAT_ID_RE,
        "Chat ID must be @channel-name or numeric (e.g. -1001234567890)",
      )
      .nullable(),
  })
  .strict();

notificationSettingsRouter.put(
  "/settings/notifications/telegram",
  validateBody(updateTelegramSchema),
  async (req, res) => {
    const body = req.body as z.infer<typeof updateTelegramSchema>;
    const userId =
      (req as typeof req & { userId?: string }).userId ?? "unknown";
    await updateTelegram(body.botToken, body.chatId, userId);
    const tg = await loadSettings();
    const prefRows = await db
      .select({
        eventType: notificationPreferences.eventType,
        enabled: notificationPreferences.enabled,
      })
      .from(notificationPreferences);
    const prefIndex = new Map(prefRows.map((r) => [r.eventType, r.enabled]));
    const events = EVENT_CATALOGUE.map((e) => ({
      type: e.type,
      description: e.description,
      category: e.category,
      enabled: prefIndex.get(e.type) ?? e.defaultEnabled,
      defaultEnabled: e.defaultEnabled,
    }));
    res.json({ telegram: tg, events });
  },
);

// ── POST /api/settings/notifications/telegram/test ──────────────────────────

notificationSettingsRouter.post(
  "/settings/notifications/telegram/test",
  async (_req, res) => {
    const result = await testConnection();
    const testedAt = new Date().toISOString();
    if (result.ok) {
      res.json({ ok: true, testedAt });
      return;
    }
    res.status(502).json({
      ok: false,
      testedAt,
      classification: result.classification,
      httpStatus: result.httpStatus ?? null,
      tgErrorCode: result.tgErrorCode ?? null,
      tgErrorDescription: result.tgErrorDescription ?? null,
    });
  },
);

// ── PUT /api/settings/notifications/events/:eventType ───────────────────────

const toggleEventSchema = z
  .object({
    enabled: z.boolean(),
  })
  .strict();

notificationSettingsRouter.put(
  "/settings/notifications/events/:eventType",
  validateBody(toggleEventSchema),
  async (req, res) => {
    const eventType = req.params.eventType as string;
    const body = req.body as z.infer<typeof toggleEventSchema>;
    const userId =
      (req as typeof req & { userId?: string }).userId ?? "unknown";

    if (!catalogueGet(eventType)) {
      res.status(404).json({
        error: {
          code: "unknown_event_type",
          message: `${eventType} is not in the event catalogue`,
        },
      });
      return;
    }

    const updatedAt = new Date().toISOString();
    // Upsert — first toggle for an event may predate the seeder run (rare),
    // so insert on conflict update keeps the route resilient.
    await db
      .insert(notificationPreferences)
      .values({
        eventType,
        enabled: body.enabled,
        updatedAt: sql`to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
      })
      .onConflictDoUpdate({
        target: notificationPreferences.eventType,
        set: {
          enabled: body.enabled,
          updatedAt: sql`to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
        },
      });

    await db.insert(auditEntries).values({
      id: randomUUID(),
      userId,
      action: "notification.settings_changed",
      targetType: "system",
      targetId: "notification_preferences",
      details: JSON.stringify({
        field: "event_preference",
        eventType,
        newEnabled: body.enabled,
      }),
      result: "success",
      timestamp: updatedAt,
    });

    logger.info(
      { ctx: "notification-settings-route", eventType, enabled: body.enabled },
      "event preference toggled",
    );

    res.json({ eventType, enabled: body.enabled, updatedAt });
  },
);
