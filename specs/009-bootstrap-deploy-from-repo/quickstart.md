# Quickstart: Bootstrap Deploy from GitHub Repo

**Date**: 2026-04-28

Operator-facing tutorial for the Bootstrap Deploy feature. Five scenarios — onboarding, monitoring live progress, recovery from compose failure, recovery from clone failure, hard-deleting a misbootstrapped app.

---

## Prerequisites

- A registered server in the dashboard (`servers.status = 'online'`) with Docker installed (per `setup-vps.sh`).
- A connected GitHub account (feature 002 — Settings → GitHub → paste fine-grained PAT).
- The PAT has `Contents: read` and `Metadata: read` for the target repo. Private repos additionally need `repo` scope.
- For domain attachment: Caddy installed on the target (`setup-vps.sh` extension from feature 008) and the operator has set ACME email in Settings.

---

## Scenario 1 — Onboarding a brand-new repo

You just `git push`ed a new app to `github.com/<you>/<repo>`. It has a `docker-compose.yml` at the root. You want it deployed to your prod server with a domain.

### UI affordances

1. **Dashboard → Servers → click your server → Apps tab**. Above the existing apps list there are now two buttons: **Add Application** (existing) and **Bootstrap from GitHub** (new).
2. Click **Bootstrap from GitHub**. A 5-step wizard opens.

### Step 1 — Repo

The dropdown shows your most recently pushed 20 repos (sorted by `pushed_at desc`). Type to search — the input has a 300 ms debounce and minimum 2 characters. Cached search results return instantly within a 60-second window for the same query.

Pick your repo. The wizard prefills:

- **App name**: derived from the repo name. `myorg/My-Cool-App` → `my-cool-app` (slug rules: lowercase, dashes only, max 64 ASCII chars). Editable — but if you change it to something invalid, the Next button is disabled until you fix it.
- **Branch**: the repo's default branch fetched from GitHub (`GET /repos/:owner/:repo` returns `default_branch`). Defaults to whatever GitHub says — usually `main`, but `develop`/`trunk`/etc. are honoured.

**Underlying API**: `GET /api/github/repos?sort=pushed&per_page=20` for the recent list; `GET /api/github/repos?q=<query>` for search.

### Step 2 — Detection

The wizard fetches your compose file via the GitHub Contents API:

- `GET /api/github/repos/:owner/:repo/compose?path=docker-compose.yml`

If the response says `found: true`, the wizard renders the parsed services:

```
Detected services in docker-compose.yml:
- app          → port 3000 (proposed upstream)
- db           → no exposed port
- worker       → no exposed port
```

Confirm `app` as the upstream, or pick a different service from a dropdown if multiple have `expose:` / `ports:`. If 0 services have exposed ports, the wizard prompts manual input — type a service name and a port number.

**Warnings rendered**:

- `network_mode: host` detected on a service → yellow banner: "host network mode detected — port conflicts at server level become possible".
- `deploy.replicas > 1` → info banner: "multi-upstream Caddy directive will be generated".

If the response says `found: false` (no `docker-compose.yml` AND no `docker-compose.yaml`), the wizard blocks: "No docker-compose file at root. Provide composePath in Advanced if it lives elsewhere, or v1 only supports compose-based repos."

### Step 3 — Optional domain

A text input. Leave empty to deploy without a domain (app is reachable via direct HTTP `<server-ip>:<host-port>` if compose has `ports:` mapping; else only via the Docker network).

If filled, the wizard runs feature 008's DNS pre-check inline (`POST /api/dns/precheck`). Outcomes:

- **Match** → green check.
- **Cloudflare** → yellow warning + "I know, try anyway" checkbox.
- **Mismatch** → yellow warning + "I know, try anyway" checkbox.
- **NXDOMAIN** → red, hard block.

### Step 4 — Advanced (collapsible)

