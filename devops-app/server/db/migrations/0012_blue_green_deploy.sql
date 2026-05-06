-- Feature 012: Blue/Green Deploy with Connection Drain.
-- Additive ALTERs only. Adds 6 columns to `applications`, 2 CHECK
-- constraints, 1 partial index. DOWN migration commented at bottom.
--
-- Cross-feature note: features 010 (0011_operational_maturity) and 011
-- (0010_zero_touch) must merge BEFORE this one. Sequence at integration:
-- 0010 → 0011 → 0012.

ALTER TABLE "applications" ADD COLUMN "deploy_strategy" TEXT NOT NULL DEFAULT 'recreate';
ALTER TABLE "applications" ADD COLUMN "drain_seconds" INTEGER NOT NULL DEFAULT 30;
ALTER TABLE "applications" ADD COLUMN "green_healthcheck_timeout_seconds" INTEGER NOT NULL DEFAULT 60;
ALTER TABLE "applications" ADD COLUMN "active_color" TEXT NULL;
ALTER TABLE "applications" ADD COLUMN "deploy_state" TEXT NULL;
ALTER TABLE "applications" ADD COLUMN "deploy_state_started_at" TEXT NULL;

ALTER TABLE "applications" ADD CONSTRAINT "applications_deploy_strategy_enum"
  CHECK ("deploy_strategy" IN ('recreate', 'blue_green'));

ALTER TABLE "applications" ADD CONSTRAINT "applications_active_color_enum"
  CHECK ("active_color" IS NULL OR "active_color" IN ('blue', 'green'));

-- deploy_state enum is intentionally NOT a CHECK constraint to allow
-- forward-compat. Validation lives in `blue-green-state-machine.ts`.

-- Partial index speeds up boot-time interrupted-deploys scan. Column is
-- NULL for the vast majority of rows.
CREATE INDEX "idx_applications_deploy_state_active"
  ON "applications" ("deploy_state")
  WHERE "deploy_state" IS NOT NULL;

-- DOWN migration (manual, operator-gated — destructive):
--   WARNING: rows with `deploy_state IS NOT NULL` (interrupted deploys)
--   must be cleaned up first via the operator panel (Resume / Abort /
--   Mark complete). Otherwise dropping the column abandons in-flight
--   recovery context.
--
-- DROP INDEX IF EXISTS "idx_applications_deploy_state_active";
-- ALTER TABLE "applications" DROP CONSTRAINT "applications_active_color_enum";
-- ALTER TABLE "applications" DROP CONSTRAINT "applications_deploy_strategy_enum";
-- ALTER TABLE "applications" DROP COLUMN "deploy_state_started_at";
-- ALTER TABLE "applications" DROP COLUMN "deploy_state";
-- ALTER TABLE "applications" DROP COLUMN "active_color";
-- ALTER TABLE "applications" DROP COLUMN "green_healthcheck_timeout_seconds";
-- ALTER TABLE "applications" DROP COLUMN "drain_seconds";
-- ALTER TABLE "applications" DROP COLUMN "deploy_strategy";
