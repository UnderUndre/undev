# Feature Specification: Universal Script Runner

**Version**: 1.0 | **Status**: Draft | **Date**: 2026-04-21

## Clarifications

### Session 2026-04-22 (Gemini antigravity review)

- Q: Is the regex-strip approach for removing `source common.sh` from target scripts robust? → A: No. Replaced with bash function override — the preamble redefines `source()` and `.()` to no-op when argument matches `*/common.sh` and delegate to `builtin source/.` otherwise. Form-agnostic, idempotent, no regex over bash source code. See FR-015, R-003.
- Q: Do secrets injected via `env SECRET=... bash -s` SSH argv leak to target's sshd/auditd logs? → A: Yes, under `LogLevel VERBOSE` or `auditd -a always,exit -S execve`. Moved secret exports INTO the stdin buffer — SSH argv is now invariant `bash -s`, secrets travel in the encrypted data channel and never touch sshd/auditd. See FR-016, R-006.
- Q: Should a broken manifest entry abort dashboard startup? → A: No — fail-fast was strict but too dangerous (a typo in a PR could brick the UI needed to roll back). Split into strict CI gate (T022 unit test, blocks PR merge) + lenient runtime (annotate `valid:false`, disable in UI, dashboard still boots). Duplicate-id remains fatal because dispatch is ambiguous. New error code `INVALID_MANIFEST_ENTRY` (400). See FR-003, R-009.
- Q: Is startup-only retention prune sufficient? → A: No — long-running dashboards accumulate unbounded history. Added background `setInterval(24h).unref()`, configurable via `SCRIPT_RUNS_PRUNE_INTERVAL_MS`. See FR-042, R-010.
- Q: Does the prune delete log files still referenced by `deployments` rows? → A: Fixed — the DELETE's RETURNING clause now emits `owned_log_path` (NULL when `deployment_id IS NOT NULL`). Logs are unlinked only when the `script_runs` row owns them (no linked deployment). See FR-042 log-file ownership rule, R-010.
- Q: Is the claim "old code tolerated null `deploy_script`" in A-002 true? → A: No — `buildDeployCommand` classic mode unconditionally interpolates `deployScript` into the shell command, so null produces `${remotePath}/undefined`. Revised A-002: rollback is a manual ops procedure requiring a pre-release pg_dump + DOWN migration + value restoration from the dump. Pre-migration audit script (T032) now also takes the backup. See A-002.
- Q: How does the runner detect zombie SSH streams (TCP drop without FIN)? → A: New FR-017 — sshPool configures `keepaliveInterval: 30_000, keepaliveCountMax: 3`, AND the runner wraps the whole `runScript` in an `AbortController` bound to `manifest.timeout`. Both layers fire independently; whichever fires first terminates the run cleanly with `status: timeout`. See FR-017, T011, T026.
- Q: What does the client do when Re-run or Rollback returns 409 DEPLOYMENT_LOCKED? → A: Explicit user-friendly toast "Another operation is in progress on this server (`<lockedBy>`)" with link to the holding run — NOT a generic error alert. Shared contract between Run Dialog and Rollback UI. See T046.
- Q: Can a direct API call bypass the `dangerLevel: "high"` UX typing-confirmation? → A: Yes. FR-051 now documents this explicitly as authenticated-admin-only security debt with a v2 mitigation path (server-side confirmation token validated against manifest). Accepted risk for v1.

### Session 2026-04-21

- Q: How should script parameters be quoted when serialised into the `bash -s` argv? → A: POSIX single-quote escape via the existing `shQuote` helper from `server/services/deploy-command.ts` — each param value wrapped in `'...'`, embedded `'` escaped as `'\''`. No new npm dependency. Zod-level rejection of metacharacters remains an optional opt-in per-field, not the primary defence.
- Q: How does the runner handle `source "$(dirname "$0")/common.sh"` when scripts are transported via `ssh 'bash -s' < script.sh`? → A: Concatenate at runtime — the runner reads `scripts/common.sh` and the target script, strips the `source .../common.sh` line from the target, and pipes the joined buffer into `bash -s`. Scripts on disk are unchanged, DRY preserved, zero target-side state.
- Q: How are secret-valued script parameters handled end-to-end (history, audit, live logs, transport)? → A: Zod `.describe("secret")` marker. Params so-marked are (a) transported via `env VAR='...' bash -s`, never as argv (invisible to `ps auxwww` on the target), (b) stored in `script_runs.params` as the literal string `"***"` (not the real value), (c) redacted from `auditMiddleware` body-capture and from live WS log events by the existing pino redact config extended with the new path, (d) passed to the script as an env-var whose name is `SECRET_<UPPER_SNAKE_PARAM_NAME>`. The real value lives only in RAM for the duration of one run and is never persisted.
- Q: What happens to `script_runs` rows whose `script_id` is no longer present in the manifest (script deleted in a later dashboard release)? → A: History is immutable. `script_runs` rows are never deleted on manifest changes. UI on the Runs page and the run detail view show the historic `script_id` with an "archived" badge; Re-run action is hidden/disabled for archived entries with a tooltip explaining the script no longer exists. No manifest tombstones, no build-time manifest diff, no cascade-delete migration.
- Q: Does dropping `applications.deploy_script` happen in one migration or two (nullable-first → drop-later)? → A: Single migration, atomic with the feature release. `0005_drop_deploy_script.sql` drops the column in the same release that stops reading/writing it. Dashboard container swap is atomic; rollback restores the column as nullable. Matches the one-migration-per-feature convention already used by features 001–004.

