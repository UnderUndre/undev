-- Feature 007: project-local deploy script dispatch.
--
-- Adds the optional `script_path` column on `applications`. When non-null, the
-- runner dispatches `deploy/project-local-deploy` (executes
-- `bash <remote_path>/<script_path>` on the target) instead of the builtin
-- `deploy/server-deploy`.
--
-- This migration is ADDITIVE: no backfill, no destructive change. Existing
-- rows stay NULL → existing dispatch unchanged (FR-021, SC-002).
--
-- DOWN migration (manual, operator-gated — destructive):
--   ALTER TABLE "applications" DROP CONSTRAINT "applications_script_path_non_empty";
--   ALTER TABLE "applications" DROP COLUMN "script_path";

ALTER TABLE "applications" ADD COLUMN "script_path" TEXT;

-- NULL-only invariant (FR-001, FR-003): the column never stores '' or
-- all-whitespace. The API normalises empty/whitespace → NULL before insert;
-- this CHECK is the defence-of-last-resort against API bypass (manual SQL,
-- ORM bug, future migration, test fixture).
ALTER TABLE "applications" ADD CONSTRAINT "applications_script_path_non_empty"
  CHECK ("script_path" IS NULL OR LENGTH(TRIM("script_path")) > 0);
