# Feature Specification: Scan Server for Existing Repositories and Docker Apps

**Version**: 1.0 | **Status**: Draft | **Date**: 2026-04-20

## Problem Statement

Adding an application to the DevOps Dashboard today is fully manual. Even with GitHub integration (feature 002), an admin still types the **remote path**, **deploy script path**, and branch, then waits while the deploy pipeline clones the repository from scratch into a fresh directory. On a brownfield server this is wasteful and error-prone:

- Most servers already have the application checked out at a well-known path (`/opt/app`, `/var/www/site`, `/srv/service`). The existing working tree, its `.git` metadata, current branch, HEAD commit, and `.env` are ignored and overwritten.
- Many apps on the server run only as Docker containers or `docker compose` stacks. The dashboard has no way to notice them — the admin has to SSH in, read compose files, and translate the content into dashboard fields by hand.
- Typos in `remotePath` or `deployScript` cause deploys to fail or, worse, write into the wrong directory.

Admins want a **discovery step** before the Add Application form: the dashboard inspects the server over its existing SSH connection, lists candidate applications (git repos and Docker services), and lets the admin import a candidate with one click. The resulting application entry points to the existing directory / compose file instead of triggering a fresh clone.

## User Scenarios

### US-001: Scan a Server for Candidates

**Actor**: Dashboard admin
**Precondition**: A server is registered and SSH-reachable (status = `online`).

1. Admin opens the server's **Apps** tab.
2. Next to the existing **Add Application** button the admin sees a new **Scan Server** button.
3. Admin clicks **Scan Server**. A modal opens showing scan progress (spinner + current path being inspected).
4. The scan runs over SSH and returns two grouped result lists:
   - **Git repositories** — directories containing a `.git` folder
   - **Docker apps** — running containers and `docker-compose.yml` / `compose.yaml` files discovered on disk
5. Each candidate shows enough information to identify it (see FR-020, FR-030). The admin can expand a candidate to see detected details.
6. Candidates already imported as applications on this server are marked **Already added** and disabled — the dashboard will not suggest importing the same path twice.

### US-002: Import a Git Repository Candidate

**Actor**: Dashboard admin
**Precondition**: Scan results include a git repository candidate that is **not** already imported.

1. Admin clicks **Import** on a git repository candidate.
2. The **Add Application** form opens pre-populated with:
   - `name` — derived from the directory's basename (editable)
   - `repoUrl` — detected from `git remote get-url origin`
   - `branch` — detected from `git rev-parse --abbrev-ref HEAD`
   - `remotePath` — absolute path of the directory on the server
   - `currentCommit` — detected from `git rev-parse HEAD`
   - `githubRepo` — auto-filled as `owner/repo` if `repoUrl` matches a GitHub URL
3. `deployScript` is left blank with a suggestion dropdown containing any executable `deploy*.sh` files found inside the directory; the admin confirms or types their own path.
4. Admin reviews the pre-filled form, edits as needed, and clicks **Save**. The application is saved using the existing `POST /api/servers/:id/applications` endpoint. **No clone is triggered.**
5. The first deploy uses the existing working tree (`git fetch` + checkout), not a fresh clone.

### US-003: Import a Docker Container or Compose Stack

**Actor**: Dashboard admin
**Precondition**: Scan results include a Docker candidate.

1. Admin clicks **Import** on a Docker candidate.
2. The form opens pre-populated differently depending on the candidate type:
   - **Compose file**: `name` = compose project directory, `remotePath` = directory containing the compose file, `deployScript` = suggested wrapper (e.g. `docker compose pull && docker compose up -d`), `repoUrl`/`branch` blank
   - **Standalone container**: `name` = container name, `remotePath` = container's labelled working dir (`com.docker.compose.project.working_dir` or image `WorkingDir`) if present, otherwise blank
3. A badge **Docker app** is shown on the form to signal that repository fields are optional.
4. Admin completes any missing fields and saves. The application is created with the same schema as git-based apps (no new entity type).

### US-004: Re-scan After Adding a New App on the Server

**Actor**: Dashboard admin
**Precondition**: Admin has SSH'd in and cloned a new repo or started a new compose stack manually.

1. Admin clicks **Scan Server** again.
2. The new directory / container appears in the results; previously imported ones remain marked **Already added**.
3. Admin imports the new candidate without leaving the dashboard.

### US-005: Cancel a Long Scan

**Actor**: Dashboard admin
**Precondition**: A scan is running and taking longer than expected (e.g. server has a very deep `/home`).

1. The scan modal shows a **Cancel** button while running.
2. Admin clicks **Cancel**. The backend kills the in-flight SSH command and returns partial results collected so far (or none).
3. The dashboard remains responsive. No zombie processes remain on the server (verified by FR-062).

## Functional Requirements

### Scan Trigger and Scope

