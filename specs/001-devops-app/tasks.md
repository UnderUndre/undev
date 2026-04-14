# Tasks: DevOps Dashboard

**Input**: Design documents from `/specs/001-devops-app/`
**Prerequisites**: plan.md (v1.2), spec.md (v1.2), research.md, data-model.md, contracts/api.md, contracts/ws.md, quickstart.md

**Tests**: Yes — each user story includes integration tests. E2E tests in final phase.

**Organization**: Tasks grouped by user story (US1–US8 from spec.md). Each task assigned to a specialist agent.

## Format: `[ID] [AGENT] [Story?] Description`

## Agent Tags

| Tag | Agent | Domain |
|-----|-------|--------|
| `[SETUP]` | — (orchestrator) | Project init, shared config, scaffolding |
| `[DB]` | database-architect | Schema, migrations, seeds |
| `[BE]` | backend-specialist | Express routes, services, SSH, WebSocket |
| `[FE]` | frontend-specialist | React pages, components, hooks |
| `[E2E]` | test-engineer | Cross-boundary integration tests |

## Task Statuses

| Status | Meaning |
|--------|---------|
| `- [ ]` | Pending |
| `- [→]` | In progress |
| `- [X]` | Completed |
| `- [!]` | Failed |
| `- [~]` | Blocked |

## Path Conventions

All paths relative to `devops-app/` (the application root within this repo).

---

## Phase 1: Setup

**Purpose**: Project scaffolding, dependencies, Docker setup

- [ ] T001 [SETUP] Create project directory structure per plan.md: `server/`, `server/db/`, `server/routes/`, `server/services/`, `server/ws/`, `server/middleware/`, `client/`, `client/pages/`, `client/components/`, `client/hooks/`, `client/lib/`, `data/`
- [ ] T002 [SETUP] Initialize `package.json` with name `devops-dashboard`, ESM type, scripts (dev, build, start, test, validate, lint, lint:fix, format, format:check, typecheck, validate:fix). Install dependencies: `express`, `ws`, `ssh2`, `postgres`, `drizzle-orm`, `bcrypt`, `zod`, `uuid`, `cors`; devDependencies: `typescript`, `@types/node`, `@types/express`, `@types/ws`, `@types/bcrypt`, `@types/cors`, `@types/uuid`, `drizzle-kit`, `vite`, `@vitejs/plugin-react`, `react`, `react-dom`, `react-router-dom`, `@tanstack/react-query`, `tailwindcss`, `vitest`, `tsx`, `concurrently`
- [ ] T003 [SETUP] Configure `tsconfig.json` (strict, ESM, NodeNext), `vite.config.ts` (React plugin, proxy /api and /ws to Express), `drizzle.config.ts` (PostgreSQL driver, DATABASE_URL from env), `tailwind.config.ts`, `.env.example`
- [ ] T004 [SETUP] Create `Dockerfile` (multi-stage: build client with Vite, build server with tsc, run with node) and `docker-compose.yml` with two services: `db` (postgres:16-alpine with healthcheck) + `dashboard` (app, depends_on db healthy, volume mounts for logs + SSH keys)
- [ ] T005 [SETUP] Create `server/index.ts` entry point: Express + WebSocket upgrade handler, static file serving for client build, PostgreSQL connection via `postgres` driver, zombie deploy triage on startup (force-fail all `running` deployments)

**Checkpoint**: Project scaffolded, `docker compose up` starts empty dashboard

---

## Phase 2: Foundational (Core Services)

**Purpose**: SSH pool, script runner, job manager, auth — required by ALL user stories

