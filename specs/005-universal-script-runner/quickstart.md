# Quickstart: Universal Script Runner

**Date**: 2026-04-22

How to add a new runnable operation from scratch after feature 005 ships.

---

## Scenario: add `db/vacuum.sh` to the dashboard

### Step 1 — write the bash script

Create `scripts/db/vacuum.sh`:

```bash
#!/bin/bash
source "$(dirname "$0")/common.sh"

# Parse flags
DATABASE=""
FULL=false
for arg in "$@"; do
  case "$arg" in
    --database=*) DATABASE="${arg#--database=}" ;;
    --full)       FULL=true ;;
  esac
done

[[ -z "$DATABASE" ]] && { error "missing --database"; exit 1; }

log "Vacuuming $DATABASE (full=$FULL)"
if $FULL; then
  psql -d "$DATABASE" -c "VACUUM FULL;"
else
  psql -d "$DATABASE" -c "VACUUM;"
fi
log "Done"
```

Commit the file. No `chmod +x` needed — scripts are piped to `bash -s` on the remote, not executed as files.

### Step 2 — register the manifest entry

Edit `devops-app/server/scripts-manifest.ts`:

```ts
import { z } from "zod";

export const manifest: ScriptManifestEntry[] = [
  // ... existing entries ...
  {
    id: "db/vacuum",
    category: "db",
    description: "Vacuum a Postgres database",
    locus: "target",
    params: z.object({
      database: z.string(),
      full: z.boolean().default(false),
    }),
  },
];
```

### Step 3 — commit both files, redeploy dashboard

```bash
git add scripts/db/vacuum.sh devops-app/server/scripts-manifest.ts
git commit -m "feat(scripts): add db/vacuum operation"
git push
```

After merge and dashboard redeploy, the operation appears automatically on every server's **Scripts** tab under the **Database** category. Admins can click **Run**, fill in `database` (required text field) and `full` (checkbox pre-filled as unchecked), and execute.

No route, no service, no UI, no migration.

---

## Validation after adding a new entry

Dashboard startup logs on successful validation:

```
{"level":30,"ctx":"scripts-manifest","count":11,"msg":"Manifest validated"}
```

On failure (missing file, duplicate id, broken Zod):

```
{"level":60,"ctx":"scripts-manifest","id":"db/vacuum","err":"ENOENT: scripts/db/vacuum.sh","msg":"Invalid manifest entry"}
```

…and the process exits with code 1. The dashboard does not start until the manifest is clean.

---

## Secret parameters

If a script needs a credential at runtime:

```ts
{
  id: "db/restore-from-s3",
  category: "db",
  description: "Restore DB from S3 backup",
  locus: "target",
  dangerLevel: "high",
  params: z.object({
    database: z.string(),
    s3Key: z.string(),
    s3SecretAccessKey: z.string().describe("secret"),  // marker
  }),
},
```

The runner:
- Passes non-secret params as `--database='...' --s3-key='...'` argv.
- Passes the secret as `env SECRET_S3_SECRET_ACCESS_KEY='...' bash -s ...`.
- The script reads it via `$SECRET_S3_SECRET_ACCESS_KEY`.
- `script_runs.params.s3SecretAccessKey` persists as `"***"`.
- Audit log and WS log stream never see the real value.
- Real value lives only in server RAM for the duration of the run.

Inside the script:

```bash
AWS_SECRET_ACCESS_KEY="$SECRET_S3_SECRET_ACCESS_KEY" aws s3 cp "s3://bucket/$s3_key" /tmp/dump.sql
```

---

## Scripts that need a deploy lock

Declare `requiresLock: true` on the manifest entry. The runner will:

1. Call `deployLock.acquireLock(serverId, scriptRun.id)` before SSH.
2. Return `409 DEPLOYMENT_LOCKED` to the client if the lock is held.
3. Release the lock on terminal status (success / failed / cancelled / timeout).

Use this for any script that writes state the deploy relies on (DB restore, config rewrite) OR that conflicts with a concurrent deploy script (same migration run, same restart, etc.).

---

## Danger level

`dangerLevel: "high"` on a manifest entry makes the Run dialog require the admin to type the script's `id` as a confirmation string before the Run button enables. Use for irreversible operations (`db/restore`, `docker/cleanup --include-images` if it wiped things, etc.).

Server-side: no enforcement — the gate is UX friction. Malicious admin behaviour is out of scope.

---

## Deploy flows

Admins do NOT go through the Scripts tab for ordinary deploys. The existing **Deploy** button on an application still works — it now calls `scriptsRunner.runScript(resolveDeployOperation(app), ...)` internally. Scripts tab is for **ad-hoc / operational / non-app-scoped** tasks.

Rollback similarly: **Rollback** button on a deployment row, runner picks `deploy/rollback`, dispatches with the right commit.

---

## Viewing run history

**Sidebar → Runs** lists the last 50 runs across all servers. Filters: status, server, script id. Clicking a row opens the live-or-post-mortem log view (same component for both states — just streams from WS if still running, from the log file if complete).

Each run has:
- Script id + category (visible header).
- Server link (unless server was deleted — then greyed out).
- User who triggered it.
- Params (with `"***"` for secrets).
- Status + exit code + error message.
- Output artefact (if manifest declared one) — e.g. "Backup file: `/backups/mydb-2026-04-22.sql.gz`".
- Full log tail.
- "Re-run" button (hidden for archived scripts).

---

## Retention

Rows older than `SCRIPT_RUNS_RETENTION_DAYS` (default 90) are pruned at dashboard startup. Their log files are deleted in the same pass. Tune via env:

```bash
SCRIPT_RUNS_RETENTION_DAYS=30 npm start
```

---

## Constraints

- Scripts run **one at a time per (server, lock-requiring category)** when `requiresLock: true`.
- Scripts without `requiresLock` run concurrently — the manifest author declares the concurrency contract.
- Scripts time out at `manifest.timeout ?? 30 min`. Override via env `SCRIPT_RUN_DEFAULT_TIMEOUT_MS` if you want a global floor/ceiling.
- Scripts cannot be cancelled mid-run in v1 (except legacy deploy/rollback via the existing cancel UI).
- Scripts run against **one server at a time**. Multi-server fan-out is v2.
- Scripts from `scripts/dev/` and `scripts/server/setup-*.sh` are NOT in the v1 manifest (developer-only / bootstrap-only).

---

## Troubleshooting

**"Manifest validation failed at startup"** — check the latest PR that touched `scripts-manifest.ts` or any file under `scripts/*/`. Common causes: renamed a script file but forgot the manifest; typo in `id` colliding with existing; Zod schema has a syntax error.

**"Script hangs at 'Running' forever"** — SSH lost the connection mid-run. Wait for the timeout (30 min default) or restart the dashboard (the SIGTERM handler cleans up deploy locks and any `requiresLock` runs).

**"Output artefact is `null` but the script ran fine"** — the manifest's `outputArtifact.captureFrom` is `stdout-last-line` and the script's last output line wasn't what you expected (log messages etc.). Use `captureFrom: "stdout-json"` and emit a `{"type":"result","data":...}` line at the end instead.

**"Secret parameter is visible in `script_runs.params`"** — check the Zod field has `.describe("secret")`. Without it, the param is treated as plain.
