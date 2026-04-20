# Tasks: Scan Server for Existing Repositories and Docker Apps

**Input**: Design documents from `/specs/003-scan-for-repos/`
**Prerequisites**: plan.md (v1.0), spec.md (v1.0), research.md, data-model.md, contracts/api.md, quickstart.md

**Tests**: Yes — unit tests for output parser and dedup logic, integration tests for the scan route with a mocked `sshPool`.

**Organization**: Tasks grouped by setup + foundation + user stories (US1–US5 from spec.md). Each task is assigned to a specialist agent.

## Format: `[ID] [AGENT] [Story?] Description`

## Agent Tags

| Tag | Agent | Domain |
|-----|-------|--------|
| `[SETUP]` | — (orchestrator) | Shared schema changes, mount points |
| `[DB]` | database-architect | Schema, migrations |
| `[BE]` | backend-specialist | Express routes, services |
| `[FE]` | frontend-specialist | React pages, components, hooks |
| `[E2E]` | test-engineer | Cross-boundary integration tests |
| `[SEC]` | security-auditor | Command-injection audit of scanner |

## Task Statuses

| Status | Meaning |
|--------|---------|
| `- [ ]` | Pending |
| `- [→]` | In progress |
| `- [X]` | Completed |
| `- [!]` | Failed |
| `- [~]` | Blocked |

## Path Conventions

All paths relative to `devops-app/` (the application root).

---

## Phase 1: Setup

**Purpose**: Shared schema extensions and migration — both user stories depend on this.

- [ ] T001 [SETUP] Extend `server/db/schema.ts` with new columns per data-model.md: on `servers` add `scanRoots: jsonb("scan_roots").notNull().default(sql\`'["/opt","/srv","/var/www","/home"]'::jsonb\`)`; on `applications` add `skipInitialClone: boolean("skip_initial_clone").notNull().default(false)`. This is a single shared edit — both DB and BE tasks read from this file afterwards.
- [ ] T002 [DB] Create migration `server/db/migrations/0003_scan.sql` with parameterized DDL: `ALTER TABLE servers ADD COLUMN scan_roots JSONB NOT NULL DEFAULT '["/opt","/srv","/var/www","/home"]'::jsonb;` and `ALTER TABLE applications ADD COLUMN skip_initial_clone BOOLEAN NOT NULL DEFAULT FALSE;`. Update `meta/_journal.json` with `idx: 3` entry. Verify with `npm --prefix devops-app run db:check` before committing.

**Checkpoint**: Schema extended, migration file ready for review (not yet applied to prod — admin applies manually per CLAUDE.md rule 5).

---

## Phase 2: Foundational (Scanner Service)

**Purpose**: Scanner service + route + shared helpers — required by ALL user stories. No UI yet.