- [ ] T006 [DB] Create Drizzle schema in `server/db/schema.ts` using `drizzle-orm/pg-core`: all entities from data-model.md (servers, applications, deployments, backups, healthSnapshots, auditEntries, sessions). Add indexes per data-model.md
- [ ] T007 [DB] Generate initial migration via `drizzle-kit generate` in `server/db/migrations/` and create `server/db/index.ts` (PostgreSQL connection singleton via `postgres` driver, DATABASE_URL from env)
- [ ] T008 [BE] Implement SSH connection pool in `server/services/ssh-pool.ts`: `Map<serverId, ssh2.Client>` with typed inputs/outputs. Methods: `connect(server)`, `exec(serverId, command) → { stdout, stderr, exitCode }`, `execStream(serverId, command) → ReadableStream`, `disconnect(serverId)`, `disconnectAll()`. Auto-reconnect with exponential backoff (1s→2s→4s→8s→30s max). Read SSH key from volume mount path
- [ ] T009 [BE] Implement script runner in `server/services/script-runner.ts` with typed inputs/outputs: wraps ssh-pool for `@underundre/undev` script execution. Methods: `runScript(serverId, scriptPath, args, options) → { jobId }`. Handles `--json` flag parsing (NDJSON line-by-line), falls back to raw text. Streams output to job manager
- [ ] T010 [BE] Implement job manager in `server/services/job-manager.ts` with typed inputs/outputs: async job lifecycle. Methods: `createJob(type, serverId, metadata) → Job`, `getJob(jobId) → Job`, `cancelJob(jobId)`, `onJobEvent(jobId, callback)`. Stores job state in memory (not DB — ephemeral), streams events to WebSocket subscribers. Writes deployment/backup logs to disk files (`/app/data/logs/<jobId>.log`) via `fs.createWriteStream`
- [ ] T011 [BE] Implement WebSocket handler in `server/ws/handler.ts` and `server/ws/channels.ts` per contracts/ws.md: connection auth via session token, channel subscribe/unsubscribe, message routing. Integration with job-manager for job progress streaming
- [ ] T012 [BE] Implement auth middleware in `server/middleware/auth.ts`: session-based auth, bcrypt password verify against `ADMIN_PASSWORD_HASH` env var, session stored in SQLite. Routes: `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`. Cookie: httpOnly, secure, sameSite strict
- [ ] T013 [BE] Implement audit middleware in `server/middleware/audit.ts`: auto-log every mutating request (POST/PUT/DELETE) with user, action type, target, timestamp, result. Write to `auditEntries` table
- [ ] T014 [BE] Implement Zod validation middleware in `server/middleware/validate.ts`: generic `validateBody(schema)` and `validateParams(schema)` middleware factories
- [ ] T015 [BE] Implement Telegram notifier in `server/services/notifier.ts` with typed inputs/outputs: `notify(serverId, event, details)`. Reads `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` from env or per-server config
- [ ] T016 [FE] Set up React app scaffold: `client/main.tsx`, `client/App.tsx` with react-router, Tailwind init, shadcn/ui setup. Create layout components in `client/components/layout/`: Sidebar (servers list), Header (user + logout), MobileNav
- [ ] T017 [FE] Implement WebSocket client hook in `client/hooks/useWebSocket.ts`: connection with session token, auto-reconnect (exponential backoff), channel subscribe/unsubscribe. Implement `client/lib/ws.ts` (WebSocket client class) and `client/lib/api.ts` (fetch wrapper with auth cookie)
- [ ] T018 [FE] Create LoginPage in `client/pages/LoginPage.tsx`: username/password form, POST /api/auth/login, redirect to dashboard on success
- [ ] T019 [FE] Implement `client/hooks/useJob.ts`: track async job progress via WebSocket channel `job:<jobId>`, expose state (logs, progress steps, final result)

**Checkpoint**: Auth works, SSH pool connects, jobs stream to WebSocket, React shell renders

---

## Phase 3: User Story 1+2 — Deploy & Rollback (Priority: P1)

**Goal**: Deploy an app from browser click with zero-downtime, rollback on failure.

**Independent Test**: Add server → add app → click Deploy → see real-time logs → success status. Click Rollback → previous version restored.

