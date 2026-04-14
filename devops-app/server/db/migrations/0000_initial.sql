CREATE TABLE IF NOT EXISTS "servers" (
  "id" text PRIMARY KEY NOT NULL,
  "label" text NOT NULL,
  "host" text NOT NULL,
  "port" integer NOT NULL DEFAULT 22,
  "ssh_user" text NOT NULL,
  "ssh_key_path" text NOT NULL,
  "scripts_path" text NOT NULL,
  "status" text NOT NULL DEFAULT 'unknown',
  "last_health_check" text,
  "created_at" text NOT NULL
);

CREATE TABLE IF NOT EXISTS "applications" (
  "id" text PRIMARY KEY NOT NULL,
  "server_id" text NOT NULL REFERENCES "servers"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "repo_url" text NOT NULL,
  "branch" text NOT NULL,
  "remote_path" text NOT NULL,
  "deploy_script" text NOT NULL,
  "current_commit" text,
  "current_version" text,
  "env_vars" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" text NOT NULL
);

CREATE TABLE IF NOT EXISTS "deployments" (
  "id" text PRIMARY KEY NOT NULL,
  "application_id" text NOT NULL REFERENCES "applications"("id") ON DELETE CASCADE,
  "server_id" text NOT NULL REFERENCES "servers"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL,
  "type" text NOT NULL,
  "status" text NOT NULL,
  "branch" text NOT NULL,
  "commit_before" text NOT NULL,
  "commit_after" text NOT NULL,
  "started_at" text NOT NULL,
  "finished_at" text,
  "duration" integer,
  "log_file_path" text NOT NULL,
  "error_message" text
);

CREATE INDEX IF NOT EXISTS "idx_deployments_app_started" ON "deployments" ("application_id", "started_at");
CREATE INDEX IF NOT EXISTS "idx_deployments_server_status" ON "deployments" ("server_id", "status");

CREATE TABLE IF NOT EXISTS "backups" (
  "id" text PRIMARY KEY NOT NULL,
  "server_id" text NOT NULL REFERENCES "servers"("id") ON DELETE CASCADE,
  "database_name" text NOT NULL,
  "file_path" text NOT NULL,
  "file_size" integer NOT NULL DEFAULT 0,
  "retention_days" integer NOT NULL DEFAULT 30,
  "expires_at" text NOT NULL,
  "created_at" text NOT NULL,
  "status" text NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_backups_server_created" ON "backups" ("server_id", "created_at");
CREATE INDEX IF NOT EXISTS "idx_backups_expires" ON "backups" ("expires_at");

CREATE TABLE IF NOT EXISTS "health_snapshots" (
  "id" text PRIMARY KEY NOT NULL,
  "server_id" text NOT NULL REFERENCES "servers"("id") ON DELETE CASCADE,
  "timestamp" text NOT NULL,
  "cpu_load_percent" real NOT NULL,
  "memory_percent" real NOT NULL,
  "disk_percent" real NOT NULL,
  "swap_percent" real NOT NULL,
  "docker_containers" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "services" jsonb NOT NULL DEFAULT '[]'::jsonb
);

CREATE INDEX IF NOT EXISTS "idx_health_server_timestamp" ON "health_snapshots" ("server_id", "timestamp");

CREATE TABLE IF NOT EXISTS "audit_entries" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL,
  "action" text NOT NULL,
  "target_type" text NOT NULL,
  "target_id" text NOT NULL,
  "details" text,
  "result" text NOT NULL,
  "timestamp" text NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_audit_timestamp" ON "audit_entries" ("timestamp");

CREATE TABLE IF NOT EXISTS "sessions" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL,
  "expires_at" text NOT NULL,
  "created_at" text NOT NULL
);