- [ ] T003 [BE] Create shell command builder in `server/services/scanner-command.ts` with typed inputs/outputs: pure function `buildScanCommand(scanRoots: string[]): string` returning a single-line `bash -c` pipeline. **Wrap the entire pipeline in `timeout --kill-after=5s 60 bash -c '<pipeline>'`** (FR-062 primary defence — survives SSH channel kill). Use `find -P -xdev -maxdepth 6` (FR-005 — no symlink following, no FS crossing). Single-quote every path with `'\''` escape. Reject any root with shell metacharacters. Assert `scanRoots.length <= 20`. **FR-022**: every per-candidate git command wrapped `timeout 3s git -c safe.directory='*' -C "$worktree" ... 2>/dev/null || echo "GIT_ERROR\t$worktree\t<field>"` — one hung repo cannot block the stream, ownership oddities (`dubious ownership`) do not error out, failures emit a maker line the parser folds into candidate state. **Detached HEAD**: when `git rev-parse --abbrev-ref HEAD` returns the literal `HEAD`, emit `GIT_BRANCH\t<path>\tDETACHED` instead. **FR-031 one-per-dir**: group compose files by parent directory; emit exactly one `COMPOSE\t<primary>\t<extras-csv>` line per directory where primary is chosen by priority `compose.yaml` > `docker-compose.yml` > `compose.yml` > `docker-compose.yaml`. **FR-032 services**: run `docker compose -f <primary> [-f <extra> ...] config --format json 2>/dev/null` once per directory and emit `COMPOSE_CONFIG\t<primary>\t<base64-json>` (base64 to stay tab-safe). Delegates YAML parsing to docker-CLI — no fragile awk/grep. When docker unavailable, emit `COMPOSE` without `COMPOSE_CONFIG`; parser tolerates absence. Export for unit testing.
- [ ] T004 [BE] Create output parser in `server/services/scanner-parser.ts` with typed inputs/outputs: pure function `parseScanOutput(stdout: string): ParsedScan` that splits on `\n`, splits each line on `\t`, dispatches by tag (`TOOL`, `GIT_BRANCH`, `GIT_SHA`, `GIT_REMOTE`, `GIT_DIRTY`, `GIT_HEAD`, `GIT_ERROR`, `COMPOSE`, `COMPOSE_CONFIG`, `CONTAINER`). **Tri-state dirty** (FR-021): `clean` when no `GIT_DIRTY` line emitted for a path, `dirty` when emitted, `unknown` when a `GIT_ERROR` for the `status` field is seen or the line is missing due to truncation. **Detached HEAD**: `GIT_BRANCH\t<path>\tDETACHED` sets `detached: true`, `branch` stays as the last known refname or `""`. **Compose candidates**: each `COMPOSE\t<primary>\t<extras-csv>` line creates one candidate; the paired `COMPOSE_CONFIG` (if any) base64-decodes to JSON, validated via Zod, extracts `services` map into `{ name, image, running }` (running filled by orchestrator from `CONTAINER` lines). Candidates without `COMPOSE_CONFIG` get `services: []`. Tolerant of truncated lines. No `as any`.
- [ ] T005 [BE] Create GitHub URL normaliser in `server/services/scanner-github.ts` with typed inputs/outputs: function `githubRepoFromUrl(url: string | null): string | null` handling `https://github.com/owner/repo(.git)?`, `git@github.com:owner/repo(.git)?`, `ssh://git@github.com/owner/repo(.git)?`. Returns `null` for any non-GitHub URL.
- [ ] T006 [BE] Create dedup helper in `server/services/scanner-dedup.ts` with typed inputs/outputs: function `markAlreadyImported(candidates, existingApps): candidates` — parameterized lookup by `normalisePath(remotePath)`, `repoUrl`, and normalisePath(compose-dir). **Export `normalisePath(p: string): string`** implementing `p.replace(/\/{2,}/g,"/").replace(/\/+$/,"") || "/"` per data-model.md. Apply normalisation to BOTH sides (candidate paths AND existingApps.remotePath) before comparison — catches trailing-slash mismatches. Returns new arrays, does not mutate inputs.
- [ ] T007 [BE] Implement scanner orchestration in `server/services/scanner.ts` with typed inputs/outputs: `scan(serverId, scanRoots, userId, opts?): Promise<ScanResult>`. **Per-server concurrency lock (FR-074)**: module-scoped `Map<serverId, { since: Date, userId: string, abort: () => void }>`. Entry set at scan start, deleted in `finally` (success, timeout, abort, error). If entry already exists → throw typed `ScanInProgressError({ since, byUserId })` which the route maps to 409. Uses `sshPool.execStream()` to run the command from T003, accumulates stdout, wires 60 s Node-side timeout via `setTimeout` that calls `kill()` and resolves with `partial: true` (server-side `timeout 60` is the primary bound; Node-side is secondary liveness). Reads existing applications via Drizzle (`db.select().from(applications).where(eq(applications.serverId, serverId))` — parameterized query) and calls T006 to mark `alreadyImported`. Returns `{ gitCandidates, dockerCandidates, gitAvailable, dockerAvailable, partial, durationMs }`.
- [ ] T008 [BE] Implement scan route in `server/routes/scan.ts` with Zod validation and structured error handling: `POST /api/servers/:serverId/scan`. Validate `serverId` path param (Zod). `authRequired` + admin role check. Load server config from DB (parameterized query by id) — `scanRoots` taken from server row. Call `sshPool.connect()` (idempotent). Wire `req.on("close")` → capture stream handle and call `kill()` on abort. On `ScanInProgressError` (FR-074) → 409 `SCAN_IN_PROGRESS` with `{ since, byUserId }` payload. On SSH unreachable → 503 `SSH_UNREACHABLE`. On success → 200 with ScanResult. Use AppError helpers, never bare `throw new Error()`.
- [ ] T009 [BE] Extend `createServerSchema` and `updateServerSchema` in `server/routes/servers.ts` with Zod validation for `scanRoots`: `z.array(z.string().regex(/^\//).max(512).refine(s => !/["'\`;&|<>()\\\n]/.test(s))).max(20).optional()`. On server create/update, if `scriptsPath` is set and not already in `scanRoots`, append it (dedup, preserve user order). **FR-073 (NFS guard)**: after syntactic validation, for each root probe the remote filesystem type via `stat -f -c %T <quoted-root>` over SSH. Reject with **400 `NON_LOCAL_FS`** if type in `{"nfs","nfs4","cifs","smbfs","fuse.sshfs"}`. Probe runs within a 2s per-root timeout; if the probe itself hangs, the root is rejected defensively with the same error. Persist accepted `scanRoots` via parameterized Drizzle update.
- [ ] T010 [BE] Extend `createAppSchema` in `server/routes/apps.ts` with Zod validation: add `source: z.enum(["manual","scan"]).optional().default("manual")` and (optional) `skipInitialClone: z.boolean().optional()`. When `source === "scan"`, backend forcibly sets `skipInitialClone: true` regardless of the payload. When `source === "manual"`, ignore any `skipInitialClone` from body (prevents clients from forging the flag). **Path normalisation**: `remotePath` passes through a Zod `.transform(normalisePath)` (imported from `server/services/scanner-dedup.ts`) — applies to both manual and scan imports, closes FR-040 dedup gap at the write path. Include parameterized insert via Drizzle.
- [ ] T011 [BE] Wire scan route into `server/index.ts`: import and register `scanRouter` at `/api`.
- [ ] T012 [BE] Write unit tests in `tests/unit/scanner-command.test.ts` covering: escaping of single quotes in paths, rejection of shell metacharacters, rejection when `scanRoots.length > 20`, stable output for known root lists (golden file). **Assertions on emitted pipeline**: outer wrapper is `timeout --kill-after=5s 60 bash -c '...'` (FR-062), `find` invocation contains `-P -xdev -maxdepth 6` (FR-005), every `git -C` call is preceded by `timeout 3s` AND contains `-c safe.directory='*'` (FR-021/022), compose dedup-by-dir (FR-031) produces one `COMPOSE` line per directory with extras CSV-joined, `docker compose -f ... config --format json` invocation gated on docker availability (FR-032). No network/SSH.
- [ ] T013 [BE] Write unit tests in `tests/unit/scanner-parser.test.ts` covering: well-formed output parsing, truncated stdout handling (partial line in middle), missing `TOOL` line, CRLF vs LF, empty lines. **Tri-state dirty**: fixtures with `GIT_DIRTY` present → `"dirty"`, absent → `"clean"`, `GIT_ERROR` for status → `"unknown"`. **Detached HEAD**: `GIT_BRANCH\t<p>\tDETACHED` sets `detached: true`. **Compose**: fixtures with `COMPOSE_CONFIG` lines carrying base64 `docker compose config --format json` payloads — assert services parsed via Zod, attached to matching `COMPOSE` candidate, extras CSV split into `extraComposeFiles[]`, and a compose candidate without `COMPOSE_CONFIG` still returns `services: []`.
- [ ] T014 [BE] Write unit tests in `tests/unit/scanner-dedup.test.ts` covering: path match, repoUrl match, compose-dir match, no false positives across servers. **Path normalisation**: `/opt/app` vs `/opt/app/` must dedup to same, `/opt//app` vs `/opt/app` must dedup, `/` edge case (normalisePath returns `/`). Unit-test `normalisePath` directly with edge cases incl. empty string, `"//"`, `"/a/b/"`, `"///a///b///"`.
- [ ] T015 [BE] Write integration tests in `tests/integration/scan-route.test.ts` with mocked `sshPool`: happy path (git+docker), partial timeout, SSH unreachable (503), non-admin (403), client abort triggers `kill()`. **New cases**: second concurrent call returns 409 `SCAN_IN_PROGRESS` with `{ since, byUserId }` while first holds lock; lock released after timeout/abort/error (verified by third call succeeding); server edit with NFS root returns 400 `NON_LOCAL_FS` (mocked `stat -f` returns `nfs4`); detached-HEAD fixture surfaces `detached: true` and `GitCandidateRow`-consuming test asserts Import disabled state. Lock release verified via `describe` teardown that the module-level Map is empty after each test.