- [ ] T020 [BE] [US1] Implement server CRUD routes in `server/routes/servers.ts` with Zod validation: GET/POST/PUT/DELETE /api/servers, POST /api/servers/:id/verify (SSH connectivity check via ssh-pool). Include structured error handling
- [ ] T021 [BE] [US1] Implement application CRUD routes in `server/routes/apps.ts` with Zod validation: GET/POST/PUT/DELETE /api/servers/:serverId/apps and /api/apps/:id
- [ ] T022 [BE] [US1] Implement deploy lock in `server/services/deploy-lock.ts` with typed inputs/outputs: `acquireLock(serverId, appId) → boolean` via atomic `mkdir /tmp/deploy.lock` over SSH, `releaseLock(serverId)` via `rm -rf`, `checkLock(serverId) → owner | null`. Include lock cleanup in zombie triage
- [ ] T023 [BE] [US1] Implement deployment routes in `server/routes/deployments.ts` with Zod validation: POST /api/apps/:appId/deploy (pre-flight checks → acquire lock → run deploy.sh via script-runner → stream to job → record in DB → release lock), GET /api/apps/:appId/deployments (history with pagination), GET /api/deployments/:id
- [ ] T024 [BE] [US2] Implement rollback route in `server/routes/deployments.ts`: POST /api/apps/:appId/rollback (acquire lock → run rollback.sh → stream → record → release). Include target commit selection
- [ ] T025 [BE] [US1] Implement deployment cancel in `server/routes/deployments.ts`: POST /api/deployments/:id/cancel (kill SSH channel, release lock, update status)
- [ ] T026 [FE] [US1] Create ServerListPage in `client/pages/DashboardPage.tsx`: list all servers with status badges (online/offline), "Add Server" dialog with form (label, host, port, user, key path), verify button
- [ ] T027 [FE] [US1] Create ServerPage in `client/pages/ServerPage.tsx`: server detail view with tabs (Apps, Health, Backups, Docker). Applications list with deploy status
- [ ] T028 [FE] [US1] Create AppPage in `client/pages/AppPage.tsx`: current deploy info (branch, commit, version), "Deploy" button with pre-flight check display, real-time log viewer component using useJob hook
- [ ] T029 [FE] [US1] Create deploy log viewer component in `client/components/deploy/DeployLog.tsx`: virtual-scroll log display, auto-scroll, ANSI color rendering, progress step indicators
- [ ] T030 [FE] [US2] Add rollback UI to AppPage: deployment history table, "Rollback" button per deployment, confirmation dialog, real-time rollback progress
- [ ] T031 [E2E] [US1] Integration test for deploy flow in `tests/integration/deploy.test.ts`: mock SSH connection, verify pre-flight → lock → script exec → log streaming → status update → lock release → audit entry

**Checkpoint**: US1+US2 complete — deploy and rollback work end-to-end

---

## Phase 4: User Story 3 — Database Backup & Restore (Priority: P1)

**Goal**: One-click backup, list backups, restore with confirmation.

**Independent Test**: Navigate to Backups → click Backup → see progress → backup appears in list → Restore with confirmation → success.

- [ ] T032 [BE] [US3] Implement backup routes in `server/routes/backups.ts` with Zod validation: POST /api/servers/:serverId/backups (run backup.sh via script-runner), GET /api/servers/:serverId/backups (list with metadata from remote `ls -la`), DELETE /api/backups/:id
- [ ] T033 [BE] [US3] Implement restore route in `server/routes/backups.ts`: POST /api/backups/:id/restore (requires X-Confirm-Destructive header, run restore.sh via script-runner, stream progress)
- [ ] T034 [FE] [US3] Create BackupsPage in `client/pages/BackupsPage.tsx`: backup list table (name, size, date, retention status), "Create Backup" button with database name input, real-time progress. Restore button per backup with confirmation dialog
- [ ] T035 [E2E] [US3] Integration test for backup/restore flow in `tests/integration/backup.test.ts`: mock SSH, verify backup creation → list update → restore with confirmation → audit entry

**Checkpoint**: US3 complete — backup and restore work

---

## Phase 5: User Story 4 — Health Monitoring (Priority: P1)

**Goal**: Real-time server health metrics with auto-refresh and visual thresholds.