## Problem Statement

The DevOps Dashboard today has a structural inversion between what it IS and what it LOOKS LIKE. The real operational logic lives in the repo's `scripts/` tree (14 scripts across 7 categories — deploy, db, backup, docker, monitoring, server, dev). Each script is a self-contained, sourced-from-`common.sh`, colour-logged bash utility that runs on a target server and knows how to do one job. The dashboard itself is, in the best reading, a **frontend for these scripts plus some backing state**: it tracks servers and applications in Postgres, it schedules some operations, and it streams output over WebSocket. But every script the dashboard orchestrates has its own custom code path in `devops-app/server/`:

- `deploy/deploy.sh` is invoked via a free-text `applications.deploy_script` field filled in by the admin on app creation. The admin has to know the path and name of the script **on the target server**. If the admin imports an app via feature 003's scan flow, the path is guessed. If they create the app manually, they type "deploy.sh" and hope.
- `deploy/rollback.sh` is invoked via a bespoke `/api/apps/:id/rollback` route that string-replaces `deploy.sh` → `rollback.sh` in the app's configured script path (see `server/routes/deployments.ts:281`).
- `db/backup.sh` and `db/restore.sh` are not reachable from the dashboard at all — admins SSH in and run them manually.
- `docker/cleanup.sh`, `monitoring/security-audit.sh`, `server/health-check.sh` — same: SSH-only, no UI.
- The scripts are not versioned with the dashboard — they live in the same repo, so they happen to move together today, but the dashboard has no notion of "which version of this script am I about to run".

This design has three compounding costs:

1. **Every new operation is a new feature.** Adding "run security-audit from the dashboard" today means writing a new route, a new UI page, a new service, a new button wiring — even though the actual work is `ssh server bash -s < scripts/monitoring/security-audit.sh`. The marginal cost of a new script in the UI is a full dashboard feature sprint.
2. **The admin's mental model is wrong.** The dashboard's "Add Application" form asks for a *Deploy Script* path, implying scripts are an application-level configuration — but they're not. Every app of a given flavour runs the exact same `scripts/deploy/deploy.sh`. The field is ceremony. Scan imports suffer the most: the scan picks a path, the admin doesn't check it, and the deploy fails three weeks later.
3. **The repo's investment in `scripts/` is invisible.** A contributor who adds `scripts/db/restore.sh` improves the project's capabilities materially — but a dashboard user will never know it exists. Ops knowledge accumulates in the repo and evaporates at the UI boundary.

This feature inverts the relationship: the dashboard becomes a **thin, generic runner** that discovers operations from the `scripts/` tree via a typed manifest, generates a parameter form from each operation's schema, executes the operation against a chosen server via existing SSH/job-streaming primitives, and records the run in a history table. The specific free-form `deploy_script` field is removed — deploy becomes one operation among many, with its flavour auto-dispatched from application metadata (source, docker vs. git, scan-imported vs. manual). Adding a new operation becomes a two-file change: drop a script into `scripts/<category>/`, add a manifest entry declaring its parameters and locus.

## User Scenarios

### US-001: Browse Available Operations for a Server

**Actor**: Dashboard admin
**Precondition**: Server `srv-1` exists in the dashboard and is reachable via SSH.

1. Admin opens `srv-1`'s detail page.
2. A new **Scripts** tab is visible alongside Apps / Health / Backups / Logs / Docker.
3. Admin clicks **Scripts**.
4. The dashboard shows a categorised list of all runtime scripts from the manifest grouped by category (Deploy / Database / Docker / Monitoring / Server-Ops), each entry showing its name, one-line description, and a **Run** button.
5. Local-only scripts (`scripts/dev/setup.sh`) and bootstrap scripts (`scripts/server/setup-vps.sh`) are NOT in the list — they require different flows.

### US-002: Run an Ad-Hoc Operation Against a Server