- **FR-001**: The dashboard must expose a **Scan Server** action on the server's Apps tab. The action must be disabled when the server status is `offline`.
- **FR-002**: A single scan must run only on the selected server. No cross-server scanning in v1.
- **FR-003**: Each scan must run as a single SSH session (reusing `ssh-pool`) and complete within a **60-second hard timeout**. If the timeout expires, the backend returns whatever was collected and marks the result **Partial**.
- **FR-004**: The set of scanned root paths must be configurable per server with a sensible default list: `/opt`, `/srv`, `/var/www`, `/home`, and the server's `scriptsPath`. Admins can extend the list in settings; paths outside the list are never traversed.
- **FR-005**: Directory traversal must have a **max depth of 4** from each root. Well-known skip directories (`node_modules`, `.git` internals, `vendor`, `dist`, `build`, `.cache`, `.next`) must not be descended into.
- **FR-006**: Candidates that the operating user cannot read must be silently skipped — a scan must never fail just because one directory returned `Permission denied`.

### Git Repository Detection

- **FR-020**: A directory qualifies as a git candidate if it contains a readable `.git` directory (or `.git` file for submodules — treated as git candidate pointing at the worktree root).
- **FR-021**: For each git candidate the backend must collect:
  - Absolute path
  - Remote URL from `origin` (if set; null otherwise)
  - Current branch name
  - HEAD commit SHA (short + long)
  - Whether the working tree is dirty (`git status --porcelain`)
  - Last commit date and subject
- **FR-022**: Git data collection must run with a per-candidate timeout of 3 seconds. A slow candidate does not block the rest of the scan — it returns what it has and moves on.
- **FR-023**: If a candidate's `remoteUrl` matches `github.com/owner/repo(.git)?`, the backend must normalise it to the `owner/repo` form and set it as `githubRepo` on import.

### Docker Detection

- **FR-030**: The backend must run `docker ps --format <JSON>` and `docker ps -a` to list running and stopped containers (same command family as existing `/api/docker` route — no new tooling).
- **FR-031**: The backend must find `docker-compose.yml`, `docker-compose.yaml`, `compose.yml`, and `compose.yaml` files under the configured scan roots within the same traversal as git detection (single pass, not two walks).
- **FR-032**: For each compose file the backend must collect: absolute path, compose project name (from `name:` field or directory basename), services list with image tags, and current running state (by matching container names against `docker ps`).
- **FR-033**: For containers that are **not** part of any detected compose project the backend must emit a standalone-container candidate with: container name, image, running state, and — if present — the `com.docker.compose.project.working_dir` label.
- **FR-034**: If Docker is not installed on the server (`command -v docker` fails), the Docker section is returned empty with a flag `dockerAvailable: false` — the scan must not fail.

### Deduplication with Existing Applications

- **FR-040**: Before returning, the backend must mark each candidate as `alreadyImported: true` when any of the following matches an existing `applications` row on the same server:
  - Absolute path equals `applications.remotePath`
  - Git remote URL equals `applications.repoUrl`
  - Compose file parent directory equals `applications.remotePath`
- **FR-041**: The UI must render **Already added** candidates as disabled rows with a link that jumps to the existing application's detail page.

### Import Flow

- **FR-050**: Importing a candidate must reuse the existing Add Application form component. The form state is populated from the candidate payload; no new dedicated screen is added.
- **FR-051**: Imported applications must be saved via the existing `POST /api/servers/:id/applications` endpoint (no new write endpoint). The backend must accept an optional `source: "scan"` field in the request body for audit purposes.
- **FR-052**: For git-based imports, the dashboard must **not** trigger a clone on save. The next deploy must work against the existing working tree (`git fetch origin <branch> && git checkout <branch> && git reset --hard origin/<branch>`) — this is a change to the deploy script contract that must be documented.
- **FR-053**: For Docker-only imports where `repoUrl` is blank, the deploy-script validation must allow empty git fields and rely solely on the supplied `deployScript` (e.g. compose pull + up).

### API, Security, and Performance

- **FR-060**: Scan results must be returned via `POST /api/servers/:id/scan`. The response includes `{ gitCandidates, dockerCandidates, dockerAvailable, partial, durationMs }`.
- **FR-061**: The scan endpoint must require the same admin session as other server operations. Non-admin users must receive 403.
- **FR-062**: Every SSH command issued by the scan must be bounded by a timeout (per FR-003, FR-022) and cancellable. When the HTTP request is aborted by the client, in-flight SSH commands must be killed within 2 seconds.
- **FR-063**: All paths and output echoed back to the UI must be treated as untrusted input. The backend must not interpret candidate paths as shell fragments — commands are always built from a whitelisted path argument quoted via the SSH library's own escaping.
- **FR-064**: Scan results are **not persisted** in the database. Each scan is a one-shot call; stale results are avoided by always re-running when the user opens the scan modal.