**Independent Test**: Navigate to server → health tab shows CPU/memory/disk/swap/Docker → auto-refreshes every 60s → yellow/red indicators on threshold breach.

- [ ] T036 [BE] [US4] Implement health poller in `server/services/health-poller.ts` with typed inputs/outputs: background scheduler (setInterval per server), runs health-check.sh via ssh-pool, parses JSON output, stores HealthSnapshot in DB, broadcasts to WebSocket channel `health:<serverId>`. Configurable interval (default 60s)
- [ ] T037 [BE] [US4] Implement health routes in `server/routes/health.ts`: GET /api/servers/:serverId/health (latest snapshot), GET /api/servers/:serverId/health/history (last 24h), POST /api/servers/:serverId/health/refresh (force immediate check)
- [ ] T038 [FE] [US4] Create health dashboard components in `client/components/health/`: MetricCard (CPU/memory/disk/swap with threshold coloring), ContainerList (Docker container status table), ServiceStatus (nginx/docker/pm2 badges). Use recharts for 24h history chart
- [ ] T039 [FE] [US4] Wire health components into ServerPage health tab, subscribe to `health:<serverId>` WebSocket channel via useHealth hook in `client/hooks/useHealth.ts`
- [ ] T040 [E2E] [US4] Integration test for health monitoring in `tests/integration/health.test.ts`: mock SSH health-check output, verify polling → DB storage → WebSocket broadcast → threshold detection

**Checkpoint**: US4 complete — health monitoring works with auto-refresh

---

## Phase 6: User Story 5 — Log Streaming (Priority: P2)

**Goal**: Real-time log tail with source selection, search, pause/resume.

- [ ] T041 [BE] [US5] Implement log routes in `server/routes/logs.ts`: GET /api/servers/:serverId/logs/sources (detect available sources via SSH: pm2, docker, nginx). WebSocket channel `logs:<serverId>:<source>` — on subscribe: spawn SSH tail process, pipe to channel. On unsubscribe: kill SSH process
- [ ] T042 [FE] [US5] Create LogViewer component in `client/components/logs/LogViewer.tsx`: source selector dropdown, virtual-scroll log display with ANSI rendering, search/filter input, pause/resume button. Use `client/hooks/useWebSocket.ts` subscribe/unsubscribe for channel management
- [ ] T043 [FE] [US5] Wire LogViewer into AppPage as "Logs" tab, with source auto-detection from GET /api/servers/:serverId/logs/sources

**Checkpoint**: US5 complete — real-time log streaming works

---

## Phase 7: User Story 6 — Security Audit (Priority: P2)

**Goal**: Run security audit, display results grouped by severity.

- [ ] T044 [BE] [US6] Implement audit routes in `server/routes/audit.ts` with Zod validation: POST /api/apps/:appId/audit (run security-audit.sh via script-runner, parse JSON results, store in DB), GET /api/apps/:appId/audits (list), GET /api/audits/:id (detail)
- [ ] T045 [FE] [US6] Create SecurityAuditPage component in `client/components/audit/AuditResults.tsx`: severity badges (critical/high/medium/low), grouped findings list, comparison with previous audit. Wire into AppPage as "Security" tab

**Checkpoint**: US6 complete — security audits work

---

## Phase 8: User Story 7 — Server Setup (Priority: P3)

**Goal**: Add fresh VPS, select setup tasks, execute with real-time output.

- [ ] T046 [BE] [US7] Implement server setup route in `server/routes/servers.ts`: POST /api/servers/:id/setup with `{ tasks: string[] }` body. Execute selected scripts (setup-vps.sh, setup-ssl.sh) sequentially via script-runner, stream each step to job
- [ ] T047 [FE] [US7] Create ServerSetupWizard in `client/components/servers/SetupWizard.tsx`: task checklist (deploy user, SSH hardening, firewall, swap, Node.js, SSL), "Run Setup" button, real-time log per step with progress indicators

**Checkpoint**: US7 complete — server provisioning works

---

## Phase 9: User Story 8 — Docker Cleanup (Priority: P3)

