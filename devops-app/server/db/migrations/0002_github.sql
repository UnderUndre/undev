-- GitHub integration: singleton connection table + app.github_repo column

-- Singleton table: exactly one row enforced by CHECK constraint
CREATE TABLE IF NOT EXISTS "github_connection" (
  "id" text PRIMARY KEY CHECK ("id" = 'DEFAULT'),
  "token" text NOT NULL,
  "username" text NOT NULL,
  "avatar_url" text NOT NULL,
  "token_expires_at" text,
  "connected_at" text NOT NULL
);

-- Link applications to GitHub repositories ("owner/repo"), nullable for non-GitHub apps
ALTER TABLE "applications" ADD COLUMN IF NOT EXISTS "github_repo" text;
