-- Feature 005: Universal Script Runner.
-- Two changes (atomic per A-002):
--   1. Drop applications.deploy_script — replaced by resolveDeployOperation().
--   2. Create script_runs table + three indexes for the runner's history.

ALTER TABLE "applications" DROP COLUMN "deploy_script";

CREATE TABLE "script_runs" (
  "id" TEXT PRIMARY KEY,
  "script_id" TEXT NOT NULL,
  "server_id" TEXT REFERENCES "servers"("id") ON DELETE SET NULL,
  "deployment_id" TEXT REFERENCES "deployments"("id") ON DELETE SET NULL,
  "user_id" TEXT NOT NULL,
  "params" JSONB NOT NULL,
  "status" TEXT NOT NULL,
  "started_at" TEXT NOT NULL,
  "finished_at" TEXT,
  "duration" INTEGER,
  "exit_code" INTEGER,
  "output_artifact" JSONB,
  "error_message" TEXT,
  "log_file_path" TEXT NOT NULL
);

CREATE INDEX "idx_script_runs_server_started" ON "script_runs" ("server_id", "started_at" DESC);
CREATE INDEX "idx_script_runs_script_started" ON "script_runs" ("script_id", "started_at" DESC);
CREATE INDEX "idx_script_runs_started"        ON "script_runs" ("started_at" DESC);