**Goal**: View Docker disk usage, run safe/aggressive cleanup.

- [ ] T048 [BE] [US8] Implement docker routes in `server/routes/docker.ts`: GET /api/servers/:serverId/docker (disk usage + container list via SSH `docker system df --format json` + `docker ps --format json`), POST /api/servers/:serverId/docker/cleanup `{ mode: "safe"|"aggressive" }` via script-runner
- [ ] T049 [FE] [US8] Create DockerPanel in `client/components/docker/DockerPanel.tsx`: disk usage visualization, container list table, "Safe Cleanup" and "Aggressive Cleanup" buttons with confirmation for aggressive. Wire into ServerPage Docker tab

**Checkpoint**: US8 complete — Docker management works

---

## Phase 10: Polish & Cross-Cutting

**Purpose**: Audit trail UI, responsive layout, final E2E tests

- [ ] T050 [FE] Create AuditPage in `client/pages/AuditPage.tsx`: paginated audit trail table with filters (action type, target, date range). GET /api/audit-trail
- [ ] T051 [FE] Responsive layout polish: test all pages at mobile (375px), tablet (768px), desktop (1280px). Fix any overflow/layout issues
- [ ] T052 [BE] Implement Telegram notification integration: wire notifier.ts into deploy success/failure/rollback events in deployment routes
- [ ] T053 [OPS] Create `.github/workflows/ci.yml`: lint + typecheck + test on push/PR. Create `.github/workflows/docker-publish.yml`: build and push Docker image on tag
- [ ] T054 [E2E] Full E2E test suite in `tests/e2e/`: login → add server → deploy → check logs → backup → health check → rollback. Mock SSH layer

**Checkpoint**: All features complete, CI configured, E2E passing

---

## Dependency Graph

### Legend

- `→` means "unlocks" (left must complete before right can start)
- `+` means "all of these" (join point)

### Dependencies

```
# Phase 1: Setup
T001 → T002, T003, T004, T005

# Phase 2: Foundational
T002 → T006
T006 → T007
T007 → T008, T012, T013, T014, T015
T008 → T009
T009 → T010
T010 → T011
T005 + T011 + T012 → T016
T016 → T017, T018
T017 → T019

# Phase 2 → Phase 3: core services unlock deploy
T009 + T012 + T013 + T014 → T020
T020 → T021
T021 → T022
T022 → T023
T023 → T024, T025
T016 + T017 + T019 → T026
T026 → T027
T027 → T028
T028 → T029, T030
T023 + T029 → T031

# Phase 4: Backup (needs script-runner + routes pattern)
T009 + T014 + T020 → T032
T032 → T033
T016 + T032 → T034
T033 + T034 → T035

# Phase 5: Health (needs ssh-pool + WebSocket)
T008 + T011 + T007 → T036
T036 → T037
T016 + T017 → T038
T037 + T038 → T039
T039 → T040

# Phase 6: Logs (needs WebSocket + ssh-pool)
T008 + T011 → T041
T017 + T041 → T042
T042 → T043

# Phase 7: Security (needs script-runner)
T009 + T014 → T044
T016 + T044 → T045

# Phase 8: Server setup (needs ssh-pool + script-runner)
T009 + T020 → T046
T016 + T019 + T046 → T047

# Phase 9: Docker (needs ssh-pool)
T008 + T014 → T048
T016 + T048 → T049

# Phase 10: Polish
T016 → T050, T051
T015 + T023 + T024 → T052
T004 → T053
T031 + T035 + T040 + T043 + T045 + T047 + T049 → T054
```

### Self-Validation Checklist

> - [x] Every task ID in Dependencies exists in the task list above
> - [x] No circular dependencies
> - [x] No orphan task IDs referenced that don't exist
> - [x] Fan-in uses `+` only, fan-out uses `,` only
> - [x] No chained arrows on a single line

---

## Parallel Lanes

