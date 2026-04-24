# Quickstart: Project-Local Deploy

**Date**: 2026-04-24

How to adopt project-local deploy for an existing application after feature 007 ships. Written for project maintainers (not dashboard developers).

---

## Scenario: ai-digital-twins adopts project-local deploy

You're the maintainer of an app currently deployed via the dashboard's builtin `deploy/server-deploy` script. Your project needs an extra step (database migration, cache flush, asset upload — anything) that the builtin doesn't do. Today that extra step is silently skipped on every deploy, which is how the 2026-04-22 incident happened.

After this feature ships, the fix is:

### Step 1 — Write the project-local deploy script

Commit a bash script inside your repo at a relative path of your choosing. The convention is `scripts/devops-deploy.sh`, but any relative, non-metachar path works.

The script MUST accept these flags (it can ignore any it doesn't need — unknown flags don't error):

| Flag | Type | Source |
|------|------|--------|
| `--app-dir=<path>` | required | the application's `remotePath` on target |
| `--branch=<name>` | required | the UI-selected branch (or app default) |
| `--commit=<sha>` | optional | present when operator deploys a specific commit |
| `--no-cache` | boolean flag | present when operator ticks "No cache" |
| `--skip-cleanup` | boolean flag | present when operator ticks "Skip cleanup" |

Minimal example (`scripts/devops-deploy.sh`):

```bash
#!/usr/bin/env bash
# Project-local deploy script for <my-app>.
# Invoked by the DevOps dashboard via `bash <app-dir>/scripts/devops-deploy.sh <flags>`.

set -euo pipefail

# ── Parse flags ────────────────────────────────────────────────────────────
APP_DIR=""
BRANCH=""
COMMIT=""
NO_CACHE=false
SKIP_CLEANUP=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --app-dir=*)      APP_DIR="${1#--app-dir=}"; shift ;;
    --branch=*)       BRANCH="${1#--branch=}"; shift ;;
    --commit=*)       COMMIT="${1#--commit=}"; shift ;;
    --no-cache)       NO_CACHE=true; shift ;;
    --skip-cleanup)   SKIP_CLEANUP=true; shift ;;
    *)                shift ;;    # ignore unknown flags — forward-compat with future dashboard additions
  esac
done

[[ -z "$APP_DIR" ]] && { echo "missing --app-dir" >&2; exit 1; }
[[ -z "$BRANCH"  ]] && { echo "missing --branch"  >&2; exit 1; }

# ── 1. Pull latest code ────────────────────────────────────────────────────
cd "$APP_DIR"
git -c safe.directory='*' fetch origin
if [[ -n "$COMMIT" ]]; then
  git -c safe.directory='*' reset --hard "$COMMIT"
else
  git -c safe.directory='*' reset --hard "origin/$BRANCH"
fi

# ── 2. Project-specific pre-build step — migrations, cache, etc. ───────────
# THIS is the whole point of project-local deploy. Examples:
npm run db:migrate              # Drizzle / Prisma / custom
# OR: bundle exec rails db:migrate
# OR: python manage.py migrate
# OR: whatever your project needs

# ── 3. Build and restart ───────────────────────────────────────────────────
BUILD_FLAGS=""
$NO_CACHE && BUILD_FLAGS="--no-cache"
docker compose build $BUILD_FLAGS
docker compose up -d

# ── 4. Optional post-start step ────────────────────────────────────────────
# curl -fsS -X POST http://localhost:3000/__warmup  # warm up caches
# aws s3 sync ./public/static s3://cdn-bucket/...   # push static assets

echo "✅ Deploy complete: $BRANCH @ $(git rev-parse --short HEAD)"
```

Commit the file to your repo. No `chmod +x` needed — the dashboard invokes it as `bash <path>`, so exec bit doesn't matter.

**Test it locally first**: SSH into the target, `cd /opt/my-app`, run `bash scripts/devops-deploy.sh --app-dir=/opt/my-app --branch=main`. If it works over SSH manually, it'll work via the dashboard.

### Step 2 — Register the path in the dashboard

Open the dashboard, navigate to your application's **Edit** form. Fill in the new **Project Deploy Script** field:

```
scripts/devops-deploy.sh
```

(Or whatever path you used.)

Click Save.

**What happens server-side**:

- The value is type-checked first: only `string` or `null` accepted. Numbers, booleans, objects all return 400.
- Then trimmed and validated: ASCII-only, ≤256 characters, no `/` prefix, no `..`, no shell metacharacters, no backslash. `./scripts/deploy.sh` is allowed (passes through). `скрипты/деплой.sh` is rejected (non-ASCII — rename the script).
- Valid values are persisted to `applications.script_path`. A DB CHECK constraint also rejects `""` / all-whitespace at the storage layer.
- Next deploy dispatches via the new `deploy/project-local-deploy` manifest entry.

**What happens client-side**:

- The app's detail page shows `Deploy script: <badge>project-local</badge> scripts/devops-deploy.sh` in its metadata row. Null-scriptPath apps show `Deploy script: builtin (scripts/deploy/server-deploy.sh)` in muted text.
- The Deploy button behaves identically to before (no extra confirmation — per Q2, project-local is parity-with-builtin).
- The **Rollback** button gains a confirmation dialog warning you that the builtin rollback may not undo your project-specific changes (database migrations, cache state, etc.). You can click through to proceed; you can also cancel.

### Step 3 — Deploy

Click **Deploy** on the application. Watch the live log stream.