- `remotePath` — display-only by default, shows `/home/deploy/apps/<slug>`. Toggle "Override" to edit.
- `branch` — prefilled from Step 1; editable here.
- `composePath` — defaults to `docker-compose.yml`; change for monorepos with `services/api/docker-compose.yml`.

### Step 5 — Review

Renders a checklist:

```
Bootstrap "my-cool-app" on srv-prod-1
1. Clone github.com/you/my-cool-app @ main → /home/deploy/apps/my-cool-app
2. docker compose -f docker-compose.yml up -d
3. Wait for healthcheck on service `app`
4. Apply Caddy config for my-cool-app.example.com → app:3000
5. Issue Let's Encrypt cert for my-cool-app.example.com
```

Click **Bootstrap**. The wizard switches to the live progress view.

**Underlying API**: `POST /api/applications/bootstrap` with the full request body shape from `contracts/api.md`. The response is `201 { id, bootstrapState: 'init', events: [] }`.

### DB state right after Bootstrap click

```sql
-- applications row
id              | app-uuid
server_id       | srv-prod-1
name            | my-cool-app
repo_url        | https://github.com/you/my-cool-app.git
branch          | main
remote_path     | /home/deploy/apps/my-cool-app
github_repo     | you/my-cool-app
bootstrap_state | init                              ← orchestrator picks up immediately
upstream_service| app
upstream_port   | 3000
compose_path    | docker-compose.yml
domain          | my-cool-app.example.com
created_via     | bootstrap

-- app_bootstrap_events: empty until the orchestrator's first transition
```

---

## Scenario 2 — Watching live bootstrap progress

The wizard's progress view subscribes to two WS event types:

- `bootstrap.state-changed` — every transition broadcasts here. The view animates the step indicator.
- `bootstrap.step-log` — every line of stdout/stderr from the underlying `script_runs` of each step. Rendered in a tail-style log viewer (same component as feature 005).

Visible progress:

```
[OK] Clone repository                   2.3s
[OK] docker compose up -d              22.1s
[..] Wait for healthy                  running (4.5s)
[ ] Apply Caddy config
[ ] Issue Let's Encrypt cert
```

You can close the wizard at any point — bootstrap continues server-side. When you reopen it (Apps tab → click the bootstrapping app), the progress view re-fetches state via `GET /api/applications/:id/bootstrap-state` and resumes WS streaming.

### What the dashboard does in the background per step

| Step | Internal action | DB writes |
|----|----|----|
| `cloning` | `scriptsRunner.runScript("bootstrap/clone", ...)` — env-var transports PAT, heredoc reconstructs URL on target | `script_runs` row tagged `bootstrap/clone`; on success, `app_bootstrap_events` row `cloning → compose_up` |
| `compose_up` | `scriptsRunner.runScript("bootstrap/compose-up", ...)` — `docker compose -f <composePath> up -d --remove-orphans` | `script_runs` row tagged `bootstrap/compose-up`; on success, transitions to `healthcheck` |
| `healthcheck` | `scriptsRunner.runScript("bootstrap/wait-healthy", ...)` — feature 006's wait-for-healthy polling tail. Skips silently if compose has no healthcheck (FR-011) | `script_runs` row tagged `bootstrap/wait-healthy`; on success, transitions to `proxy_applied` IF domain set, else `active` |
| `proxy_applied` | Calls feature 008's reconciler (`POST /api/caddy/reconcile`) with the new `applications.domain + upstream_service + upstream_port`. Reconciler PUTs full Caddy config via admin API on `localhost:2019` over SSH tunnel | feature 008's `app_certs` row inserted with `status='pending'`; this feature's `app_bootstrap_events` row `proxy_applied → cert_issued` |
| `cert_issued` | Polls feature 008's cert state every 5s up to 90s. ACME validation happens via Caddy auto-TLS | feature 008 updates `app_certs.status='active'`; this feature's `app_bootstrap_events` row `cert_issued → active` |
| `active` | `scriptsRunner.runScript("bootstrap/finalise", ...)` — `git rev-parse HEAD` → captures `current_commit` via outputArtifact; orchestrator persists to `applications.current_commit`; sends single Telegram "Bootstrapped: my-cool-app" message (FR-024) | terminal — no further auto-transitions |