| Lane | Agent Flow | Tasks | Blocked By |
|------|-----------|-------|------------|
| 1 | [SETUP] | T001 → T002..T005 | — |
| 2 | [DB] schema | T006 → T007 | T002 |
| 3 | [BE] SSH + jobs | T008 → T009 → T010 → T011 | T007 |
| 4 | [BE] auth + middleware | T012, T013, T014 | T007 |
| 5 | [BE] deploy routes | T020..T025 | T009, T012 |
| 6 | [BE] backup routes | T032, T033 | T009, T020 |
| 7 | [BE] health poller | T036, T037 | T008, T011 |
| 8 | [BE] logs | T041 | T008, T011 |
| 9 | [BE] security | T044 | T009 |
| 10 | [BE] server setup | T046 | T009, T020 |
| 11 | [BE] docker | T048 | T008 |
| 12 | [FE] shell + auth | T016 → T017 → T018, T019 | T011, T012 |
| 13 | [FE] deploy UI | T026 → T027 → T028 → T029, T030 | T016 |
| 14 | [FE] backup UI | T034 | T016, T032 |
| 15 | [FE] health UI | T038, T039 | T016, T037 |
| 16 | [FE] logs UI | T042, T043 | T017, T041 |
| 17 | [FE] audit/security UI | T045, T050 | T016, T044 |
| 18 | [FE] server setup UI | T047 | T016, T046 |
| 19 | [FE] docker UI | T049 | T016, T048 |
| 20 | [E2E] | T031, T035, T040, T054 | respective impl tasks |
| 21 | [OPS] | T053 | T004 |

---

## Agent Summary

| Agent | Task Count | Can Start After |
|-------|-----------|-----------------|
| [SETUP] | 5 | immediately |
| [DB] | 2 | T002 (setup complete) |
| [BE] | 24 | T007 (schema ready) |
| [FE] | 18 | T011 + T012 (core services ready) |
| [E2E] | 4 | respective implementation tasks |
| [OPS] | 1 | T004 (Dockerfile exists) |
| **Total** | **54** | — |

**Critical Path**: T001 → T002 → T006 → T007 → T008 → T009 → T010 → T011 → T016 → T017 → T019 → T026 → T027 → T028 → T029

Length: 15 sequential steps (Setup → Schema → SSH Pool → Script Runner → Job Manager → WebSocket → React Shell → WS Hook → Job Hook → Server List → Server Page → App Page → Deploy Log)

---

## Implementation Strategy

### MVP First (US1+US2 Only)

1. Complete Phase 1: Setup (T001–T005)
2. Complete Phase 2: Foundational (T006–T019)
3. Complete Phase 3: Deploy + Rollback (T020–T031)
4. **STOP and VALIDATE**: Deploy from browser → real-time logs → rollback works
5. Ship as v0.1.0 (deploy-only dashboard)

### Incremental Delivery

1. v0.1.0: Deploy + Rollback (US1+US2) → core value
2. v0.2.0: + Backup/Restore (US3) + Health (US4) → monitoring
3. v0.3.0: + Logs (US5) + Security (US6) → observability
4. v1.0.0: + Server Setup (US7) + Docker (US8) + Polish → feature-complete

### Parallel Agent Strategy (Claude Code)

1. **Orchestrator** completes Setup (T001–T005)
2. **database-architect** does schema (T006–T007) — fast, 2 tasks
3. **backend-specialist** picks up SSH pool → script runner → job manager → WebSocket (T008–T015) — critical path
4. **frontend-specialist** starts as soon as T011+T012 done — React shell, auth UI
5. After Phase 2: BE and FE work in parallel on user story phases (BE does routes, FE does UI)
6. **test-engineer** kicks in after each story's implementation

---

## Notes

- `[BE]` handles all backend code AND its unit tests
- `[FE]` handles all frontend code AND its component tests
- `[E2E]` handles cross-boundary integration tests only
- `[DB]` is lightweight (2 tasks) — schema + migration, then BE takes over
- All BE route tasks include Zod validation per coding standards
- SSH mock layer needed for all tests (no real server connections in CI)
- Log files stored at `/app/data/logs/` — not in SQLite