The log header now shows:

```
project-local  scripts/devops-deploy.sh
Server: srv-1 (prod.example.com)
Started: 2026-04-24T10:30:00Z
```

The log itself is whatever your script emits. If your script's `npm run db:migrate` fails, you see the failure in the log; the deploy is marked `failed`; rollback is available (with the new confirmation dialog).

**Telegram notifications — two emitters, both independent**:

1. **Dashboard-side notifier** fires exactly one terminal-status Telegram message per deploy (`"Deployed!"` on success, `"Deploy Failed!"` on failure). This is inherited from feature 005 and fires regardless of whether your deploy dispatched to the builtin or to a project-local script. You get this message for free.
2. **Your project script** may fire its own Telegram messages — the builtin `scripts/deploy/server-deploy.sh` sends "Deploy Started" / "Deploy Succeeded" / "Deploy Failed" from inside bash via a `send_telegram()` helper. If you copy that pattern into your project-local script, those messages fire too. If you don't, only the dashboard's single message is sent.

**Net effect**: every deploy produces 1 message from the dashboard plus 0..N from your script, depending on what you coded. The dashboard does NOT deduplicate. If this is too noisy, mute the app via the feature-006 `alertsMuted` flag — the dashboard's terminal-status message is suppressed, and only your script's emissions remain.

### Step 4 — Verify in Runs history

Navigate to the **Runs** page. The new deploy appears with a `project-local` badge next to the script identity. Click it for the full post-mortem view.

The `script_runs` row persists:

- `script_id = "deploy/project-local-deploy"` (searchable as a filter)
- `params.scriptPath = "scripts/devops-deploy.sh"` (the dispatched path)
- Everything else identical to a builtin deploy — full stdout log, exit code, duration, etc.

---

## Common pitfalls

### "My script worked when I SSH'd in manually but fails via the dashboard"

Most likely cause: your script assumed interactive TTY, or it's sourcing a file that doesn't exist under the dashboard's SSH session. Specifically:

- Use `#!/usr/bin/env bash` or `#!/bin/bash`, not `#!/bin/sh` — some features (arrays, `[[ ]]`, etc.) are bash-only.
- If your script sources a file relative to itself, use `${BASH_SOURCE:-$0}` to get its own path robustly.
- If your script relies on environment variables from a `.bashrc`, source them explicitly — the dashboard's SSH session is non-interactive and non-login by default.

### "I want to pass a secret (API key, DB password) to my script"

Not supported in v1 (FR-014 / Out of Scope). Your script should read secrets from the target's `.env` file or from your own secret store (Vault, AWS Secrets Manager, etc.). The dashboard does not pass secrets across the project-local boundary.

### "My script emits too much output and the log viewer is slow"

Check feature 005 `SCRIPT_RUNS_RETENTION_DAYS` and the streaming log config. Trimming your script's output is the first line of defence — `| tail -n 200`, suppressing verbose build logs, etc. Second line: open an issue against the dashboard for log-viewer performance, include the specific run that's slow.

### "I want to switch an app back to the builtin deploy"

Open Edit Application, clear the **Project Deploy Script** field, save. Next deploy uses builtin. No other cleanup needed.

### "My rollback didn't work the way I expected"

Read the confirmation dialog. Seriously. The builtin rollback does `git reset + compose restart` only. It cannot undo:

- Database migrations (forward-only ALTER TABLE, dropped columns, data transforms)
- Cache flushes (already-missed requests won't come back)
- Asset uploads (S3 objects stay)
- External webhook side-effects (already fired)
- Anything your project script did besides git + compose

If you need a deterministic rollback, ship a rollback script as a follow-up feature (not yet in scope — see spec Out of Scope).

### "Scan-for-repos created a new app but didn't pick up my existing `scripts/devops-deploy.sh`"

By design (FR-025). Scan always leaves `script_path = NULL` — every scan-created app starts on the builtin deploy. You explicitly opt in via Edit Application after scan. Prevents surprise behaviour and false heuristic matches.

---

## Rollback (for dashboard operators, not project maintainers)

If this feature ships and needs to be backed out:

1. Identify apps with non-null `script_path` and communicate with their maintainers about reverting to builtin:
   ```sql
   SELECT id, name, remote_path, script_path FROM applications WHERE script_path IS NOT NULL;
   ```
2. **Scoped revert** (preferred): `UPDATE applications SET script_path = NULL WHERE id IN ('app-1', 'app-2');` — revert only the apps whose maintainers have signed off. Reversible; operators can re-set the field.
3. **Fleet-wide revert** (nuclear, only if entire feature is being backed out across every customer): `UPDATE applications SET script_path = NULL;` — this is blunt; only run after a staged rollout where EVERY maintainer has been notified. Safer to do step 2 in batches.
4. Run the DOWN migration ONLY IF the feature code is being removed: `ALTER TABLE applications DROP COLUMN script_path;` — destructive per CLAUDE.md rule 6; confirm with stakeholders before applying.
5. Revert the manifest entry, the dispatch branch, wrapper, and UI components via the usual release process.

No data loss unless step 4 is run without step 2 or step 3 — and even then, only the scriptPath values are lost, not the apps themselves.

---

## Summary

- Project maintainer: commit one bash script, set one path in the dashboard, done.
- Operator: same Deploy button, same log viewer, same Rollback (with one new warning dialog).
- Dashboard dev: 14 files changed, 0 new npm deps, 1 new DB column. See plan.md.