**Checkpoint**: Scan endpoint operational end-to-end with a real or mocked SSH server; no UI yet.

---

## Phase 3: User Story 1 — Scan a Server for Candidates (Priority: P1)

**Goal**: Admin opens Apps tab, clicks Scan Server, sees two grouped candidate lists.

**Independent Test**: On a registered server with a known `/opt/demo/.git` and a running docker container, clicking Scan Server returns both candidates within 15 s and renders them in the modal.

- [ ] T016 [FE] [US1] Create `client/hooks/useScan.ts`: react-query mutation wrapping `POST /api/servers/:id/scan` with `AbortController`. Exposes `{ mutate, abort, data, isPending, error }`. Types imported from shared types file.
- [ ] T017 [FE] [US1] Create `client/components/scan/ScanModal.tsx`: dialog with progress spinner, **Cancel** button (calls `abort()` from T016), two grouped result lists (git + docker) or error state. Renders `partial: true` banner when set. Accessible (Escape closes, focus trap).
- [ ] T018 [FE] [US1] Create `client/components/scan/GitCandidateRow.tsx`: renders one git candidate with path, branch, short SHA, commit subject, **Already added** state (disabled + link to existing app), **Import** button. **Badges** (per data-model.md): yellow "Dirty" when `dirty === "dirty"`, grey "Status unknown" when `dirty === "unknown"`, red "Detached HEAD" when `detached === true`. Import button **disabled** when `detached === true` with tooltip "Check out a branch on server first". Null `commitSha`/`commitSubject`/`commitDate` render as em-dash. No `dangerouslySetInnerHTML`.
- [ ] T019 [FE] [US1] Create `client/components/scan/DockerCandidateRow.tsx`: renders one docker candidate (compose with services list + extra compose files in an expandable "merged from" row, or standalone container with image), **Already added** state, **Import** button. When `services` is empty (docker unavailable on server), show "Services unknown — docker not available on host" hint.
- [ ] T020 [FE] [US1] Wire Scan Server button into `client/pages/ServerPage.tsx`: button next to "Add Application", disabled when server status !== "online" **or** when a scan is locally known to be in-flight (optimistic UI lock mirroring FR-074). On 409 `SCAN_IN_PROGRESS` response, show an inline message with `since` + `byUserId` and auto-enable the button. Reuse existing react-query invalidation patterns after import.

