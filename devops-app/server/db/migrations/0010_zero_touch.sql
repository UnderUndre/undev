-- Feature 011: Zero-Touch VPS Onboarding & Secrets Management.
-- Additive only. NULL defaults for new nullable columns; new NOT NULL
-- columns get a safe enum default. No data movement here — lazy migration
-- happens at first edit through the new editors (R-011).

BEGIN;

-- ── servers: 7 new columns + composite index ────────────────────────────
ALTER TABLE "servers"
  ADD COLUMN "ssh_private_key_encrypted" TEXT NULL,
  ADD COLUMN "ssh_password_encrypted"    TEXT NULL,
  ADD COLUMN "ssh_key_fingerprint"       TEXT NULL,
  ADD COLUMN "ssh_key_rotated_at"        TEXT NULL,
  ADD COLUMN "host_key_fingerprint"      TEXT NULL,
  ADD COLUMN "cloud_provider"            TEXT NULL,
  ADD COLUMN "setup_state"               TEXT NOT NULL DEFAULT 'unknown';

ALTER TABLE "servers"
  ADD CONSTRAINT "servers_setup_state_check"
    CHECK ("setup_state" IN ('unknown', 'needs_initialisation', 'initialising', 'ready'));

ALTER TABLE "servers"
  ADD CONSTRAINT "servers_cloud_provider_check"
    CHECK ("cloud_provider" IS NULL OR "cloud_provider" IN ('gcp', 'aws', 'do', 'hetzner', 'vanilla'));

CREATE INDEX "idx_servers_status_setup_state"
  ON "servers" ("status", "setup_state");

-- ── applications: per-key encrypted env vars ────────────────────────────
ALTER TABLE "applications"
  ADD COLUMN "env_vars_encrypted" JSONB NULL;

-- ── notification_preferences (per-event toggle) ─────────────────────────
CREATE TABLE "notification_preferences" (
  "event_type" TEXT PRIMARY KEY,
  "enabled"    BOOLEAN NOT NULL,
  "updated_at" TEXT NOT NULL DEFAULT (
    to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  )
);

-- ── notification_settings (singleton) ───────────────────────────────────
CREATE TABLE "notification_settings" (
  "id"                            INTEGER PRIMARY KEY CHECK ("id" = 1),
  "telegram_bot_token_encrypted"  TEXT NULL,
  "telegram_chat_id"              TEXT NULL,
  "telegram_last_test_at"         TEXT NULL,
  "telegram_last_test_ok"         BOOLEAN NOT NULL DEFAULT FALSE,
  "master_key_canary"             TEXT NULL,
  "updated_at"                    TEXT NOT NULL
);

INSERT INTO "notification_settings" ("id", "updated_at")
VALUES (1, to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));

COMMIT;

-- ── DOWN migration (reviewable; not executed automatically) ─────────────
-- BEGIN;
-- DROP TABLE "notification_settings";
-- DROP TABLE "notification_preferences";
-- ALTER TABLE "applications" DROP COLUMN "env_vars_encrypted";
-- DROP INDEX "idx_servers_status_setup_state";
-- ALTER TABLE "servers"
--   DROP CONSTRAINT "servers_cloud_provider_check",
--   DROP CONSTRAINT "servers_setup_state_check",
--   DROP COLUMN "setup_state",
--   DROP COLUMN "cloud_provider",
--   DROP COLUMN "host_key_fingerprint",
--   DROP COLUMN "ssh_key_rotated_at",
--   DROP COLUMN "ssh_key_fingerprint",
--   DROP COLUMN "ssh_password_encrypted",
--   DROP COLUMN "ssh_private_key_encrypted";
-- COMMIT;
