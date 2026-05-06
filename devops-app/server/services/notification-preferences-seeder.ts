/**
 * Feature 011 T015 — Idempotent boot-time seeder for notification_preferences.
 *
 * For every entry in EVENT_CATALOGUE that lacks a row in
 * notification_preferences, INSERT one with `enabled = entry.defaultEnabled`.
 * Uses ON CONFLICT DO NOTHING so re-running on an already-seeded DB is a
 * no-op (idempotent per FR-030).
 *
 * Called from server/index.ts during initialisation, after migrations apply.
 */

import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { notificationPreferences } from "../db/schema.js";
import { EVENT_CATALOGUE } from "../lib/event-catalogue.js";
import { logger } from "../lib/logger.js";

export async function seedNotificationPreferences(): Promise<void> {
  if (EVENT_CATALOGUE.length === 0) return;

  const rows = EVENT_CATALOGUE.map((e) => ({
    eventType: e.type,
    enabled: e.defaultEnabled,
    updatedAt: sql`to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
  }));

  await db
    .insert(notificationPreferences)
    .values(rows)
    .onConflictDoNothing({ target: notificationPreferences.eventType });

  logger.info(
    { ctx: "notification-preferences-seeder", count: rows.length },
    "notification preferences seeded",
  );
}
