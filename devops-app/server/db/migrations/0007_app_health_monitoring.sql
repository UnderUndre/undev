-- Feature 006: per-app health monitoring + cert/Caddy probes.
--
-- ADDITIVE migration: 8 new columns on applications + new app_health_probes table.
-- No backfill — health_status defaults to 'unknown', converges on first probe cycle
-- (FR-008: unknown → healthy is silent, no rollout alert spam).
--
-- The XOR(app_id, server_id) constraint on app_health_probes lets per-server probes
-- (caddy_admin per FR-006b) coexist with per-app probes (container, http, cert_expiry)
-- in one table — keeps the prune logic and indexes DRY (R-013).
--
-- DOWN migration (manual, operator-gated — destructive):
--   DROP TABLE "app_health_probes";
--   ALTER TABLE "applications" DROP COLUMN "alerts_muted",
--                              DROP COLUMN "monitoring_enabled",
--                              DROP COLUMN "health_debounce_count",
--                              DROP COLUMN "health_probe_interval_sec",
--                              DROP COLUMN "health_message",
--                              DROP COLUMN "health_last_change_at",
--                              DROP COLUMN "health_checked_at",
--                              DROP COLUMN "health_status",
--                              DROP COLUMN "health_url";

ALTER TABLE "applications"
  ADD COLUMN "health_url"                  TEXT,
  ADD COLUMN "health_status"               TEXT NOT NULL DEFAULT 'unknown',
  ADD COLUMN "health_checked_at"           TEXT,
  ADD COLUMN "health_last_change_at"       TEXT,
  ADD COLUMN "health_message"              TEXT,
  ADD COLUMN "health_probe_interval_sec"   INTEGER NOT NULL DEFAULT 60,
  ADD COLUMN "health_debounce_count"       INTEGER NOT NULL DEFAULT 2,
  ADD COLUMN "monitoring_enabled"          BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN "alerts_muted"                BOOLEAN NOT NULL DEFAULT FALSE;

-- FR-002 lower bound 10s (guard against self-DoS); FR-007 minimum debounce 1.
ALTER TABLE "applications" ADD CONSTRAINT "applications_health_probe_interval_min"
  CHECK ("health_probe_interval_sec" >= 10);
ALTER TABLE "applications" ADD CONSTRAINT "applications_health_debounce_min"
  CHECK ("health_debounce_count" >= 1);

CREATE TABLE "app_health_probes" (
  "id"                TEXT PRIMARY KEY,
  "app_id"            TEXT REFERENCES "applications"("id") ON DELETE CASCADE,
  "server_id"         TEXT REFERENCES "servers"("id")      ON DELETE CASCADE,
  "probed_at"         TEXT NOT NULL,
  "probe_type"        TEXT NOT NULL,                  -- container | http | cert_expiry | caddy_admin
  "outcome"           TEXT NOT NULL,                  -- healthy | unhealthy | warning | error
  "latency_ms"        INTEGER,
  "status_code"       INTEGER,
  "error_message"     TEXT,
  "container_status"  TEXT,
  CONSTRAINT "app_health_probes_subject_xor"
    CHECK ((app_id IS NOT NULL AND server_id IS NULL) OR
           (app_id IS NULL AND server_id IS NOT NULL))
);

-- App detail sparkline (last 24h ordered by time)
CREATE INDEX "idx_app_health_probes_app_probed"
  ON "app_health_probes" ("app_id", "probed_at" DESC);
-- Server-scoped Caddy probe history
CREATE INDEX "idx_app_health_probes_server_probed"
  ON "app_health_probes" ("server_id", "probed_at" DESC);
-- Status filtering ("show only failing container probes for app X")
CREATE INDEX "idx_app_health_probes_app_type_outcome"
  ON "app_health_probes" ("app_id", "probe_type", "outcome");
-- Retention prune (delete by age)
CREATE INDEX "idx_app_health_probes_probed"
  ON "app_health_probes" ("probed_at" DESC);