**Checkpoint**: US1 complete — admin can run a scan and browse results; Import button present but not yet functional.

---

## Phase 4: User Story 2 — Import a Git Repository Candidate (Priority: P1)

**Goal**: Clicking Import on a git candidate pre-populates Add Application form; saving creates an app with `skipInitialClone = true` and no re-clone on first deploy.

**Independent Test**: Import a scan-detected git repo; verify DB row has `skipInitialClone = true`, `repoUrl` matches origin, `branch` matches HEAD; trigger deploy; verify deploy log shows `git fetch` + `git reset --hard`, not `git clone`.

- [ ] T021 [FE] [US2] Refactor existing Add Application form into a controllable component in `client/components/apps/AddAppForm.tsx` (extracted from `client/pages/ServerPage.tsx`): accept `initialValues` and `source` props, forward `source` to POST body. No behaviour change for the manual-add flow.
- [ ] T022 [FE] [US2] Wire GitCandidateRow's Import button (from T018) to open AddAppForm pre-populated: `name` = `basename(path)`, `repoUrl` = `remoteUrl`, `branch` = `branch`, `remotePath` = `path`, `githubRepo` = `githubRepo`, `currentCommit` = `commitSha`, `source: "scan"`. Deploy script field gets a suggestion dropdown from `suggestedDeployScripts`.
- [ ] T023 [BE] [US2] Extend deploy runner in `server/services/script-runner.ts` (or wherever the clone/fetch dispatch lives): when `application.skipInitialClone === true`, replace `git clone` branch with `git fetch origin <branch> && git reset --hard FETCH_HEAD`. `FETCH_HEAD` is used instead of `<branch>`/`origin/<branch>` + explicit `git checkout` because the latter can fail on local divergence, detached HEAD, or untracked pollution — the scan-imported working tree is deliberately "nuke and sync" on deploy. Validate branch name with strict regex (`^[A-Za-z0-9._/-]+$`, length ≤ 200) before interpolating into shell — prevents command injection via branch names. No `as any`.
- [ ] T024 [E2E] [US2] Integration test `tests/integration/scan-import-git.test.ts`: seed a real tmp git repo on a test SSH host (or dockerised sshd), run scan, import one candidate, verify resulting application row and that a subsequent deploy uses fetch+reset (assert on log file contents).

