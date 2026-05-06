/**
 * Feature 011 T073 — fail-fast boot validation.
 *
 * Verifies that:
 *   1. DASHBOARD_MASTER_KEY is set and well-formed (the envelope-cipher
 *      module already throws on import if not — this layer just makes the
 *      crash message actionable for operators).
 *   2. notification_settings singleton row exists.
 *   3. master_key_canary decrypts (proves the env-var key still matches
 *      the key that sealed existing secrets). On first boot when the
 *      canary is NULL, seal "ok" with the current key and persist — this
 *      is the one-time bootstrap.
 *
 * Throws on any irrecoverable mismatch with an actionable message.
 * Caller is server/index.ts before any route registration.
 */

import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { notificationSettings } from "../db/schema.js";
import { seal, open, type EnvelopeBlob } from "./envelope-cipher.js";
import { logger } from "./logger.js";

export async function runBootChecks(): Promise<void> {
  // 1. envelope-cipher import has already validated DASHBOARD_MASTER_KEY
  //    by the time this function runs — bare reach-through assertion.
  if (!process.env.DASHBOARD_MASTER_KEY) {
    throw new Error(
      "DASHBOARD_MASTER_KEY missing — set it in your environment before boot. " +
        "Generate with `openssl rand -base64 32`. Loss = irreversible secret loss.",
    );
  }

  // 2. notification_settings singleton row check.
  const rows = await db
    .select()
    .from(notificationSettings)
    .where(eq(notificationSettings.id, 1))
    .limit(1);
  const row = rows[0];
  if (!row) {
    throw new Error(
      "notification_settings singleton row missing — run migration 0010_zero_touch.sql",
    );
  }

  // 3. master-key canary.
  if (row.masterKeyCanary === null) {
    // First boot — seal "ok" with the current key.
    const blob = seal("ok");
    await db
      .update(notificationSettings)
      .set({
        masterKeyCanary: JSON.stringify(blob),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(notificationSettings.id, 1));
    logger.info(
      { ctx: "boot-checks" },
      "master-key canary seeded (first boot)",
    );
    return;
  }

  let blob: EnvelopeBlob;
  try {
    blob = JSON.parse(row.masterKeyCanary) as EnvelopeBlob;
  } catch {
    throw new Error(
      "master_key_canary corrupted (not valid JSON). Either restore the correct " +
        "DASHBOARD_MASTER_KEY or wipe the encrypted columns and re-onboard.",
    );
  }

  let decoded: string;
  try {
    decoded = open(blob);
  } catch (err) {
    throw new Error(
      "master-key canary failed to decrypt — DASHBOARD_MASTER_KEY does NOT match " +
        "the key used to seal existing secrets. Either restore the correct key " +
        "or wipe the encrypted columns and re-onboard. Underlying error: " +
        (err instanceof Error ? err.message : String(err)),
    );
  }
  if (decoded !== "ok") {
    throw new Error(
      `master-key canary value unexpected (${JSON.stringify(decoded)}); ` +
        "DB corruption suspected. Investigate before continuing.",
    );
  }

  logger.info({ ctx: "boot-checks" }, "master-key canary verified");
}
