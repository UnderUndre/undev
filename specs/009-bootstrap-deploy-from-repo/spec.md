# Feature Specification: Bootstrap Deploy from GitHub Repo

**Version**: 1.0 | **Status**: Draft | **Date**: 2026-04-28

## Clarifications

### Session 2026-04-28 (initial)

- Q: What does "select only a GitHub repo" mean for the form contract? → A: **Single required input is the GitHub repo (already-stored connection from feature 002 — user picks from a dropdown). Everything else (path on target, branch, compose location, port) is auto-derived with optional Advanced overrides.** The "no path needed" UX requirement collapses 5+ form fields into 1 mandatory + N optional.
- Q: Where on the target does the repo get cloned by default? → A: **`${DEPLOY_USER_HOME}/apps/<repo-name-slug>`.** Slug is the GitHub repo name lowercased, dashes only, max 64 ASCII chars (`^[a-z0-9-]+$`). Full path is ALWAYS computed and persisted to `applications.remote_path` at write time — null is never stored. Advanced section in the form lets the operator override.
- Q: How is the upstream port for the reverse proxy detected? → A: **Parse the repo's docker-compose file. If exactly one service has `expose:` or `ports:`, use it (right-hand value of `ports:` is the container-internal port). If 2+, the form prompts "which service is public" (dropdown). If 0, manual input.** Save as `applications.upstream_service` and `applications.upstream_port`. Caddy reverse_proxy target is `<compose-project>-<upstream_service>:<upstream_port>` via Docker DNS.
- Q: How does failure recovery work? → A: **State machine with recoverable failure states; nothing rolls back automatically.** Bootstrap progresses: `INIT → CLONING → COMPOSE_UP → HEALTHCHECK → PROXY_APPLIED → CERT_ISSUED → ACTIVE`. On failure the app row sits at `failed_<step>`; UI shows actions: Retry, View Logs, Edit Config, Delete. Idempotent retry — each step checks "already done" before acting (e.g. clone becomes fetch+reset). No partial cleanup on failure: clone stays, container stays, dashboard does NOT silently delete operator data.
- Q: Does this feature attach a domain at first deploy, or is domain a separate post-bootstrap step? → A: **Optional inline. The Bootstrap form has an optional `Domain` field; if filled, it triggers feature 008's domain-attachment flow as part of the same wizard. If empty, the app is reachable via direct HTTP `<server-ip>:<host-port>` (only meaningful if compose has `ports:` mapping; otherwise post-bootstrap "Add Domain" is required).** This keeps the "first deploy in 5 clicks" UX without forcing TLS on operators just exploring.
- Q: Private repos — how is GitHub PAT used during clone? → A: **Use the connection's saved PAT (feature 002). Clone command is `git clone https://oauth2:${PAT}@github.com/<owner>/<repo>.git`.** PAT NEVER leaves the dashboard's memory in a logged form: the SSH-piped clone command uses a heredoc with the PAT injected at execution time, scrubbed from `script_runs.params` JSON. If PAT is missing or scoped wrong, clone fails with a clear actionable message.
- Q: Repos without a docker-compose file — supported? → A: **Not in v1.** The bootstrap flow detects compose presence as a precondition; missing compose blocks with "This repo has no docker-compose file at root or at the configured composePath. Bootstrap supports compose-based apps only in v1." Pure-Dockerfile apps and bare-metal scripts are deferred.
- Q: How is "this app was bootstrapped via dashboard" tracked? → A: **A new column `applications.created_via TEXT NOT NULL DEFAULT 'manual'` with enum `manual | scan | bootstrap`.** Broader than a `bootstrapped_at` timestamp because feature 003 (scan) already produces a third class of applications that today is identified only by the side-channel `skip_initial_clone = true`. Unifying into one column gives clean filtering ("show only bootstrapped apps"), audit trails ("how did this app get here"), and cleaner queries than chasing flags across columns. Backfill: existing rows with `skip_initial_clone = true` → `'scan'`; everything else → `'manual'`. Bootstrap-created rows always write `'bootstrap'`.
- Q: Repo selector — full list or recent + search? → A: **Recent 20 (sorted by GitHub `pushed_at desc`) + search-as-you-type.** Full list is unusable for org accounts with hundreds of repos (paginated, multi-second load). Recent covers the "I just pushed, where's my repo" case (80%+ of bootstraps). Search input with 2-char minimum and 300ms debounce queries `GET /search/repositories?q=user:<user>+<query>` for the long tail. GitHub Search API has a separate rate limit (30/min) — debounce + minimum-chars keeps usage well under it.