**Checkpoint**: US2 complete — brownfield git apps importable without re-clone.

---

## Phase 5: User Story 3 — Import a Docker Container or Compose Stack (Priority: P2)

**Goal**: Clicking Import on a Docker candidate pre-populates the form with Docker-appropriate defaults and a `docker://` sentinel in `repoUrl`.

**Independent Test**: Import a compose candidate; verify resulting app has `repoUrl = docker://<compose-path>`, `branch = "-"`, `skipInitialClone = true`; trigger a deploy using the suggested compose command; verify no git operations run.

- [ ] T025 [FE] [US3] Extend AddAppForm (T021) to render a **Docker app** badge when `initialValues.repoUrl` starts with `docker://`; hide branch input for Docker-only mode, show a default `branch = "-"` hidden value. Still posts via the same endpoint.
- [ ] T026 [FE] [US3] Wire DockerCandidateRow's Import button (from T019) to open AddAppForm: for `kind: "compose"` — `name` = compose project, `repoUrl` = `docker://<path>`, `remotePath` = `dirname(path)`, `deployScript` suggestion `docker compose pull && docker compose up -d`; for `kind: "container"` — `name` = container name, `repoUrl` = `docker://<name>`, `remotePath` empty, admin fills in.
- [ ] T027 [BE] [US3] Extend deploy runner (T023) with `docker://` branch: when `application.repoUrl` starts with `docker://`, skip ALL git operations; run the configured `deployScript` directly in `remotePath`. No SHA validation needed on this branch (no commit concept). Update deploy log to mark `mode: "docker"`.
- [ ] T028 [E2E] [US3] Integration test `tests/integration/scan-import-docker.test.ts`: seed a test compose file on a test SSH host, scan, import, save, trigger deploy, assert deploy log contains no `git clone`/`git fetch` and shows the compose command.

**Checkpoint**: US3 complete — Docker-only apps importable and deployable through the normal pipeline.

---

## Phase 6: User Story 4 — Re-scan After Adding a New App (Priority: P2)

**Goal**: Running Scan Server again after changes on the server surfaces new candidates; previously imported ones stay disabled.

**Independent Test**: Scan once, import candidate A; scan again; confirm A is shown **Already added** and disabled, and any new candidate B is importable.

- [ ] T029 [FE] [US4] In ScanModal (T017), add a **Re-scan** button visible after results render; wire it to re-trigger the mutation from T016 (which already uses a fresh AbortController per call).
- [ ] T030 [E2E] [US4] Integration test `tests/integration/scan-rescan.test.ts`: perform two scans with an import between them, assert `alreadyImported` flips for the imported candidate on the second scan and new candidates appear.

**Checkpoint**: US4 complete — dedup across sessions verified.

---