Telegram receives **one** "Bootstrapped" message on success (NOT per-step — would be noise per FR-024).

---

## Scenario 3 — Recovering from a failed compose-up

You bootstrapped `my-cool-app` but it has a Dockerfile that needs `--build-arg API_KEY` — which compose can't provide because there's no `.env` on the target yet. Compose fails with:

```
Service 'app' failed to build : The command 'curl https://api.example.com -H "Authorization: $API_KEY"' returned a non-zero code: 7
```

### What the dashboard shows

- **Apps list**: your app row has a red badge "Failed at compose_up".
- **App detail view**: full error message, last successful step (`cloning`), and three buttons: **Retry from compose_up**, **Edit Config**, **Delete**.
- **Telegram**: one alert "Bootstrap failed: my-cool-app at compose_up: Service 'app' failed to build...".

### Fix and retry

1. SSH to the target manually and create `/home/deploy/apps/my-cool-app/.env` with `API_KEY=...`.
2. Back in the dashboard: click **Retry from compose_up**. The wizard re-opens in progress view; orchestrator re-runs `bootstrap/compose-up`.

`docker compose up -d` is idempotent (R-007 in research.md) — services already running are no-ops, the failed build retries with the new env file, and the chain resumes from `compose_up → healthcheck → proxy_applied → cert_issued → active`.

**Underlying API**: `POST /api/applications/:id/bootstrap/retry?from=compose_up`. Response 202 with the new state. The DB transitions:

```sql
-- Before retry click:
applications.bootstrap_state = 'failed_compose'

-- After retry click (synchronous):
applications.bootstrap_state = 'compose_up'
-- New app_bootstrap_events row:
from_state='failed_compose', to_state='compose_up', metadata={ runId, reason: 'manual_retry', retryCount: 1 }, actor=user-42
```

### Edit Config (alternative — fix the dashboard's stored config without re-cloning)

If the failure was wrong `composePath` (e.g. the project uses `compose.prod.yml` not `docker-compose.yml`):

1. Click **Edit Config**. A dialog opens with editable fields: `branch`, `composePath`, `upstream_service`, `upstream_port`.
2. Change `composePath` to `compose.prod.yml`. Save.
3. Click **Retry from compose_up**.

`remotePath` and `repoUrl` are display-only here — changing them requires Hard Delete + re-bootstrap (per FR-020).

**Underlying API**: `PATCH /api/applications/:id/bootstrap/config` with `{ composePath: 'compose.prod.yml' }`. Response 200 with the updated row.

---

## Scenario 4 — Recovering from a failed clone (PAT scope issue)

You bootstrap a private repo, but the PAT in your GitHub connection only has `public_repo` scope. CLONING fails immediately:

```
fatal: Authentication failed for 'https://oauth2:***@github.com/you/private-repo.git/'
```

### What the dashboard shows

- App row badge: red, "Failed at cloning".
- App detail: error message includes the actionable hint: "PAT for connection 'github-default' does not have access to private repo 'you/private-repo'. Reconnect GitHub or update PAT scopes." (per FR-016)
- A deeplink button: **Reconnect GitHub** → takes you to Settings → GitHub.

### Fix

1. Go to Settings → GitHub → click Disconnect → click Connect.
2. On github.com, generate a new fine-grained PAT with `Contents: read` for the target repo (or `repo` scope on a classic PAT — though feature 002 prefers fine-grained).
3. Paste back into the dashboard. Connection re-validates.
4. Return to your app's detail view. Click **Retry from cloning**.

The orchestrator re-fetches the PAT from `github_connection.token` at dispatch time (PAT is never persisted on the `applications` row — see FR-015). The new clone command uses the fresh token via env-var transport + heredoc URL reconstruction.

DB transitions:

```sql
-- After retry click:
applications.bootstrap_state = 'cloning'
-- New app_bootstrap_events row, metadata.runId different (new script_runs invocation):
from_state='failed_clone', to_state='cloning', actor=user-42
```

### Verifying PAT didn't leak

Run these checks (operator can do them via `psql`):

```sql
-- Should return 0 rows:
SELECT params FROM script_runs
  WHERE script_id = 'bootstrap/clone'
    AND params::text LIKE '%ghp_%';

-- Should return all rows with pat="***":
SELECT params->>'pat' FROM script_runs WHERE script_id = 'bootstrap/clone';
```

Expected: every `pat` field in `script_runs.params` is `"***"`. Same check applies to `audit_entries.details` and the pino log file.

---

## Scenario 5 — Hard-deleting a misbootstrapped app

You bootstrapped `my-cool-app` but realised the wrong repo was selected. The app made it to `failed_compose` and you don't want to fix it — just nuke it.

### UI flow

1. App detail view → click **Delete** button.
2. Dialog opens with two radio options:
   - **Remove app row only** (default — soft delete; leaves server data intact for the next operator).
   - **Remove everything from server** (hard delete — typed-confirm required).
3. Pick "Remove everything from server". The dialog now shows: "Type the app name (`my-cool-app`) to confirm." A text input appears; the Confirm button stays disabled until the typed value matches exactly.
4. Type `my-cool-app`. Click Confirm.

### What happens server-side

1. Server-side validates `confirmName === applications.name` (typed-confirm enforced server-side per FR-027 — never trust the client to do this check).
2. `path-jail.resolveAndJailCheck(serverId, '/home/deploy/apps/my-cool-app', '/home/deploy/apps')` runs over SSH:
   - Executes `readlink -f /home/deploy/apps/my-cool-app` on the target.
   - Asserts the resolved path starts with `/home/deploy/apps/`.
   - If the operator had manually edited the DB to point `remote_path` at `/etc`, this step would return `JAIL_ESCAPE` and the rm would NOT run.
3. If the app has a domain set, calls feature 008's hard-delete: ACME-revokes the cert, removes Caddy site config via admin API, deletes cert files.
4. `docker compose -f /home/deploy/apps/my-cool-app/docker-compose.yml down -v` over SSH (60s timeout).
5. `rm -rf /home/deploy/apps/my-cool-app` (using the resolved path from step 2 — guaranteed under jail).
6. `app_bootstrap_events` row appended with `to_state='hard_deleted'`, `metadata={ confirmedBy: userId, removedFrom: '/home/deploy/apps/my-cool-app' }`.
7. `DELETE FROM applications WHERE id = 'app-uuid'`. Cascade clears `app_bootstrap_events` (FK ON DELETE CASCADE), `app_certs` (feature 008's cascade), and SETs NULL on `script_runs.deployment_id` (feature 005's policy — preserves run history).

### Verification

Operator can verify on the target:

```bash
# Should be empty:
ls /home/deploy/apps/my-cool-app
# stat: cannot stat '/home/deploy/apps/my-cool-app': No such file or directory

# Should be empty (no my-cool-app containers):
docker ps -a | grep my-cool-app

# Should be empty (no Caddy site for my-cool-app.example.com):
curl -s localhost:2019/config/apps/http/servers/srv0/routes | jq '.[] | select(.match[0].host[0] == "my-cool-app.example.com")'
```

All three return empty / 404. Per SC-004 in spec: 100% removal of server-side state.

**Underlying API**: `POST /api/applications/:id/hard-delete` with `{ confirmName: 'my-cool-app' }`. Response 200 with the `removed` summary.

---

## Failure-mode safety nets

### Wizard closed mid-bootstrap

The orchestrator runs server-side. Closing the browser does NOT abort. State is persisted in `applications.bootstrap_state` and `app_bootstrap_events`; on next dashboard open, the apps list reflects whatever progress was made.

### Dashboard process restart mid-bootstrap

