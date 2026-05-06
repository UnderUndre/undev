-- Feature 010: Operational Maturity.
-- Adds 4 lifecycle-hook columns to `applications`, extends `created_via`
-- enum to include `'migrate'`, and adds the FR-013a layer-4 mutual-exclusion
-- CHECK constraint (script_path ↔ hooks).
--
-- Cross-feature note: feature 011 occupies 0010_zero_touch.sql on a sibling
-- branch. When both merge to main the sequence is 0010 → 0011 (alphabetical,
-- also matches spec creation order).

-- 4 new hook columns. NULL by default — every existing row stays valid
-- against the mutex CHECK below regardless of `script_path`.
ALTER TABLE "applications" ADD COLUMN "pre_deploy_script_path" TEXT;
ALTER TABLE "applications" ADD COLUMN "post_deploy_script_path" TEXT;
ALTER TABLE "applications" ADD COLUMN "on_fail_script_path" TEXT;
ALTER TABLE "applications" ADD COLUMN "pre_destroy_script_path" TEXT;

-- Extend `created_via` enum to include `'migrate'` per R-003. PG has no
-- native enum modify-in-place; CHECK constraints are dropped and re-added.
ALTER TABLE "applications" DROP CONSTRAINT IF EXISTS "applications_created_via_enum";
ALTER TABLE "applications" ADD CONSTRAINT "applications_created_via_enum"
  CHECK ("created_via" IN ('manual', 'scan', 'bootstrap', 'migrate'));

-- FR-013a layer 4 — mutual exclusion between `script_path` (feature 007's
-- whole-deploy override) and the per-stage hooks. If `script_path` is
-- non-NULL, ALL four hook columns MUST be NULL. If `script_path` IS NULL,
-- any combination of hooks is permitted (zero or more).
ALTER TABLE "applications" ADD CONSTRAINT "applications_script_path_hooks_mutex"
  CHECK (
    "script_path" IS NULL
    OR (
      "pre_deploy_script_path" IS NULL
      AND "post_deploy_script_path" IS NULL
      AND "on_fail_script_path" IS NULL
      AND "pre_destroy_script_path" IS NULL
    )
  );

-- DOWN migration (manual, operator-gated — destructive):
--   WARNING: rows with `created_via='migrate'` will block constraint restore.
--   Migrate them to a different origin first, e.g.:
--     UPDATE "applications" SET "created_via" = 'manual' WHERE "created_via" = 'migrate';
--   Then:
--     ALTER TABLE "applications" DROP CONSTRAINT "applications_script_path_hooks_mutex";
--     ALTER TABLE "applications" DROP CONSTRAINT "applications_created_via_enum";
--     ALTER TABLE "applications" ADD CONSTRAINT "applications_created_via_enum"
--       CHECK ("created_via" IN ('manual', 'scan', 'bootstrap'));
--     ALTER TABLE "applications" DROP COLUMN "pre_destroy_script_path";
--     ALTER TABLE "applications" DROP COLUMN "on_fail_script_path";
--     ALTER TABLE "applications" DROP COLUMN "post_deploy_script_path";
--     ALTER TABLE "applications" DROP COLUMN "pre_deploy_script_path";