## Phase 7: User Story 5 — Cancel a Long Scan (Priority: P3)

**Goal**: Admin can cancel an in-flight scan; no orphan processes remain on the server.

**Independent Test**: Start a scan on a deliberately slow server config (very large `scanRoots`), click Cancel within a few seconds, assert modal closes with `cancelled` state and `ps aux | grep <scan-pid>` on the server returns empty after 5 s.

- [ ] T031 [FE] [US5] ScanModal's Cancel button (from T017) — verify it calls `controller.abort()` and shows a **Cancelled** state (no error toast). Add a brief e2e test in `client/components/scan/__tests__/ScanModal.test.tsx` with a mocked fetch that never resolves; confirm abort path.
- [ ] T032 [E2E] [US5] Integration test `tests/integration/scan-cancel.test.ts`: start scan, abort within 1 s, assert backend received `req.on("close")` and called `kill()`; assert no orphan processes via `ps` snapshot before/after. Verifies SC-003.

**Checkpoint**: US5 complete — cancellation contract holds end-to-end.

---

## Phase 8: Polish & Cross-Cutting Concerns

**Purpose**: Security review, audit logging, quickstart sync — runs only after all user stories are green.

- [ ] T033 [SEC] Security audit of the scanner pipeline: review `scanner-command.ts` escaping, confirm no candidate path is interpolated into shell without single-quote quoting, validate branch regex in T023/T027 against OWASP command-injection patterns, check that `scanRoots` validation (T009) cannot be bypassed via Unicode tricks. Produce a short report in `specs/003-scan-for-repos/security-review.md`.
- [ ] T034 [BE] Add audit log entries in the scan route (T008) and scan-import app creation (T010): `action: "scan"` with `targetType: "server"` and `action: "scan_import"` with `targetType: "application"`. Use existing `auditEntries` table — no schema change.
- [ ] T035 [BE] Add structured logging (via existing logger, not `console.log`) in `scanner.ts`: log scan start/finish with `{ serverId, durationMs, candidateCounts, partial }`. No paths in logs (may contain sensitive project names) — counts only.
- [ ] T036 [FE] Add the **Edit Scan Roots** UI to the server edit form: list of absolute paths with add/remove and inline validation matching T009 rules. Show defaults as placeholders when empty.
- [ ] T037 [BE] Update `quickstart.md` section "Verifying the no-clone guarantee" with the final deploy log format from T023, if it drifted during implementation.
- [ ] T038 [E2E] **SC-002 performance benchmark** in `tests/integration/scan-perf.test.ts`: synthesise 200 empty `.git` directories plus 10 compose files under a tmp root on a test SSH host (reuse the dockerised sshd from T024), run `scan()`, assert `durationMs < 15000` and `partial === false`. Reports the measured duration in the test output for regression tracking. Skipped in fast unit-test runs via `describe.skip` gated by `process.env.PERF === "1"` to keep CI-default runtime low.

**Checkpoint**: Feature ready for `/speckit.analyze`.

---

## Dependency Graph

```
# Phase 1 (Setup)
T001 → T002, T003, T009, T010

# Phase 2 (Foundational — services build on command+parser+dedup+github)
T003 → T007
T004 → T007
T005 → T007
T006 → T007
T007 → T008
T001 → T009
T001 → T010
T008 + T009 + T010 → T011
T003 → T012
T004 → T013
T006 → T014
T008 → T015

# Phase 3 (US1 — UI consumes the route)
T011 → T016
T016 → T017
T017 → T018, T019
T018 + T019 → T020

# Phase 4 (US2 — Import git)
T020 → T021
T021 → T022
T010 → T023
T022 + T023 → T024

# Phase 5 (US3 — Import docker)
T021 → T025
T025 → T026
T023 → T027
T026 + T027 → T028

# Phase 6 (US4 — Re-scan)
T017 → T029
T020 → T030

# Phase 7 (US5 — Cancel)
T017 → T031
T008 → T032

# Phase 8 (Polish — depends on all user stories)
T008 + T023 + T027 → T033
T008 + T010 → T034
T007 → T035
T020 → T036
T024 → T037
T007 + T024 → T038
```

