-- Feature 008: Application Domain & TLS.
--
-- Adds the missing data model for domains and certificates:
--   - applications.domain / acme_email / proxy_type / upstream_service / upstream_port
--     (FR-001, FR-002, FR-003 + R-012 upstream addressing pulled from 009)
--   - app_certs (FR-004) — one row per cert lifecycle
--   - app_cert_events (FR-020) — append-only state-transition log
--   - app_settings (FR-005) — key-value store; seeded with NULL acme_email
--   - app_certs.pending_dns_recheck_until (T066 / FR-014a) — DNS double-verify wait window
--
-- ADDITIVE: no destructive changes, no row mutations beyond the SETTINGS seed
-- INSERT. Existing rows get default proxy_type='caddy'; reconciler corrects
-- nginx-legacy rows post-restart (R-008).

ALTER TABLE "applications" ADD COLUMN "domain" TEXT;
ALTER TABLE "applications" ADD COLUMN "acme_email" TEXT;
ALTER TABLE "applications" ADD COLUMN "proxy_type" TEXT NOT NULL DEFAULT 'caddy';
ALTER TABLE "applications" ADD COLUMN "upstream_service" TEXT;
ALTER TABLE "applications" ADD COLUMN "upstream_port" INTEGER;

CREATE UNIQUE INDEX "idx_apps_server_domain_unique"
  ON "applications" ("server_id", "domain")
  WHERE "domain" IS NOT NULL;

ALTER TABLE "applications" ADD CONSTRAINT "applications_domain_format"
  CHECK ("domain" IS NULL OR "domain" ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$');

ALTER TABLE "applications" ADD CONSTRAINT "applications_proxy_type_valid"
  CHECK ("proxy_type" IN ('caddy', 'nginx-legacy', 'none'));

ALTER TABLE "applications" ADD CONSTRAINT "applications_upstream_port_range"
  CHECK ("upstream_port" IS NULL OR ("upstream_port" >= 1 AND "upstream_port" <= 65535));

CREATE TABLE "app_certs" (
  "id" TEXT PRIMARY KEY,
  "app_id" TEXT NOT NULL REFERENCES "applications"("id") ON DELETE CASCADE,
  "domain" TEXT NOT NULL,
  "issuer" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "issued_at" TEXT,
  "expires_at" TEXT,
  "last_renew_at" TEXT,
  "last_renew_outcome" TEXT,
  "error_message" TEXT,
  "retry_after" TEXT,
  "orphaned_at" TEXT,
  "orphan_reason" TEXT NOT NULL DEFAULT '',
  "acme_account_email" TEXT,
  "pending_dns_recheck_until" TEXT,
  "created_at" TEXT NOT NULL
);

CREATE INDEX "idx_app_certs_app_status"     ON "app_certs" ("app_id", "status");
CREATE INDEX "idx_app_certs_status_created" ON "app_certs" ("status", "created_at" DESC);
CREATE INDEX "idx_app_certs_domain_created" ON "app_certs" ("domain", "created_at" DESC);
CREATE INDEX "idx_app_certs_orphaned"       ON "app_certs" ("orphan_reason", "orphaned_at");

ALTER TABLE "app_certs" ADD CONSTRAINT "app_certs_status_valid"
  CHECK ("status" IN ('pending', 'active', 'expired', 'revoked', 'rate_limited', 'failed', 'orphaned', 'pending_reconcile'));

ALTER TABLE "app_certs" ADD CONSTRAINT "app_certs_orphan_reason_valid"
  CHECK ("orphan_reason" IN ('', 'domain_change', 'app_soft_delete', 'manual_orphan'));

ALTER TABLE "app_certs" ADD CONSTRAINT "app_certs_orphan_consistency"
  CHECK (
    ("status" = 'orphaned' AND "orphan_reason" <> '' AND "orphaned_at" IS NOT NULL)
    OR
    ("status" <> 'orphaned' AND "orphan_reason" = '' AND "orphaned_at" IS NULL)
  );

CREATE TABLE "app_cert_events" (
  "id" TEXT PRIMARY KEY,
  "cert_id" TEXT NOT NULL REFERENCES "app_certs"("id") ON DELETE CASCADE,
  "event_type" TEXT NOT NULL,
  "event_data" JSONB,
  "actor" TEXT NOT NULL,
  "occurred_at" TEXT NOT NULL
);

CREATE INDEX "idx_app_cert_events_cert_occurred" ON "app_cert_events" ("cert_id", "occurred_at" DESC);
CREATE INDEX "idx_app_cert_events_type_occurred" ON "app_cert_events" ("event_type", "occurred_at" DESC);

ALTER TABLE "app_cert_events" ADD CONSTRAINT "app_cert_events_type_valid"
  CHECK ("event_type" IN (
    'issued', 'renewed', 'failed', 'orphaned', 'revoked', 'rate_limited',
    'force_renew_requested', 'pending_reconcile_marked', 'pending_reconcile_cleared',
    'expiry_alert_fired', 'hard_delete_partial', 'orphan_cleaned'
  ));

CREATE TABLE "app_settings" (
  "key" TEXT PRIMARY KEY,
  "value" TEXT,
  "updated_at" TEXT NOT NULL
);

INSERT INTO "app_settings" ("key", "value", "updated_at")
VALUES ('acme_email', NULL, NOW()::TEXT);
