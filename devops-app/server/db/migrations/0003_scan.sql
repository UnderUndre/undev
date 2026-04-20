-- Scan server for existing repositories and Docker apps
--
-- servers.scan_roots  — configurable directories traversed by POST /api/servers/:id/scan
-- applications.skip_initial_clone — true for scan-imported apps; deploy runner uses
--                                    `git fetch origin <branch> && git reset --hard FETCH_HEAD`
--                                    instead of `git clone`.

ALTER TABLE "servers"
  ADD COLUMN "scan_roots" JSONB NOT NULL DEFAULT '["/opt","/srv","/var/www","/home"]'::jsonb;

ALTER TABLE "applications"
  ADD COLUMN "skip_initial_clone" BOOLEAN NOT NULL DEFAULT FALSE;