### Self-validation (must pass)

- [X] Every task ID referenced in Dependencies exists in the task list (T001–T038).
- [X] No circular dependencies (graph is a DAG — traversable in topological order from T001).
- [X] No orphan references (no ID appears in Dependencies that is not defined above).
- [X] Fan-in uses `+` only (e.g. `T008 + T009 + T010 → T011`), fan-out uses `,` only (e.g. `T017 → T018, T019`).
- [X] No chained arrows on a single line.

---

## Parallel Lanes

Each lane is a sequential chain assignable to one agent. Lanes run in parallel subject to the graph.

| Lane | Agent | Tasks | Starts after |
|---|---|---|---|
| L1 — Schema | [DB]/[SETUP] | T001 → T002 | — |
| L2 — Scanner core | [BE] | T003, T004, T005, T006 (parallel within lane) → T007 → T008 → T011 | T001 |
| L3 — Schema extensions | [BE] | T009, T010 | T001 |
| L4 — Scanner tests | [BE] | T012, T013, T014 (parallel) | T003/T004/T006 respectively |
| L5 — Route integration test | [BE] | T015 | T008 |
| L6 — UI modal | [FE] | T016 → T017 → (T018 ∥ T019) → T020 | T011 |
| L7 — Import git | [FE]+[BE] | T021 → T022; T023 (parallel); T024 | T020 / T010 |
| L8 — Import docker | [FE]+[BE] | T025 → T026; T027; T028 | T021 / T023 |
| L9 — Re-scan | [FE]+[E2E] | T029; T030 | T017 / T020 |
| L10 — Cancel | [FE]+[E2E] | T031; T032 | T017 / T008 |
| L11 — Polish | mixed | T033, T034, T035, T036, T037, T038 (parallel) | all US phases |

---

## Agent Summary

| Agent | Tasks | Start condition |
|---|---|---|
| `[SETUP]` | T001 | — |
| `[DB]` | T002 | after T001 |
| `[BE]` | T003, T004, T005, T006, T007, T008, T009, T010, T011, T012, T013, T014, T015, T023, T027, T034, T035 | after T001 |
| `[FE]` | T016, T017, T018, T019, T020, T021, T022, T025, T026, T029, T031, T036 | after T011 (for scan UI) / after T020 (for import UI) |
| `[E2E]` | T024, T028, T030, T032, T038 | after its story's FE+BE tasks |
| `[SEC]` | T033 | after T008, T023, T027 |

Total: **38 tasks**.

---

## Critical Path

The longest dependency chain (blocks shipping US2, the key MVP):

```
T001 → T003 → T007 → T008 → T011 → T016 → T017 → T018 → T020 → T021 → T022 → T024
```

12 tasks. Everything else parallelises around it.

---

## Implementation Strategy

### MVP scope

**Phases 1 → 2 → 3 → 4** ship the core promise of the feature: scan a server and import a git candidate without re-cloning. That's US1 + US2 and covers 90% of the real-world use case. Ship this first, get feedback, then layer US3 (Docker) and US5 (Cancel) on top.

Docker support (US3) and cancellation (US5) are genuinely optional — the dashboard already works without them and no existing flow breaks if they ship later.

### Incremental delivery

1. **Day-1 cut**: T001 → T011 (backend only). Can curl the endpoint, no UI. Validates the entire scanner pipeline against a real server.
2. **MVP cut**: + T016 → T024. Usable feature for git apps.
3. **Feature-complete cut**: + US3 + US4 + US5 + Polish.

### Parallel agent strategy

- **After T001 lands** (single setup edit), L2/L3/L4 can fork immediately. Schema change is the only real sync barrier.
- **After T011 lands** (scan endpoint wired), FE (L6) starts in parallel with the BE test lane (L5). UI does not block on tests.
- **After T017 lands** (modal skeleton), L9 (re-scan) and L10 (cancel) fork off — they only need the modal component, not the full import flow.
- **[SEC] audit (T033)** and **audit logging (T034)** intentionally run last — they need the final shape of the route and the deploy runner to avoid churn.