**Actor**: Dashboard admin
**Precondition**: Admin has selected `db/backup.sh` from the Scripts tab of `srv-1`. The script's manifest declares two parameters: `databaseName: string` (required) and `retentionDays: number` (default 30).

1. Admin clicks **Run** on the `db/backup.sh` row.
2. A dialog opens with a form auto-generated from the script's parameter schema: a required text field for `databaseName` and a number field for `retentionDays` pre-filled with `30`.
3. Admin enters `mydb`, leaves retention at 30, clicks **Run**.
4. The dashboard starts a run: opens a live-streamed log view, shows status "running", and records a row in `script_runs` (new table) with `script_id`, `server_id`, parameters, `started_at`, `user_id`.
5. The runner invokes the script on `srv-1` via SSH stdin transport (the bash source is piped from the dashboard's bundled copy).
6. Logs stream back via the existing WebSocket/job manager infrastructure (the same pipe today's deploys use).
7. Script exits 0 → status "success"; admin sees final output and an artefact reference if the manifest declares one (e.g. the backup file path). Exit non-zero → status "failed" with `exit_code` + last stderr lines captured.

### US-003: Deploy an Application Without Configuring a Script Path

**Actor**: Dashboard admin
**Precondition**: Admin is creating a new application via the manual form (not scan). Application is a classic git-based deploy.

1. Admin fills in Name, Branch, Repository URL, Remote Path.
2. The **Deploy Script** text field is no longer present on the form.
3. Admin clicks **Add**. The application is persisted without a `deploy_script` value.
4. Admin clicks **Deploy** on the new application.
5. The runner auto-dispatches based on application metadata (classic git / docker-compose / scan-docker flavour) and invokes the right bundled script (`scripts/deploy/deploy.sh` for classic git) with `--branch` and `--commit` parameters.
6. Deploy streams, completes, updates `applications.currentCommit` — behaviourally identical to today, but with zero free-form path input from the admin.

### US-004: One-Click Rollback

**Actor**: Dashboard admin
**Precondition**: `app-1` has a deployment history; the last deploy was a mistake.

1. Admin clicks **Rollback** on a previous successful deployment row.
2. The runner dispatches the bundled `scripts/deploy/rollback.sh` with the correct `--commit=<previous>` parameter.
3. The Rollback route no longer needs to string-replace `deploy.sh` → `rollback.sh` (today's hack at `server/routes/deployments.ts:281`). The script dispatch is a manifest lookup keyed by operation name + app flavour.

### US-005: Adding a New Operation Is a Two-File Change

**Actor**: Dashboard contributor
**Precondition**: They want to add `scripts/db/vacuum.sh` as a runnable operation.

1. Contributor creates `scripts/db/vacuum.sh` with a standard shebang, sources `common.sh`, accepts `--database` and `--full` flags.
2. Contributor opens `devops-app/server/scripts-manifest.ts` and adds one entry:
   ```ts
   { id: "db/vacuum", category: "db", description: "Vacuum a database", locus: "target",
     params: z.object({ database: z.string(), full: z.boolean().default(false) }) }
   ```
3. Contributor commits both files in one PR. No route, no service, no UI, no migration.
4. After merge + dashboard redeploy, the operation appears in the Scripts tab of every server automatically, with an auto-generated form matching the Zod schema.
5. No devops-app code needs editing to ship a new operation — the manifest is the interface.

## Functional Requirements

### Manifest & Discovery

- **FR-001**: A typed manifest file (`devops-app/server/scripts-manifest.ts`) MUST declare every runtime script as an entry with fields: `id` (unique, format `<category>/<script-name>`), `category` (enum: `deploy` | `db` | `docker` | `monitoring` | `server-ops`), `description` (one-line human string), `locus` (enum: `target` | `local` | `bootstrap`), `params` (Zod schema). Only entries with `locus === "target"` appear in server-scoped UI. `local` entries are reserved for dashboard-side ops (e.g. rotating dashboard's own DB backups); `bootstrap` entries are reserved for new-server setup flows (out of v1 UI).
- **FR-002**: The manifest MUST be the authoritative list. Scripts physically present in `scripts/` but NOT listed in the manifest MUST NOT be executable via the runner. This is a defence-in-depth boundary: committing a script to the repo does not auto-expose it; a separate manifest edit is required.
- **FR-003**: Every manifest entry MUST validate at dashboard startup — `id` uniqueness, `script-file exists on disk`, Zod schema compiles. Validation errors MUST NOT abort startup. Instead, the offending entries MUST be marked internally with `valid: false` and a `validationError: string` field; they remain in the manifest descriptor served by `GET /api/scripts/manifest` but with the flag visible. `POST /api/scripts/:id/run` MUST refuse execution for invalid entries with `400 INVALID_MANIFEST_ENTRY`. The UI MUST render invalid entries as disabled (greyed-out card, no Run button, tooltip showing the `validationError`). `id`-uniqueness violations are the one exception: duplicate ids are a hard startup failure because the DISPATCH is ambiguous (cannot pick which of two entries `POST /api/scripts/foo/bar/run` should execute). CI-time validation (T022) catches every case including duplicates before merge — runtime leniency exists solely so a broken manifest doesn't trap an operator out of the dashboard UI needed to fix it (e.g. to trigger a rollback).
- **FR-004**: Manifest entries MUST support optional metadata: `outputArtifact?: { type: "file-path" | "url" | "json"; captureFrom: "stdout-last-line" | "stdout-json" }` for scripts that emit a well-defined result (e.g. a backup file path) that the UI should surface distinctly from log tail; `timeout?: number` (max runtime in ms before the runner kills the process — default 30 min aligned with deploy-lock watchdog); `requiresLock?: boolean` (if true, the runner acquires the same `deployLocks` row as feature 004 before running; default false — monitoring/audit operations do NOT block deploys).

### Runner

- **FR-010**: A new service `scripts-runner.ts` MUST expose `runScript(scriptId, serverId, params, userId) → { jobId }`. Implementation: look up manifest entry, validate `params` against the entry's Zod schema (reject with `400 INVALID_PARAMS` on failure), read the bundled script bytes from disk, transport to the target server via SSH stdin (`ssh user@host 'bash -s' -- <flag-serialised-params> < /app/scripts/<category>/<script>.sh`), wire stdout/stderr into the existing `jobManager` so the existing WS log-stream path works unchanged.
- **FR-011**: Parameter serialisation MUST be unambiguous shell-safe: each declared param becomes `--<kebab-case-name>=<shell-quoted-value>`, where **shell-quoted-value is produced by the existing `shQuote` helper from `server/services/deploy-command.ts`** (POSIX single-quote wrap; embedded `'` escaped as `'\''`). This is the authoritative defence against command injection in user-supplied params — it handles every byte including metacharacters without a disallow-list. Zod-level metacharacter rejection MAY be added per-field as defence-in-depth (not required). Booleans become `--<name>` flag presence when true, absent when false. Arrays become repeated `--<name>=<value>` pairs. Numbers bound via the same quote rules as strings — the receiving script reads them as strings (standard bash convention). `null`/`undefined` params are omitted entirely.
- **FR-012**: Scripts MUST be bundled INTO the dashboard Docker image, NOT rsynced or pre-installed on the target server. Transport is always "source the script file from `/app/scripts/` inside the devops-app container, pipe to SSH". The target server's filesystem is never modified. This guarantees: (a) version lock between dashboard and scripts, (b) zero drift between target servers, (c) no server-side bootstrap required for new operations.
- **FR-015**: The runner MUST construct the transported bash buffer by concatenating three parts into stdin: (1) a preamble that exports `YES=true`, `CI=true`, all `SECRET_*` values (see FR-016), and overrides the `source` and `.` builtins with a shell function that no-ops for any argument path ending in `common.sh` (using `builtin source "$@"` as fallback for everything else); (2) the full contents of `scripts/common.sh` (shebang stripped); (3) the full contents of the target script (shebang stripped, `source` call left intact — it will hit our override and no-op). No regex-stripping of the `source` line — it is robust against every form a script author might use (`source X/common.sh`, `. X/common.sh`, `SRC=X; source "$SRC/common.sh"`), because bash resolves all of them through the overridden function. Scripts on disk remain unchanged.
- **FR-016 (secret parameters)**: A manifest-declared param marked as secret via Zod `.describe("secret")` MUST be treated as a separate transport channel from ordinary argv params. Concretely: (a) the runner MUST emit the value as an `export SECRET_<UPPER_SNAKE_PARAM_NAME>='<shQuoted>'` line **inside the stdin buffer piped to `bash -s`** — NOT in the SSH command argv and NOT in `env VAR='...' bash -s`. This means the secret never appears in the SSH command trace that `sshd` with `LogLevel VERBOSE` or a Linux `auditd execve` rule would record on the target, because the SSH command is just `bash -s` (no per-invocation variance) and the secret travels inside the encrypted data channel as part of the script body; (b) the `script_runs.params` JSONB persists the literal string `"***"` for that key, never the real value; (c) the existing `logger.ts` pino redact config MUST be extended to redact `*.params.<secretFieldPath>` before any log emission; (d) the `auditMiddleware` body-capture MUST apply the same redaction before writing `audit_entries.details`; (e) the live WS log events emitted by `jobManager` MUST NOT surface the secret value — standard script output is unaffected (secrets end up in the script's own control, e.g. piped into `aws configure` stdin); if a script accidentally echoes the secret, that is the script's bug, not the runner's. The real plaintext value lives only in the runner's in-memory variable for the duration of the single run (until GC), in the encrypted bytes over SSH, and in the bash process env table on the remote (readable via `/proc/$$/environ` by the same user, but not by sshd or auditd). The ps-auxwww / auth.log / execve-audit exposure paths are closed.
- **FR-013**: The runner MUST respect `requiresLock` per manifest entry. For entries with `requiresLock === true`, the runner MUST acquire the feature-004 `deployLocks` row before spawning SSH and release it on terminal status. For entries with `requiresLock === false` (default), no lock is acquired — a deploy may be running simultaneously with a health-check. The manifest author is responsible for declaring this correctly.
- **FR-014**: The runner MUST timeout scripts at `manifest.timeout ?? 1_800_000` ms. On timeout: kill the SSH process, mark the run as `failed` with `error_message = "Script timed out after Xms"`, release any lock acquired.
- **FR-017 (SSH keepalive + abort signalling)**: The runner MUST NOT rely solely on Node.js stream events to detect SSH disconnection. `sshPool` MUST configure ssh2's `keepaliveInterval: 30_000` and `keepaliveCountMax: 3` at connection time so a silently dropped TCP connection (network partition, NAT table eviction, cloud-provider idle kill) is detected within 90 s and fires the `close` event. The runner MUST additionally wrap the whole `runScript` invocation in an `AbortController`-backed timeout guard bound to `manifest.timeout`: if the timeout fires before `close` (e.g. due to a very slow network that keepalive isn't enough to tear), the runner aborts the SSH stream via `kill()` and transitions the run to `timeout` status. This closes the gap where a "zombie" stream would otherwise wait the full FR-014 timeout before being reaped.

### Deploy Consolidation

- **FR-020**: `applications.deploy_script` TEXT column MUST be dropped in a new migration `0005_drop_deploy_script.sql` in the same release that stops reading/writing it. Rollout is atomic (container swap); there is no intermediate nullable-first step. The deploy dispatch moves to a pure function `resolveDeployOperation(app) → { scriptId, paramOverrides }` keyed off application metadata:
  - Classic git app (`source: manual`, not `docker://` URL): → `deploy/deploy.sh`
  - Docker-compose scan import (`source: scan`, `repoUrl: docker://...`): → (new) `deploy/deploy-docker.sh` if it exists, or the current `buildDeployCommand` `raw` mode wrapped as a script
  - Scan-git import (`source: scan`, not docker): → `deploy/deploy.sh` with `skipInitialClone` preserved via param
- **FR-021**: The **Deploy Script** input MUST be removed from the Add Application and Edit Application forms. The Edit form MUST NOT accept a `deploy_script` field in the request body (server rejects with `400` if present).
- **FR-022**: Rollback MUST migrate away from the `server/routes/deployments.ts:281` string-replace. The rollback operation becomes a manifest lookup for `deploy/rollback.sh` dispatched with `--commit=<target>`. The `/api/apps/:id/rollback` route stays backward-compatible from the client's perspective (same URL, same 201 response shape) but internally is a thin wrapper over `scriptsRunner.runScript("deploy/rollback", ...)`.
- **FR-023**: All existing deploy-related tests (`tests/integration/deploy*.test.ts`, `tests/integration/deploy-lock.test.ts`) MUST continue to pass with no behavioural regressions: same HTTP contract, same 409 conflict path, same job/log stream, same deploy lock semantics.

### UI Surface

- **FR-030**: Server detail page MUST gain a **Scripts** tab positioned between Apps and Health. The tab MUST show a categorised list of all `locus === "target"` manifest entries with name, description, and a Run button.
- **FR-031**: The Run dialog MUST auto-generate a form from the manifest entry's Zod schema: `z.string()` → text input, `z.number()` → number input, `z.boolean()` → checkbox, `z.enum([...])` → select, `z.string().optional()` → not-required field, `.default(x)` → pre-fill with `x`. Zod errors MUST surface under the offending field; the Run button MUST be disabled until validation passes.
- **FR-032**: On Run submit, the UI MUST navigate to a live log view (existing job-detail route pattern). The log view MUST distinguish script runs from deploys via a visible script name + category header.
- **FR-033**: A new top-level **Runs** navigation item in the sidebar MUST list the last 50 script runs across all servers, sortable by start time, filterable by status / server / script id. Each row links to the detail (same live-log view as FR-032 but post-mortem).
- **FR-034**: The **Add Application** form MUST NOT show a Deploy Script field. No path, no dropdown, no picker. Deploy flavour is inferred from the other fields (`repoUrl`, `source`, `skipInitialClone`) and the user does not see it.

### Execution History

- **FR-040**: A new `script_runs` table MUST record every run with: `id` (PK UUID), `script_id` (plain text — NOT an FK to any manifest-backed table; history survives script removal from the manifest), `server_id` (FK → servers, `ON DELETE SET NULL` — history survives server deletion), `user_id`, `params` (JSONB of the validated params, with secret-marked fields replaced by `"***"` per FR-016), `status` (pending | running | success | failed | cancelled | timeout), `started_at`, `finished_at`, `duration`, `exit_code`, `output_artifact` (JSONB or null — populated from manifest's `outputArtifact.captureFrom` rule), `error_message`, `log_file_path` (same log-file convention as `deployments.log_file_path`).
- **FR-043 (archived-script UI contract)**: When a `script_runs.script_id` is not present in the current manifest (script was deleted in a later release), the UI MUST render the row with an "archived" badge and MUST hide or disable the Re-run action with a tooltip: "Script no longer available in this dashboard version". The run detail view MUST still open and show historic params, status, log tail, and artefact. No cascade-delete of history rows, no tombstone entries in the manifest — the mismatch is resolved read-side in the UI only.
- **FR-041**: The existing `deployments` table MUST stay. Deploy runs are BOTH a `deployments` row (for the app-centric deploy history view) AND a `script_runs` row (for the ops-centric runs view). A `script_runs.deployment_id` nullable FK links the two when the operation is a deploy, enabling de-duplication in the UI. This dual-write is accepted as the price of backward-compatible history.
- **FR-042**: Rows in `script_runs` MUST be retained for 90 days by default (configurable via env `SCRIPT_RUNS_RETENTION_DAYS`). The prune runs at startup (always) AND on a background `setInterval(24 * 3600 * 1000)` with `.unref()` so long-running dashboard instances don't accumulate unbounded history. The interval cadence is configurable via env `SCRIPT_RUNS_PRUNE_INTERVAL_MS` (default 24h); set to `0` to disable the background timer and rely solely on startup prune. **Log-file ownership scoping** (FR-041 consequence): a `script_runs` row whose `deployment_id IS NOT NULL` does NOT own its log file — the linked `deployments` row is the owner (and has its own retention governed by the existing feature-001 deploy-history policy). The prune MUST delete the DB row in both cases but MUST delete the log file from disk only when `deployment_id IS NULL`. This prevents the Runs-page prune from breaking the Deployments-page UI, which still expects the log to exist.

### Authorisation

- **FR-050**: All runner endpoints MUST require the existing `requireAuth` middleware — v1 is admin-only. The authenticated `userId` MUST be recorded on the `script_runs` row for audit.
- **FR-051**: The manifest entry MAY declare a `dangerLevel: "low" | "medium" | "high"` field (optional). `high` (e.g. `db/restore.sh` — overwrites data) MUST trigger a confirmation dialog on the UI that requires typing the script's `id` to confirm, in addition to the normal Run button. Other levels have no UI gating in v1. **Server-side enforcement is deliberately out-of-scope for v1 — the gate is UX-only, which means a direct API call (`curl -X POST /api/scripts/db/restore/run -d ...`) OR an XSS-injected script in the dashboard's own origin WILL bypass the typing confirmation**. This is documented security debt against an authenticated-admin-only threat model. Mitigation path for v2: a second factor (typed confirmation token in the request body) validated server-side against the manifest's `dangerLevel`; or a per-server "production" flag on `servers` that requires a second admin's co-sign for `dangerLevel: high` runs. Neither ships in v1.

### Observability

- **FR-060**: Every run MUST emit structured log events via the existing `logger`: `{ ctx: "scripts-runner", scriptId, serverId, userId, jobId, status }` at each lifecycle transition (start / success / failed / timeout). No raw `console.log`.
- **FR-061**: Runner errors (SSH failures, timeout kills, manifest validation) MUST surface to the audit trail via `auditMiddleware` — route-level audit is already there; new runner lifecycle events SHOULD appear in `audit_entries` with `target_type: "script_run"`, `target_id: <run-id>`.

## Success Criteria

- **SC-001**: An admin can trigger any of the 10 standard runtime operations (currently: `deploy/{deploy,rollback,env-setup,logs}`, `db/{backup,restore}`, `docker/cleanup`, `monitoring/security-audit`, `server/health-check`, plus any new one added during development) via ≤ 3 clicks from the server detail page. No SSH, no editing config files.
- **SC-002**: Adding a new runtime operation from a fresh `scripts/<category>/<name>.sh` to visible-in-the-UI takes ≤ 2 file changes (the script + one manifest entry) and zero `server/routes/` or `client/pages/` edits.
- **SC-003**: The **Deploy Script** text field is completely removed from the Add / Edit Application forms. Zero applications in production require manual path configuration after migration.
- **SC-004**: 100% of existing deploy flows (manual create → deploy, scan import → deploy, rollback, parallel deploys on different servers, 409 conflict on same server) continue to work after the migration, verified by the existing integration test suite passing unchanged.
- **SC-005**: The migration from `deploy_script` column to auto-dispatch runs against production without manual data fixing: all existing `applications` rows, regardless of what was typed in `deploy_script`, resolve correctly via `resolveDeployOperation(app)`.
- **SC-006**: Script run history is queryable and filterable — an admin can answer "when did we last restore the production DB, who did it, and did it succeed?" from the UI alone in under 30 seconds.
- **SC-007**: The dashboard Docker image grows by ≤ 200 KB (the compressed size of `scripts/` bundled into the image). Build time grows by ≤ 3 seconds.

## Assumptions

- **A-001**: The repo's `scripts/` tree stays the source of truth for operational logic. Scripts are written in bash, idempotent where possible, and use the existing `common.sh` conventions (coloured logging, `set -euo pipefail`, `--yes`/`CI` skip flags).
- **A-002**: Dropping `applications.deploy_script` happens in a single migration (`0005_scripts_runner.sql`) atomic with the feature release. Container swap is atomic, dashboard is single-writer against its own Postgres, no multi-instance rollout concerns. Matches the one-migration-per-feature convention used by features 001–004. **Rollback of the release is a manual ops procedure, not a one-click revert**: (a) the operator takes a pg_dump of `applications` BEFORE applying migration 0005 (part of the release checklist); (b) if rollback is needed, the operator applies the DOWN migration `ALTER TABLE applications ADD COLUMN deploy_script TEXT` (column added as nullable); (c) the operator runs a one-off SQL from the pre-release dump to restore `deploy_script` values keyed by `applications.id`. Without step (c), the old code would read `deploy_script = NULL` and fail at the `buildDeployCommand` classic-mode invocation (`command: ${remotePath}/${deployScript}` becomes `${remotePath}/undefined`). The release checklist MUST include "confirm dashboard pg_dump of `applications` stored in ops vault" as a pre-merge gate. The two-migration-nullable-first pattern was evaluated (spec Clarifications Q5) and rejected on the grounds of container-atomic swap; the explicit pre-release dump is the compensating control.
- **A-003**: Script parameters are declared via Zod schemas (consistent with the existing request-validation pattern in `server/middleware/validate.ts` and all existing routes). UI form generation is straightforward for the subset of Zod types listed in FR-031; `z.object()` nesting and `z.array()` of objects are out of scope for v1 UI (scripts are kept flat).
- **A-004**: v1 is admin-only. All dashboard users today are admin, and the existing auth middleware enforces that. RBAC / per-role visibility of scripts is out of scope.
- **A-005**: The auto-dispatch rules in FR-020 cover 100% of existing applications in the production DB. If any application exists whose current `deploy_script` value is NOT one of `{ "deploy.sh", "./deploy.sh", "<path>/deploy.sh", docker-compose-mode }`, it MUST be surfaced during migration planning (not migration execution) — the migration script emits a warning list and blocks until an admin reviews. This is pre-migration validation, not runtime fallback.
- **A-006**: Script log files follow the existing convention (`/app/data/logs/<job-id>.log`). No change to the log storage format, rotation, or transport — this feature reuses the existing pipeline.

## Out of Scope

- **Cron / scheduled operations** — admins can trigger operations on demand in v1; scheduled runs (nightly backups, periodic audits) are a follow-up spec. The table/runner design leaves room for this without reshaping, but no scheduler is shipped here.
- **RBAC / per-user permissions** — v1 is admin-only. Role-gated visibility of scripts (e.g. "junior devs can see monitoring but not db/restore") is a separate concern for when the user model grows beyond "admin / not admin".
- **UI-side script editor** — scripts are committed to the repo via normal git flow. There is no in-dashboard bash editor, no live-edit of script content, no upload. A script that needs to change goes through a PR like any other code.
- **Per-application custom scripts** — if an application has bespoke operational needs, the path is "add a script to `scripts/<category>/` covering the need, add a manifest entry, PR". There is no per-app script override in the DB.
- **Bootstrap / new-server setup flow** — `scripts/server/{setup-vps,setup-ssl}.sh` run against hosts that aren't yet in the `servers` table. This flow requires a different input mechanism (raw SSH credentials / key upload / IP input) and is deferred to a dedicated "Add Server Wizard" spec.
- **Local-only scripts (`scripts/dev/*`)** — excluded from the manifest. These are developer-laptop utilities, not runtime operations.
- **Log aggregation / search across runs** — basic tail + live stream per run in v1. Multi-run search (grep across last 30 backups) is a follow-up.
- **Cancellation mid-run** — v1 does NOT expose a Cancel button for arbitrary script runs. Deploy runs keep their existing cancel path (from feature 001) because it's already tested and in the UI. Other operations run to completion or timeout; kill-the-SSH-channel semantics for mid-run cancellation is deferred.
- **Multi-server fan-out** — v1 runs an operation against exactly ONE server per run. "Run `docker/cleanup.sh` on all servers in one click" is a convenience wrapper for v2.
- **Rollout orchestration** — v1 has no blue-green / canary / staged-rollout logic built on top of the runner. Scripts are one-shot.

## Edge Cases

- **EC-001**: An admin runs `db/backup.sh` on `srv-1` while a deploy is running on `srv-1`. If `db/backup.sh`'s manifest entry declares `requiresLock: true`, the runner returns `409 DEPLOYMENT_LOCKED` (same shape as feature 004's deploy conflict). If `requiresLock: false` (default), the backup runs concurrently — this is the correct behaviour because backups are read-only against the app's data; the manifest author declares this explicitly.
- **EC-002**: A manifest entry references a script file that doesn't exist on disk (e.g. someone renamed a script but forgot to update the manifest). Startup validation (FR-003) catches this and the dashboard fails to boot with a pointing error. No soft-fail.
- **EC-003**: A script writes to stdout in a way that exceeds the job manager's buffer (hundreds of MB). The existing deploy path already handles this via streaming; this feature inherits that behaviour unchanged.
- **EC-004**: Two admins click Run on `db/backup.sh` for `srv-1` within the same second. Both runs start (no global backup lock unless the manifest declares one). If the script itself is not safe for concurrent execution (e.g. `db/restore.sh` would conflict), the manifest entry MUST declare `requiresLock: true` — it's the manifest author's job to model the concurrency contract. This is a deliberate trade-off: the runner does not guess.
- **EC-005**: A script fails on a server that is network-partitioned mid-run. SSH times out, the runner marks the run as `failed` with the partial log captured up to the partition. The target server's state is whatever the script was doing when SSH disconnected (bash processes continue on the remote host even after SSH dies, unless the script traps SIGPIPE — this is a well-known Unix property and is not this feature's problem to solve).
- **EC-006**: A script's parameter schema changes (a new required param added). Old rows in `script_runs` still have the old `params` JSONB — they're not re-validated on display. The UI shows the old params as-is. Re-run from an old row is NOT a "replay with same params" operation — it opens the current Run dialog pre-filled with what still maps to the new schema; fields added since run time are blank and must be entered. This is acceptable because `script_runs` is history, not re-runnable state.
- **EC-008**: A script is removed from the manifest in a later release. Existing `script_runs` rows with that `script_id` remain intact forever (subject to FR-042 retention only). The UI flags them as archived per FR-043, keeps detail-view functional, and hides Re-run.
- **EC-007**: The dashboard is rolled back to an earlier version with a different `scripts/` bundle than what produced an in-flight script run. The in-flight run completes against the OLD scripts (because the bash file is in the OLD container). The NEW script_runs after rollback use the NEW scripts. No correctness issue — the container's script files are the version-of-truth, and each run is pinned to the container instance that started it.

## Dependencies

- **Feature 001** (devops-app): Provides the baseline auth, routes, job manager, WebSocket log streaming, Drizzle schema, and the existing `applications` / `deployments` tables that this feature builds on.
- **Feature 003** (scan-for-repos): Provides the `source` and `skipInitialClone` fields on `applications` that feed into the auto-dispatch logic.
- **Feature 004** (db-deploy-lock): Provides the `deployLocks` table and `DeployLock` service that the runner delegates to for entries with `requiresLock: true`. The two features must be merged in order: 004 first, then 005.
- **`scripts/common.sh`** (repo root): Provides the logging conventions (`log`, `warn`, `error`, `step`) that every script under this feature's manifest is expected to use. No changes to `common.sh` are made by this feature.

## Glossary

- **Manifest** — The typed list of runnable operations (`devops-app/server/scripts-manifest.ts`). Authoritative source for what the runner can execute.
- **Locus** — Where a script runs: `target` (on a managed server via SSH), `local` (in the dashboard process), `bootstrap` (on a not-yet-managed host). v1 UI exposes only `target`.
- **Operation** / **Script** — Used interchangeably. A manifest entry. The runnable unit.
- **Run** — A single execution of an operation against one server. Corresponds to one `script_runs` row and one `jobManager` job.
- **Auto-dispatch** — The deploy-specific logic that picks which script to run for a given application without asking the admin. Encoded in `resolveDeployOperation(app) → { scriptId, paramOverrides }`.
- **Flavour** — The category of application (`classic-git` / `scan-git` / `scan-docker`). Derived from `source` + `repoUrl` + `skipInitialClone`. Inputs to `resolveDeployOperation`.
