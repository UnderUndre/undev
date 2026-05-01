-- Feature 009: Bootstrap deploy from GitHub repo.
--
-- Adds the missing data model for the bootstrap state machine:
--   - applications.bootstrap_state         (FR-008/FR-009 — current state)
--   - applications.bootstrap_auto_retry    (FR-022 — opt-in auto-retry)
--   - applications.compose_path            (FR-007 — relative compose path)
--   - applications.created_via             (FR-032 — manual | scan | bootstrap)
--   - app_bootstrap_events                 (FR-010 — append-only audit)
--
-- NOTE: `upstream_service` and `upstream_port` already shipped in feature
-- 008 (`0008_application_domain_and_tls.sql`); they are NOT re-added here.
--
-- The CHECK constraint for `bootstrap_state` includes the
-- `failed_clone_pat_expired` terminal state per FR-016a (Gemini/GPT review
-- pass) — folded in here rather than landing as a follow-up 0010 because
-- 0009 has not yet shipped to prod (T065 / spec.md Phase 8).
--
-- ADDITIVE: no destructive changes. Existing rows back-fill to:
--   bootstrap_state      = 'active'
--   bootstrap_auto_retry = false
--   compose_path         = 'docker-compose.yml'
--   created_via          = 'scan'   IF skip_initial_clone = TRUE
--                          'manual' OTHERWISE

ALTER TABLE "applications" ADD COLUMN "bootstrap_state" TEXT NOT NULL DEFAULT 'active';
ALTER TABLE "applications" ADD COLUMN "bootstrap_auto_retry" BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE "applications" ADD COLUMN "compose_path" TEXT NOT NULL DEFAULT 'docker-compose.yml';
ALTER TABLE "applications" ADD COLUMN "created_via" TEXT NOT NULL DEFAULT 'manual';

-- Backfill: scan-imported apps (feature 003 marker) → 'scan'.
UPDATE "applications"
   SET "created_via" = 'scan'
 WHERE "skip_initial_clone" = TRUE;

-- Enum constraints
ALTER TABLE "applications" ADD CONSTRAINT "applications_bootstrap_state_enum"
  CHECK ("bootstrap_state" IN (
    'init', 'cloning', 'compose_up', 'healthcheck',
    'proxy_applied', 'cert_issued', 'active',
    'failed_clone', 'failed_clone_pat_expired',
    'failed_compose', 'failed_healthcheck',
    'failed_proxy', 'failed_cert'
  ));

ALTER TABLE "applications" ADD CONSTRAINT "applications_created_via_enum"
  CHECK ("created_via" IN ('manual', 'scan', 'bootstrap'));

-- Append-only audit of every state transition.
CREATE TABLE "app_bootstrap_events" (
  "id" TEXT PRIMARY KEY,
  "app_id" TEXT NOT NULL REFERENCES "applications"("id") ON DELETE CASCADE,
  "from_state" TEXT NOT NULL,
  "to_state" TEXT NOT NULL,
  -- Locale-independent ISO-8601 UTC timestamp string, matches the
  -- shape produced by `new Date().toISOString()` in Node code paths.
  "occurred_at" TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
  "metadata" JSONB,
  "actor" TEXT NOT NULL DEFAULT 'system'
);

CREATE INDEX "idx_app_bootstrap_events_app_occurred"
  ON "app_bootstrap_events" ("app_id", "occurred_at" DESC);
CREATE INDEX "idx_app_bootstrap_events_to_state"
  ON "app_bootstrap_events" ("to_state");

-- DOWN migration (manual, operator-gated — destructive):
--   DROP INDEX "idx_app_bootstrap_events_to_state";
--   DROP INDEX "idx_app_bootstrap_events_app_occurred";
--   DROP TABLE "app_bootstrap_events";
--   ALTER TABLE "applications" DROP CONSTRAINT "applications_created_via_enum";
--   ALTER TABLE "applications" DROP CONSTRAINT "applications_bootstrap_state_enum";
--   ALTER TABLE "applications" DROP COLUMN "created_via";
--   ALTER TABLE "applications" DROP COLUMN "compose_path";
--   ALTER TABLE "applications" DROP COLUMN "bootstrap_auto_retry";
--   ALTER TABLE "applications" DROP COLUMN "bootstrap_state";
