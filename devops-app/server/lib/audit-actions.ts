/**
 * Feature 011 T074 — registry of all audit actions emitted by feature 011.
 *
 * The existing `auditMiddleware` doesn't enforce a whitelist (it accepts
 * any action via free-form route parsing), so this file is the canonical
 * documentation + Zod-validated payload schemas for the new actions.
 *
 * Direct callers of `db.insert(auditEntries)` for these actions should
 * use the helpers in this file when convenient — they enforce the
 * payload shape at runtime so future drift surfaces in tests rather than
 * in production audit logs.
 */

import { z } from "zod";

export const ServerAddedPayload = z.object({
  authMethod: z.enum(["key", "password", "generated"]),
  keyFingerprint: z.string().nullable(),
  cloudProvider: z.string().nullable(),
});

export const ServerInitialisedPayload = z.object({
  deployUser: z.string(),
  options: z.object({
    swapSize: z.string(),
    ufwPorts: z.array(z.number()),
    useNoPty: z.boolean(),
  }),
});

export const ServerKeyRotatedPayload = z.object({
  oldFingerprint: z.string().nullable(),
  newFingerprint: z.string(),
});

export const AppEnvVarsChangedPayload = z.object({
  addedKeys: z.array(z.string()),
  removedKeys: z.array(z.string()),
  changedKeys: z.array(z.string()),
});

export const AppEnvVarsImportedFromExamplePayload = z.object({
  importedKeys: z.array(z.string()),
  changeMeKeys: z.array(z.string()),
});

export const NotificationDroppedTelegramUnconfiguredPayload = z.object({
  eventType: z.string(),
  resourceId: z.string().optional(),
});

export const NotificationDroppedThrottledPayload = z.object({
  eventType: z.string(),
  resourceId: z.string(),
  reason: z.enum(["cooldown", "token_bucket"]),
  suppressedCount: z.number().optional(),
  windowExpiresAt: z.string().optional(),
});

export const NotificationDroppedDeliveryFailedPayload = z.object({
  eventType: z.string(),
  resourceId: z.string(),
  classification: z.enum(["transient", "permanent"]),
  reason: z.string(),
  retryCount: z.number(),
  tgErrorCode: z.number().optional(),
  tgErrorDescription: z.string().optional(),
});

export const NotificationSettingsChangedPayload = z.object({
  field: z.enum([
    "telegram_credentials",
    "telegram_token",
    "telegram_chat_id",
    "event_preference",
  ]),
  eventType: z.string().optional(),
  newEnabled: z.boolean().optional(),
  tokenChanged: z.boolean().optional(),
  chatIdChanged: z.boolean().optional(),
});

/**
 * Canonical list of feature-011 audit actions. Used by tests + a
 * potential future strict middleware that wants to refuse unknown
 * action strings.
 */
export const FEATURE_011_AUDIT_ACTIONS = [
  "server.added",
  "server.initialised",
  "server.key_rotated",
  "app.env_vars_changed",
  "app.env_vars_imported_from_example",
  "notification.dropped.telegram_unconfigured",
  "notification.dropped.throttled",
  "notification.dropped.delivery_failed",
  "notification.settings_changed",
] as const;

export type Feature011AuditAction = (typeof FEATURE_011_AUDIT_ACTIONS)[number];