## Problem Statement

Today, bringing a new application onto the dashboard is a multi-step manual ritual:

1. SSH to the target server.
2. `mkdir -p /home/deploy/apps/<name> && cd /home/deploy/apps/<name>`.
3. `git clone <url> .` (clone into prepared directory).
4. `docker compose up -d`.
5. SSH back out, open the dashboard, click "Add Application", paste the path, the repo URL, the branch, the deploy-script path.
6. Optionally repeat steps in feature 008 to attach a domain.

This produces three real costs:

- **Operator friction**: each new app is ~30 minutes of SSH + form-filling. The 6-step ritual is exactly the kind of thing operators do once, fail at, then put off. Fewer apps get onboarded, technical debt accrues.
- **Inconsistency**: every operator picks a slightly different path (`/opt/<name>`, `/home/ops/apps/<name>`, `/srv/<name>`). Discovery later (feature 003 scan) becomes a probabilistic exercise; tooling that assumes "apps live in `${HOME}/apps/`" is wrong on half the boxes.
- **No "first deploy" feedback**: the dashboard observes nothing of the manual `git clone + docker compose up` — if compose fails, the operator finds out by SSH log-reading, not by a dashboard log viewer. The 2026-04-22 incident class (deploy looks fine, app is broken) extends backwards: even before the first dashboard-tracked deploy, the app might already be misbehaving and the operator has no centralised view.

Spec 007's clarification (line 12) explicitly out-of-scoped the first-ever deploy: *"the admin bootstraps the repo manually (SSH + git clone)"*. This feature reverses that — bootstrap becomes a first-class dashboard flow.

The user-facing change is small: a new "Bootstrap from GitHub" button that takes a repo selector and (optionally) a domain, and produces a fully-deployed app row with the same observability as any other dashboard-managed app. The behind-the-scenes machinery is large — clone-on-target via SSH, compose detection, port inference, idempotent retry, and an explicit state machine that keeps operator data safe even when steps fail.

## User Scenarios & Testing

### User Story 1 — Onboard a new app from a GitHub repo with one form (Priority: P1)

As a dashboard admin onboarding a new application, I want to pick a GitHub repo, optionally enter a domain, click Deploy, and end up with a running, dashboard-managed app — so I never SSH into a server for first-time deployment again.

**Acceptance**:

- A "Bootstrap from GitHub" button on the Server detail view opens a wizard.
- Step 1 — Repo: dropdown of repos accessible via the connected GitHub account (feature 002). Search-as-you-type. Selecting a repo prefills the app name (slug of repo name) — editable.
- Step 2 — Detection: dashboard fetches the repo's `docker-compose.yml` (via GitHub API, NOT a clone yet) and shows: detected services, detected `ports:` / `expose:` declarations, and proposes `upstream_service` + `upstream_port`. Operator confirms or overrides.
- Step 3 — Optional domain: text input with placeholder; if filled, runs feature 008's DNS pre-check inline.
- Step 4 — Advanced: collapsible section with `remote_path`, `branch` (default `main`/`master` auto-detected from repo's default branch), `composePath` (default `docker-compose.yml`).
- Step 5 — Review: shows a checklist of what will happen. Click "Bootstrap" to proceed.
- Bootstrap progresses through `INIT → CLONING → COMPOSE_UP → HEALTHCHECK → PROXY_APPLIED → CERT_ISSUED → ACTIVE`. Live progress bar shows current step; each step's logs are visible in the existing log viewer.
- On `ACTIVE`, the wizard closes and the new app appears in the Apps list with a green health dot.

### User Story 2 — Recover from a partial bootstrap failure (Priority: P1)

As a dashboard admin whose bootstrap got stuck halfway (e.g. compose fails because the image build needs a missing build-arg), I want to fix the underlying problem and retry without losing the work the dashboard already did (clone, paths configured), so a 5-minute fix doesn't require restarting bootstrap from zero.

**Acceptance**:

- The Apps list shows the failed app with a red dot and a "Failed at <step>" badge.
- The app detail view shows the failure context: error message, last successful step, current state.
- A "Retry from <step>" button is enabled. Clicking re-runs the failed step and continues forward.
- Idempotent retry: if `CLONING` already produced a directory with the right repo, retry does `git fetch + reset --hard origin/<branch>` instead of re-cloning. If `COMPOSE_UP` already started containers, retry does `docker compose up -d` again (idempotent).
- A separate "Edit Config" button lets the operator change `branch`, `composePath`, `upstream_service`, or `upstream_port` before retrying.
- A "Delete" button offers two modes: "Remove app row only" (default, leaves server data) or "Remove everything from server" (typed-confirm, runs `docker compose down -v && rm -rf <remote_path>` and removes Caddy site if present).

### User Story 3 — Bootstrap a private repo without manual PAT plumbing (Priority: P2)

As an admin onboarding a private repo, I want the dashboard to use my already-saved GitHub connection PAT for the clone, so I don't paste credentials into a form or set up SSH deploy keys per repo.

**Acceptance**:

- A repo's visibility (public / private) is detected via the GitHub API.
- For private repos, the clone command on the target uses the dashboard's stored PAT, injected at command-execution time, scrubbed from logged params.
- If the PAT lacks `repo` scope (only `public_repo`), bootstrap fails at `CLONING` with a clear message: "PAT for connection X does not have access to private repo Y. Reconnect GitHub or update PAT scopes."
- The PAT is NEVER persisted on the target server — clone is a one-shot command, no `~/.netrc` or persistent credential helper.

### User Story 4 — See first-deploy logs and health status (Priority: P2)

As an admin watching a bootstrap in progress, I want each step's stdout/stderr captured in the dashboard log viewer (same UI as regular deploys), so I can see what's happening without SSH.

**Acceptance**:

- Each step (`CLONING`, `COMPOSE_UP`, `HEALTHCHECK`, etc.) writes its own `script_runs` row with the same shape as feature 005 runs.
- The deploy-history view for the app shows the bootstrap as a single composite entry with sub-steps (or as N sequential entries — implementation choice; UI MUST visually group them as one bootstrap).
- Telegram receives a single "Bootstrapped: {app}" message on `ACTIVE`, NOT per-step messages.
- On failure, Telegram receives "Bootstrap failed: {app} at {step}: {error}".

## Edge Cases

- **Repo name conflicts with existing app on same server**: slug `foo` already exists. UI rejects at form validation: "App `foo` already exists on this server. Pick a different name." The slug field becomes editable (it was prefilled but always was editable).
- **Default remote_path collision (directory exists, different repo)**: `${HOME}/apps/foo` exists with a different remote URL → `CLONING` fails with "Directory exists with different repo. Either pick a different name or manually clean up the directory." No automatic suffix (`-2`, `-3`) — that creates invisible duplicates.
- **Default remote_path collision (directory exists, same repo)**: this is a redeploy scenario — feature 003 already handles it. Bootstrap detects: if `.git` exists and `remote.origin.url` matches, treat as "already cloned, just fetch". App row created normally; `CLONING` is fast-path.
- **Default remote_path collision (directory exists, not git)**: rejected with "Directory exists but is not a git repo. Manual cleanup required."
- **No `docker-compose.yml` at repo root**: form validation fails early at Step 2 — "No docker-compose.yml found in repo root. Provide composePath in Advanced if it lives elsewhere, or v1 only supports compose-based repos." Suggest `composePath` examples (`./services/api/docker-compose.yml`).
- **Compose has `network_mode: host`**: detection writes a warning into the wizard: "host network mode detected — port conflicts at server level become possible. Bootstrap continues; reverse_proxy upstream becomes `<server-ip>:<port>` instead of Docker DNS."
- **Compose has multiple replicas (`deploy.replicas: 3`)**: detection notes it; reconciler in feature 008 generates multi-upstream Caddy reverse_proxy directive (`reverse_proxy svc-1:3000 svc-2:3000 svc-3:3000`).
- **Repo has no default branch detected** (rare; e.g. brand-new empty repo): wizard refuses, "Repo has no commits / no default branch — push at least one commit before bootstrapping."
- **Repo's default branch is something other than `main`/`master`**: GitHub API gives the default branch name; we use it. If the operator wants a different branch, Advanced section.
- **Disk full on target during clone**: `git clone` fails with `fatal: write error: No space left on device`. State `failed_clone`, error message preserved, retry blocks until operator frees space.
- **Container port overlaps with another running container on the same Docker network**: Docker compose handles network namespacing — services in the same compose-project network are isolated. Conflict only happens if `ports:` maps the same host port across two different apps. With Docker-DNS upstream model (per FR-006), this is sidestepped — apps don't expose host ports.
- **PAT expired during bootstrap (token rotated mid-flow)**: clone fails with `Authentication failed`. State `failed_clone`. Retry uses the new PAT after reconnect.
- **Two operators bootstrap apps simultaneously on the same server**: deploy lock from feature 004 serialises `COMPOSE_UP` steps. Wizard shows "queued, waiting for previous deploy" (existing behaviour).
- **Operator closes the wizard mid-flow**: bootstrap continues in the background — wizard is a UI shell over a server-side state machine. Closing the browser doesn't abort.
- **App soft-deleted, then re-bootstrapped from same repo**: the `applications.domain` UNIQUE constraint may collide with the soft-deleted row's domain. Soft-deletion sets `domain = NULL` to free the slot (or scopes UNIQUE to non-deleted rows — schema decision in feature 008 OQ-001).
- **Operator picks a repo from an organisation the PAT cannot read**: GitHub API call to fetch compose pre-clone returns 404. Wizard shows "Repo not accessible with current PAT. Check PAT scopes or org SSO." Bootstrap blocked.
- **Repo's docker-compose.yml uses unsupported features** (compose v2.x extensions, named build secrets requiring BuildKit): bootstrap's `docker compose up -d` either succeeds (modern Docker has BuildKit on by default) or fails with the actual `docker compose` error. Surfaced via log viewer.

## Functional Requirements

### Form & detection

- **FR-001**: The Bootstrap wizard MUST accept exactly one mandatory input — a GitHub repo selected from the operator's connected accounts (feature 002). All other inputs MUST be optional with computed defaults.
- **FR-002**: The repo selector MUST default-load 20 most-recently-pushed repos (`GET /user/repos?sort=pushed&per_page=20` or org-equivalent endpoint per feature 002). A search input with a 2-character minimum and 300ms debounce MUST issue `GET /search/repositories?q=user:<user>+<query>` (or `org:<org>` for org connections). Results from default-load and search are merged in the dropdown with "Recent" and "Search" section headers.
- **FR-002a**: GitHub Search API rate-limit (30 requests/min) MUST be observed. The dashboard MUST cache search results for the same `(account, query)` tuple for 60 seconds; repeated queries within the cache window do NOT hit the API.
- **FR-003**: On repo selection, the dashboard MUST fetch (via GitHub API, not clone) the file at the configured `composePath` (default `docker-compose.yml`). If absent, fetch `docker-compose.yaml`. If both absent, block at Step 2.
- **FR-004**: The compose file MUST be parsed for services with `expose:` or `ports:`. Detection rules:
  - Exactly one such service → propose as `upstream_service`; container port = right-hand of `ports:` or `expose:` value.
  - 2+ such services → wizard renders a dropdown for operator selection.
  - 0 such services → wizard prompts manual input for service name + port.
- **FR-005**: The wizard MUST detect the repo's default branch via GitHub API and prefill the Advanced "Branch" field.
- **FR-006**: The slug for `name` and `remote_path` MUST be derived from the repo name: lowercase, ASCII only (`^[a-z0-9]+(-[a-z0-9]+)*$`), max 64 chars. Operator-editable.
- **FR-007**: The default `remote_path` MUST be computed at form-load time as `${DEPLOY_USER_HOME}/apps/${slug}` and persisted to `applications.remote_path` at submit. NULL or empty MUST never be stored.

### State machine

- **FR-008**: Bootstrap progress MUST be modelled as a state machine with these states: `INIT → CLONING → COMPOSE_UP → HEALTHCHECK → PROXY_APPLIED → CERT_ISSUED → ACTIVE` plus failure terminal states `failed_clone`, `failed_compose`, `failed_healthcheck`, `failed_proxy`, `failed_cert`.
- **FR-009**: A new column `applications.bootstrap_state TEXT NOT NULL DEFAULT 'active'` MUST be added — existing apps backfill to `active`.
- **FR-010**: Each state transition MUST be append-logged to a new `app_bootstrap_events` table: `(id, app_id, from_state, to_state, occurred_at, metadata JSON)`.
- **FR-011**: The `HEALTHCHECK` step MUST integrate with feature 006's wait-for-healthy logic if the compose has a healthcheck. Without a compose-defined healthcheck the step skips (logged), per feature 006 FR-028.
- **FR-012**: The `PROXY_APPLIED` and `CERT_ISSUED` steps MUST run only if `applications.domain` is non-NULL. Without a domain, bootstrap terminates at `ACTIVE` after `HEALTHCHECK`.
- **FR-013**: Each step MUST be idempotent. Implementation conventions:
  - `CLONING`: if `${remote_path}/.git` exists with matching `remote.origin.url`, run `git fetch + reset --hard origin/<branch>` instead of `git clone`.
  - `COMPOSE_UP`: always `docker compose -f <composePath> up -d` (Docker handles idempotency).
  - `PROXY_APPLIED`: defers to feature 008's reconciler (idempotent by design — full-config PUT).
  - `CERT_ISSUED`: defers to Caddy auto-TLS (idempotent by design).

### Clone

- **FR-014**: Clone command MUST be constructed as: `git clone https://oauth2:${PAT}@github.com/<owner>/<repo>.git ${remote_path}` for HTTPS clones with PAT, OR `git clone git@github.com:<owner>/<repo>.git ${remote_path}` if the connection is SSH-key based (feature 002).
- **FR-015**: PAT MUST be injected at command-execution time, NOT stored in `script_runs.params`. Logging layer MUST scrub PAT pattern before persistence.
- **FR-016**: For private repos where the connection's PAT lacks `repo` scope, the clone MUST fail explicitly with a message identifying the missing scope and a deeplink to reconnect.
- **FR-017**: Clone MUST NEVER add the PAT to the target's persistent credential store (no `~/.netrc`, no `git config credential.helper store`). The PAT in the clone URL is a one-time use; subsequent `git fetch` operations on redeploy reuse the same one-shot pattern.

### Failure handling

- **FR-018**: A bootstrap step failure MUST NOT delete data. The clone, the containers, the partial Caddy config — all stay. Only the state column transitions to `failed_<step>`.
- **FR-019**: The Retry action MUST resume from the failed step, NOT restart from `INIT`. The state machine validates that a state transition `failed_<step> → <step>` is allowed only if `<step>` is the failure step or earlier in the chain.
- **FR-020**: An "Edit Config" action MUST allow changing `branch`, `composePath`, `upstream_service`, `upstream_port` (but NOT `remote_path` or `repo_url`) on a failed app. Editing locked fields (`remote_path`, `repo_url`) requires Hard Delete + re-bootstrap.
- **FR-021**: Hard Delete (with typed confirm) MUST: (1) `docker compose -f <composePath> down -v` to stop and remove volumes, (2) `rm -rf <remote_path>` (with explicit jail check that path is under `/home/<deploy-user>/apps/`), (3) call feature 008's hard-delete on cert/Caddy if `domain` set, (4) DELETE the app row. Order matters — proxy/cert before remote files prevents Caddy serving stale config to a non-existent upstream.
- **FR-022**: Background reconciler (cron, every 5 minutes) MUST visit apps in `failed_<step>` states and, if `applications.bootstrap_auto_retry = true` (per-app flag, default false), retry once. After 3 consecutive failed retries, send a Telegram alert and stop auto-retrying.

### Logging & observability

- **FR-023**: Each bootstrap step MUST produce a `script_runs` row tagged `script_id = bootstrap/<step>` with the existing log viewer integration. Log retention follows the existing prune (feature 001).
- **FR-024**: A Telegram message MUST fire on `ACTIVE` (success) and on `failed_<step>` (failure). NOT per-step success — that would be noise.
- **FR-025**: The Servers > Apps list MUST show bootstrapping apps with a yellow indicator (distinct from feature 006's health yellow — use a different shape, e.g. spinning ring vs solid dot) and a "Bootstrapping: <step>" tooltip.
- **FR-026**: The wizard's progress UI MUST poll `GET /api/applications/:id/bootstrap-state` every 2 seconds while open, OR subscribe to a WS channel for live updates.

### Safety

- **FR-027**: The slug regex (`^[a-z0-9]+(-[a-z0-9]+)*$`) MUST be enforced server-side, NOT trusted from the client. Path traversal protection: explicitly reject any input containing `..`, `/`, `\`, or shell metacharacters.
- **FR-028**: The hard-delete `rm -rf` MUST verify the resolved path is a subdirectory of `${DEPLOY_USER_HOME}/apps/` via SSH before execution. If the path resolves elsewhere (operator manually edited DB, symlink games), the rm is aborted with a clear error.
- **FR-029**: PAT injection in clone command MUST be done via a single-quoted heredoc on the target shell to prevent the PAT from appearing in process lists (`ps`, `/proc/*/cmdline`). Verify with: a `ps`-during-clone test that does not see the PAT.

### Repo & manifest integration

- **FR-030**: The `applications.deploy_script` for bootstrapped apps MUST default to `deploy/server-deploy` (the builtin git-backed deploy from feature 005). If the repo has a project-local deploy script (feature 007) the operator can opt in via the Edit Application screen post-bootstrap.
- **FR-031**: Bootstrap MUST set `applications.skip_initial_clone = false` (the inverse of feature 003's value for scan-imports). This makes the next regular deploy NOT skip the initial clone check — though it should be fast-path "already cloned".
- **FR-032**: A new column `applications.created_via TEXT NOT NULL DEFAULT 'manual'` MUST be introduced with enum values `manual | scan | bootstrap`. Bootstrap MUST always write `'bootstrap'` to this column on app creation. Migration backfill rules: rows with `skip_initial_clone = true` → `'scan'`; all other existing rows → `'manual'`. The column is read-only after creation — operators do not change how an app got into the system retroactively.
- **FR-033**: The Apps list UI SHOULD support filtering by `created_via` (e.g. "show only bootstrapped apps") via a dropdown filter. Persistence of the filter selection (localStorage vs server-side) is implementation choice.

## Success Criteria

- **SC-001**: Median time from "click Bootstrap" to `ACTIVE` for a small public repo is ≤ 90 seconds (clone + compose up + healthcheck for a typical Node.js app).
- **SC-002**: 95% of bootstraps that fail at any non-final step are recoverable via Retry + (optional) Edit Config without re-running prior steps. Validated on first 30 production bootstraps.
- **SC-003**: Zero PAT leaks in production: grepping `script_runs.params` and `app_bootstrap_events.metadata` for substrings matching the PAT pattern returns 0 rows.
- **SC-004**: Hard delete of a bootstrapped app removes 100% of server-side state — verifiable by SSH grep on `${remote_path}` (gone), `docker ps -a` (no containers), `nginx -T && curl localhost:2019/config/` (no Caddy site).
- **SC-005**: Operator-friction reduction: median number of SSH sessions per new app onboarding drops from 2-3 (pre-feature) to 0. Validated by counting SSH sessions to managed targets before / after rollout (proxy via `last` command).
- **SC-006**: Bootstrap success rate (apps reaching `ACTIVE` on first attempt without retry) is ≥ 70% on first 50 production bootstraps. Lower indicates auto-detection rules need tuning.

## Key Entities

### `applications` (modified — new columns)

- `bootstrap_state TEXT NOT NULL DEFAULT 'active'` — one of `init | cloning | compose_up | healthcheck | proxy_applied | cert_issued | active | failed_clone | failed_compose | failed_healthcheck | failed_proxy | failed_cert`. Existing rows backfill to `active`.
- `bootstrap_auto_retry BOOLEAN NOT NULL DEFAULT FALSE` — opt-in for the reconciler to auto-retry failed steps.
- `upstream_service TEXT NULL` — compose service name proxied by Caddy; NULL if app has no proxy.
- `upstream_port INTEGER NULL` — internal container port for the upstream service; NULL if app has no proxy.
- `compose_path TEXT NOT NULL DEFAULT 'docker-compose.yml'` — relative path from `remote_path` to the compose file.
- `created_via TEXT NOT NULL DEFAULT 'manual'` — one of `manual | scan | bootstrap`. Backfilled on migration: `scan` for rows where `skip_initial_clone = true`, `manual` otherwise. Read-only after creation.

### `app_bootstrap_events` (new table)

Append-only log of state machine transitions:

```
id TEXT PRIMARY KEY,
app_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
from_state TEXT NOT NULL,
to_state TEXT NOT NULL,
occurred_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
metadata JSON NULL              -- step-specific context (error message, container ids, retry count, etc.)
```

### Wizard state (in-flight, not persisted directly — derived from above)

The wizard reads `applications.bootstrap_state + app_bootstrap_events` to render its progress UI. There is no separate "wizard sessions" table — the wizard is stateless; the dashboard's app rows are the source of truth.

## Assumptions

- A-001: GitHub is the only code-hosting provider supported in v1. GitLab / Bitbucket / self-hosted Gitea — out of scope.
- A-002: GitHub PAT (or equivalent SSH key from feature 002) is already configured. Bootstrap does NOT include PAT setup — that's feature 002's domain.
- A-003: Target server has Docker and docker-compose installed (per `setup-vps.sh`). Bootstrap fails at `COMPOSE_UP` with a clear "Docker not installed on this server" message if absent.
- A-004: Target server has Caddy installed (per feature 008's extension to `setup-vps.sh`) IF the operator wants a domain. Without a domain, Caddy is not required for bootstrap.
- A-005: Repos use docker-compose (compose v2 syntax). Pure Dockerfile builds, Kubernetes manifests, raw scripts — out of scope for v1.
- A-006: Compose file lives in the repo (NOT generated at build time, NOT fetched from a separate location). Pre-clone fetch via GitHub API requires the file to exist in the source tree.

## Dependencies

- **Feature 001 (devops-app)**: `applications` table, `script_runs` infrastructure, deploy log viewer.
- **Feature 002 (gh-integration)**: GitHub connection, PAT storage, repo listing API. Required for repo selector.
- **Feature 003 (scan-for-repos)**: shares the slug derivation, "is .git directory present" check, and `skip_initial_clone` semantics.
- **Feature 004 (db-deploy-lock)**: serialises bootstrap `COMPOSE_UP` against concurrent operations on the same server.
- **Feature 005 (script-runner)**: each bootstrap step is a `script_runs` invocation. Manifest gains entries `bootstrap/clone`, `bootstrap/compose-up`, `bootstrap/wait-healthy`, `bootstrap/finalise`.
- **Feature 006 (app-health-monitoring)**: provides `wait-for-healthy` semantics during `HEALTHCHECK` step; provides per-app health indicator after `ACTIVE`.
- **Feature 008 (application-domain-and-tls)**: `PROXY_APPLIED` and `CERT_ISSUED` steps delegate to feature 008's reconciler and Caddy admin API integration.

## Out of Scope

- Non-GitHub code hosting (GitLab, Bitbucket, self-hosted) — v2.
- Non-compose deployment models (Kubernetes, plain Dockerfile, systemd-unit-only apps) — v2.
- Auto-detection of build-time secrets / build-args (BuildKit `--secret`, build-args from env) — v1 fails at compose if missing; operator manually edits compose or env_vars.
- Automatic env_vars population from GitHub repo secrets — security dimension out of scope (feature would need Vault-style integration).
- Cross-repo monorepo support (one repo, two apps to bootstrap from different paths) — v1 supports one app per repo.
- Bootstrap from a tag instead of a branch — defer to Advanced edit post-bootstrap.
- Bootstrap on a freshly-provisioned server (where Docker / Caddy / nginx are not installed yet) — out of scope; `setup-vps.sh` is a prerequisite.
- Roll-forward / roll-back during bootstrap — failed steps stop in place; no automatic remediation beyond Retry.

## Related

- Spec 008 `/specs/008-application-domain-and-tls/spec.md`: provides domain attachment + TLS issuance for bootstrap's optional Domain field.
- Spec 006 `/specs/006-app-health-monitoring/spec.md`: provides healthcheck semantics for bootstrap step 4.
- Spec 007 `/specs/007-project-local-deploy/spec.md` line 12: this feature explicitly reverses 007's "first-deploy out of scope" decision.
- Existing `scripts/deploy/deploy.sh:122-141` has dormant clone-on-target logic from a pre-dashboard era; bootstrap MAY reuse the patterns but ships its own implementation aligned with the state machine.
- CLAUDE.md rule 5 (no direct migrations): schema additions ship as reviewable SQL.

## Open Questions

- OQ-001 (carry-over): For monorepos with multiple compose files, the wizard supports one compose-path. Should there be a "bootstrap multiple apps from this repo" sub-flow, or do operators bootstrap each app separately by changing `composePath`? Defer to v2 — explicit non-decision.