The reconciler picks up "stuck" apps on its 5-minute cycle (R-012). An app in `bootstrap_state = 'compose_up'` with no `script_runs` row currently `running` is treated as stuck — orchestrator re-dispatches the step. Idempotency of each step (R-007) makes this safe.

### Auto-retry opt-in for transient failures

Per-app flag `applications.bootstrap_auto_retry` (default false). When true, the reconciler retries failed steps every 5 minutes up to 3 consecutive failures, then alerts via Telegram and disables auto-retry for that app (FR-022).

To enable per-app: app detail view → Advanced settings → check "Auto-retry on failure". Persists immediately.

### Concurrent bootstraps on the same server

Feature 004's deploy lock serialises `bootstrap/clone`, `bootstrap/compose-up`, and `bootstrap/hard-delete` (all `requiresLock: true`). The wizard shows "Queued, waiting for previous deploy" if another lock-holding operation is in flight on the same server. `bootstrap/wait-healthy` and `bootstrap/finalise` don't require the lock — they can run alongside other server activity safely.

### Two operators bootstrap the same repo at the same time

Slug uniqueness check (`(server_id, name)`) catches the second submission with `409 SLUG_COLLISION`. The second operator's wizard surfaces the conflict and offers to rename.

---

## Filtering bootstrapped apps in the Apps list

The Apps list now has a "Created Via" filter dropdown (FR-033):

- **All** (default)
- **Manual** — apps added via the existing Add Application form
- **Scan** — apps imported via feature 003 scan
- **Bootstrap** — apps onboarded via this feature's wizard

Filter selection persists in localStorage. Useful for "show me only the apps I bootstrapped via the dashboard so I can audit them" use cases.

---

## Troubleshooting

**"Wizard hangs at Step 2 with 'Loading services...'"** — GitHub Contents API call timed out or 5xx'd. Check Settings → GitHub → "API rate limit" indicator. If rate-limited, wait for `X-RateLimit-Reset`; if 5xx, GitHub itself is degraded — try again in a few minutes.

**"Bootstrap stuck at `cloning` for >10 minutes"** — clone timeout is 10 min (manifest entry `bootstrap/clone` `timeout: 600000`). Likely a huge repo (>5 GB) or a slow network. The `script_runs` row will transition to `status='timeout'`; the app row will transition to `failed_clone`. Retry will start fresh (`git clone` will resume only if the partial clone left a valid `.git` — usually it didn't, so retry re-clones from scratch).

**"Healthcheck step skipped silently"** — your `docker-compose.yml` has no `healthcheck:` declaration on the upstream service. Per FR-011, the wait-for-healthy step is a no-op when no healthcheck is defined. To enable it, add a `healthcheck:` block to your compose file.

**"Cert issuance failed but DNS pre-check passed"** — Caddy auto-TLS retries every ~10 minutes for 24 hours. State stays `failed_cert` — but the underlying retry is happening transparently. Check `app_certs.status` for the latest probe outcome. If still failing after a few hours, force-renew via the cert detail view (feature 008 FR-021).

**"Hard delete failed with `JAIL_ESCAPE`"** — `applications.remote_path` for this app resolves (via target-side `readlink -f`) to a path outside `/home/deploy/apps/`. Most likely cause: someone manually edited the DB or symlinked `apps/foo` to elsewhere. Investigate manually before retrying. The `rm -rf` did NOT run.

---

## What this feature does NOT do

Out of scope per spec:

- Non-GitHub providers (GitLab, Bitbucket, Gitea).
- Non-compose deployment models (Kubernetes, plain Dockerfile, systemd-only).
- Auto-detection of build secrets / build-args.
- Auto-population of `env_vars` from GitHub secrets.
- Bootstrap from a tag instead of a branch.
- Bootstrap on a freshly-provisioned server (Docker / Caddy must be installed first via `setup-vps.sh`).

Future work (v2): see spec.md § Out of Scope and § Open Questions.