### Error Handling

- **FR-070**: If SSH connection fails, the endpoint returns 503 with a clear message ("Server unreachable — check SSH credentials"). The UI surfaces this inline in the scan modal and offers a **Retry** button.
- **FR-071**: If a required command is missing on the server (`git`, `find`), the affected section returns empty with a flag (e.g. `gitAvailable: false`) — the scan still succeeds for the sections that did run.
- **FR-072**: Partial results are clearly labelled in the UI ("Scan timed out after 60s — showing 42 candidates found so far") so admins can decide whether to narrow roots and re-scan.

## Success Criteria

- **SC-001**: Adding an application from a brownfield server drops from **6 manual fields** to at most **1 (deploy script)** — verified by counting editable fields post-import.
- **SC-002**: A scan on a server with up to 200 candidate directories under the default roots completes in under **15 seconds** on a typical 2-vCPU VPS.
- **SC-003**: No scan leaves orphaned SSH processes on the server — verified by `ps aux | grep <scan-pid>` being empty 5 seconds after the HTTP response.
- **SC-004**: A candidate that is already imported is never shown as importable (zero duplicate applications created via the scan path).
- **SC-005**: First deploy of a scan-imported git application runs successfully without re-cloning (deploy log shows `git fetch` followed by checkout, no `git clone`).
- **SC-006**: A Docker-compose import can be deployed from the dashboard using only the pre-suggested `docker compose` deploy script, with no manual edits.

## Out of Scope (v1)

- Automatic scheduled re-scans (cron). Scans remain on-demand.
- Scanning servers that are not yet registered — server must already be added.
- Bulk import (selecting multiple candidates at once and saving in one click). v1 imports one candidate at a time.
- Detection of Kubernetes manifests, systemd unit files, PM2 ecosystem files, or other process managers. Git + Docker only in v1.
- Pulling `.env` values from the server into the `envVars` column. Admins still manage env vars via the existing Add Application flow.
- Reconciling drift between the imported application's state and the server after import (e.g. noticing that someone changed branch on the server). Covered by a future "Reconcile" feature.
- Cross-server search ("find where is my app deployed").

## Key Entities

### ScanResult (transient, API response only)

Not stored in the database. Returned by `POST /api/servers/:id/scan`.

- **GitCandidates**: array of `GitCandidate`
- **DockerCandidates**: array of `DockerCandidate`
- **DockerAvailable**: boolean
- **GitAvailable**: boolean
- **Partial**: boolean (true when scan hit the 60s timeout)
- **DurationMs**: integer

### GitCandidate

- **Path**: absolute directory path on the server
- **RemoteUrl**: origin URL (nullable)
- **GithubRepo**: `owner/repo` if remote is a GitHub URL, else null
- **Branch**: current branch name
- **CommitSha**: HEAD long SHA
- **CommitSubject**: HEAD commit first line
- **CommitDate**: ISO8601
- **Dirty**: boolean
- **SuggestedDeployScripts**: array of paths to executable `deploy*.sh` inside the directory (may be empty)
- **AlreadyImported**: boolean
- **ExistingApplicationId**: string when `AlreadyImported` is true, else null

### DockerCandidate

- **Kind**: `compose` | `container`
- **Path**: absolute path (compose file for `compose`, nullable for `container`)
- **Name**: compose project name or container name
- **Services**: array of `{ name, image, running }` for `compose`; single-element array for `container`
- **AlreadyImported**: boolean
- **ExistingApplicationId**: nullable

## Dependencies

- DevOps Dashboard v0.1 (`001-devops-app`) — SSH pool, applications table, Add Application form.
- GitHub Integration (`002-gh-integration`) — reused for `githubRepo` normalisation. Not a hard dependency; scan works without GitHub connected.

## Assumptions

- The SSH user configured for a server has read access to the scan roots. Directories the user cannot read are silently skipped — the dashboard does not escalate to `sudo`.
- `find`, `git`, and (optionally) `docker` are installed on the server. Absence of `docker` is gracefully handled; absence of `find`/`git` makes git detection return an empty list with an availability flag.
- Max depth 4 is enough for typical layouts (`/opt/project/apps/web/.git`). Deeper monorepos can be handled by adding a narrower root in settings.
- Scan results do not need to be cached. Admins trigger scans only when adding apps, which is rare.
- Brownfield apps imported from a scan have their working tree in a usable state (correct branch, clean or deliberately dirty). If not, the first deploy will reset it — admins are warned via the "Dirty" badge on the candidate.

## Clarifications

No open questions — the feature fits inside existing primitives (SSH pool, applications table, Add Application form) and inherits security model from feature 001. If implementation reveals ambiguity, it will be recorded here before `/speckit.plan`.
