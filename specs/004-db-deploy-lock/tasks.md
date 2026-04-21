# Tasks: Database-Backed Deploy Lock

**Input**: Design documents from `/specs/004-db-deploy-lock/`
**Prerequisites**: plan.md (v1.0), spec.md (v1.0), research.md, data-model.md, contracts/api.md, quickstart.md

**Tests**: Yes — unit test for key derivation; integration tests against mocked `postgres` driver for each user story.

**Organization**: Refactor-shape feature (no UI, no new routes). Phase 1 sets up schema + migration; Phase 2 rewrites the service; Phases 3–7 are one-per-user-story integration tests; Phase 8 polishes cleanup + security review.

## Format: `[ID] [AGENT] [Story?] Description`

## Agent Tags

| Tag | Agent | Domain |
|-----|-------|--------|
| `[SETUP]` | — (orchestrator) | Shared schema edit |
| `[DB]` | database-architect | Schema + migration |
| `[BE]` | backend-specialist | Service rewrite, hooks, tests |
| `[OPS]` | devops-engineer | Regression verification of existing routes |
| `[SEC]` | security-auditor | Code audit of the new lock service |

No `[FE]` / `[E2E]` tasks — feature has no UI and no cross-boundary scenarios.

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

**Purpose**: Extend the Drizzle schema and register the new migration. Shared edit on `schema.ts`; downstream tasks in Phase 2 consume it.

- [ ] T001 [SETUP] Extend `server/db/schema.ts` with the `deployLocks` table per data-model.md §Drizzle: `pgTable("deploy_locks", { serverId: text("server_id").primaryKey().references(() => servers.id, { onDelete: "cascade" }), appId: text("app_id").notNull(), acquiredAt: text("acquired_at").notNull(), dashboardPid: integer("dashboard_pid").notNull() })`. Import `integer` from `drizzle-orm/pg-core` if not yet imported.
- [ ] T002 [DB] Create migration `server/db/migrations/0004_deploy_locks.sql` with parameterized DDL: `CREATE TABLE "deploy_locks" (server_id TEXT PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE, app_id TEXT NOT NULL, acquired_at TEXT NOT NULL, dashboard_pid INTEGER NOT NULL)`. Update `meta/_journal.json` with `idx: 4, tag: "0004_deploy_locks", when: <epoch-ms>, breakpoints: true`. Verify by running `npm --prefix devops-app run db:check` locally (does NOT apply to prod per CLAUDE.md rule 5 — admin applies on release).

**Checkpoint**: Schema ready, migration file reviewable.

---

## Phase 2: Foundational (Service Rewrite + Integration Hooks)

**Purpose**: Replace the SSH-based `DeployLock` with a Postgres-backed implementation and wire startup + shutdown integration. Everything else (tests, regression, security audit) blocks on this.

- [ ] T003 [BE] Rewrite `server/services/deploy-lock.ts` with typed inputs/outputs: (a) export constant `DEPLOY_LOCK_NAMESPACE = 1` (two-arg advisory-lock namespace per FR-002), (b) module-scoped `const held = new Map<string, ReservedSql>()`, (c) `async acquireLock(serverId: string, appId: string): Promise<boolean>` using `client.reserve()` + `reserved.begin(tx => ...)` + `SELECT pg_try_advisory_lock(1, hashtext($1))` + `INSERT ... ON CONFLICT (server_id) DO UPDATE` per data-model.md §Query Catalogue #1, (d) `async releaseLock(serverId: string): Promise<void>` idempotent, runs `DELETE FROM deploy_locks WHERE server_id = $1` + `SELECT pg_advisory_unlock(1, hashtext($1))` on the held reserved connection per #2 (catches + logs release errors via structured logger, never throws), (e) `async checkLock(serverId: string): Promise<string | null>` read-only per FR-012, runs query #3 on the main pool with parameterized query via tagged-template, (f) `async reconcileOrphanLocks(): Promise<number>` runs query #4 on main pool and logs count via `logger.info({ ctx: "deploy-lock-reconcile", count, serverIds }, "Orphan locks cleaned")`. All database interaction via `postgres` tagged-template (`sql\`\`` syntax) — no raw string interpolation. No `as any`. No `console.log` — use `logger` from `server/lib/logger.js`.
- [ ] T004 [BE] Wire integration hooks in `server/index.ts` with structured error handling: (a) after the existing `migrate(...)` call (~line 89), add `await deployLock.reconcileOrphanLocks().catch(err => logger.warn({ err }, "Orphan reconciliation skipped"))` so startup is never blocked on reconcile, (b) register a `process.on("SIGTERM", ...)` handler that iterates `[...deployLock['held'].keys()]` (or a new exported `DeployLock.heldServerIds()` helper — add if access feels unclean), awaits `Promise.allSettled(ids.map(id => deployLock.releaseLock(id)))` with a 2s overall timeout (via `Promise.race([...done, sleep(2000)])`), then calls `client.end({ timeout: 5 })` and `process.exit(0)`. Log via `logger.info({ ctx: "shutdown", releasedCount }, "Graceful shutdown complete")`.

**Checkpoint**: Service rewritten, hooks wired. Existing tests will fail until Phase 3+; that's expected and drives the TDD-Lite flow.

---

## Phase 3: User Story 1 — Acquire Instantly, No SSH (Priority: P1)

**Goal**: A single `acquireLock` call succeeds within <10 ms and issues zero SSH commands (US-001, SC-001).

**Independent Test**: Spin up a test fixture against a mocked `postgres` client (or real test DB), call `deployLock.acquireLock("srv-A", "app-A")`. Assert return `true`, assert `sshPool.exec` was **never** called, assert `deploy_locks` contains exactly one row for `srv-A` with `app_id = "app-A"` and a non-zero `dashboard_pid`.

- [ ] T005 [BE] [US1] Write unit test in `tests/unit/deploy-lock-key.test.ts` covering: (a) `DEPLOY_LOCK_NAMESPACE === 1` constant is exported, (b) two serverIds with different content produce different `hashtext` keys (integration test mock captures the exact int passed to `pg_try_advisory_lock` args), (c) same serverId produces a stable key across calls. Pure function tests — no DB, no SSH.
- [ ] T006 [BE] [US1] Write integration test in `tests/integration/deploy-lock.test.ts` (REWRITE of existing file) covering the happy-path: mock `postgres` client with `sql.reserve()` returning a captured handle, stub `pg_try_advisory_lock` to return `true`, stub `INSERT ... ON CONFLICT` to return successfully, stub `pg_backend_pid()` to return `12345`. Assert: `acquireLock` resolves `true`, `deploy_locks` receives the correct INSERT with `dashboard_pid=12345`, `sshPool.exec` mock was never called, subsequent `checkLock` returns `"app-A"`, `releaseLock` drops the row and calls `pg_advisory_unlock` on the SAME reserved connection (not a different one).

**Checkpoint**: US1 verified end-to-end against mocked driver.

---

## Phase 4: User Story 2 — Concurrent Same-Server Blocked (Priority: P1)

**Goal**: Two `acquireLock` calls on the same `serverId` — first returns `true`, second returns `false` (SC-005).

**Independent Test**: Call `acquireLock("srv-A", "app-1")` then immediately `acquireLock("srv-A", "app-2")` (same process or simulated second connection). Expect first `true`, second `false`, `checkLock("srv-A")` returns `"app-1"`.

- [ ] T007 [BE] [US2] Extend `tests/integration/deploy-lock.test.ts` with concurrent-same-server scenario: first `acquireLock` returns `true`, the mock's second `pg_try_advisory_lock` returns `false` (simulating an already-held advisory lock from a separate connection), assert second `acquireLock` resolves `false` without touching `deploy_locks` a second time. Also cover the same-process re-entrancy guard: if the same process tries to acquire twice, assert it throws `"lock already held by this instance"` before hitting SQL (per plan.md §Key Implementation Notes).

**Checkpoint**: US2 verified — correctness of conflict semantics.

---

## Phase 5: User Story 3 — Different Servers Parallel (Priority: P1)

**Goal**: `acquireLock("srv-A", "app-1")` and `acquireLock("srv-B", "app-2")` both succeed concurrently (US-003, SC-005).

**Independent Test**: Fire both `acquireLock` calls via `Promise.all`. Both resolve `true`. `checkLock("srv-A") === "app-1"` and `checkLock("srv-B") === "app-2"`. Each consumes a distinct reserved connection.

- [ ] T008 [BE] [US3] Extend `tests/integration/deploy-lock.test.ts` with parallel-different-servers scenario: mock `sql.reserve()` to track how many distinct reserved handles were issued, fire two concurrent `acquireLock` calls, assert two distinct handles were checked out, both got `pg_try_advisory_lock=true` (because the mock's `hashtext(srv-A) !== hashtext(srv-B)`), both rows present in the mock's `deploy_locks` store. Release both, assert handle count returns to zero.

**Checkpoint**: US3 verified — per-server isolation.

---

## Phase 6: User Story 4 — Restart Releases Locks (Priority: P2)

**Goal**: Dashboard process dies while holding locks; next startup cleans up orphan rows and fresh `acquireLock` succeeds (US-004, SC-003).

**Independent Test**: Seed `deploy_locks` with one row whose `dashboard_pid=999999` (definitely not alive). Call `reconcileOrphanLocks()`. Assert the orphan row is gone, return value is `1`. Then call `acquireLock` on the same `serverId` — should succeed (no ghost lock blocking).

- [ ] T009 [BE] [US4] Extend `tests/integration/deploy-lock.test.ts` with crash-recovery scenario: mock `pg_stat_activity` query to return only the current test-process backend PID, seed `deploy_locks` mock store with an orphan row whose `dashboard_pid` is NOT in the mocked `pg_stat_activity` result. Call `deployLock.reconcileOrphanLocks()`, assert return value equals the number of orphan rows deleted, assert store no longer contains those rows. Bonus assertion: orphan rows whose `dashboard_pid` DOES match the live PID are preserved (we don't wipe legit in-flight locks of a sibling instance — forward-compat with future HA).

**Checkpoint**: US4 verified — reconciliation is correct AND conservative.

---

## Phase 7: User Story 5 — SSH-Unreachable Server, Lock Still Usable (Priority: P2)

**Goal**: The lock works entirely in-database — SSH reachability of the target server is irrelevant (US-005, SC-002, SC-004).

**Independent Test**: Make `sshPool.exec` mock throw on any call. Run full acquire → check → release cycle. Assert all three succeed. Assert `sshPool.exec` was never called with anything lock-related.

- [ ] T010 [BE] [US5] Extend `tests/integration/deploy-lock.test.ts` with SSH-isolation regression: at the top of the test, override `sshPool.exec` to `vi.fn().mockImplementation(() => { throw new Error("SSH unreachable in test"); })`. Run `acquireLock` → `checkLock` → `releaseLock`. Assert none of them propagate the SSH error; assert `sshPool.exec` was called 0 times (this is the sentinel — if someone re-introduces SSH-based lock logic, this test fails immediately).

**Checkpoint**: US5 verified — SSH-free operation guaranteed by a regression test.

---

## Phase 8: Polish & Cross-Cutting Concerns

**Purpose**: Clean up legacy tests, verify deployment route regression, security audit. Runs after all US phases are green.

- [ ] T011 [BE] Remove obsolete assertions from the OLD `tests/integration/deploy.test.ts` (pre-rewrite — expects `sshPool.exec` with `mkdir /tmp/...` strings): either delete the file entirely if its only purpose was covering the old FS lock (check `git blame`), OR remove just the FS-lock test blocks and keep any other coverage (e.g. for `deployments.ts` route behaviour). Rename to `deploy-route.test.ts` if the latter — naming signals it's testing the route, not the lock. Verify `npx vitest run --root=.` passes cleanly afterwards.
- [ ] T012 [OPS] Regression-verify `server/routes/deployments.ts` needs zero changes: run the FULL test suite (`npx vitest run --root=.`) and confirm the existing deploy-route integration tests (acquire → run script → release → mark status) continue to pass against the rewritten `DeployLock`. If any test failures surface that are NOT about the lock path, document them as pre-existing. If a failure IS about the lock path, fix by adjusting the test (not the route) — the route's call-shape is the contract.
- [ ] T013 [SEC] Security audit in `specs/004-db-deploy-lock/security-review.md` covering: (a) confirm all DB interaction in `deploy-lock.ts` uses parameterized `postgres` tagged-template (no string interpolation of `serverId` / `appId` into SQL), (b) confirm `reconcileOrphanLocks` DELETE is scoped only to rows whose PID is provably dead (not a mass delete), (c) evaluate PID-reuse edge case (Linux `pid_max=4194304` makes this irrelevant in practice; document), (d) confirm `pg_stat_activity` access doesn't leak cross-tenant data in self-hosted compose (dashboard role sees only its own backends by default), (e) verify graceful-shutdown handler doesn't race the HTTP server close (SIGTERM → release → client.end → exit ordering is correct). Produce findings table identical in shape to `specs/003-scan-for-repos/security-review.md`.

**Checkpoint**: Feature ready for `/speckit.analyze`, then merge.

---

## Dependency Graph

```
# Phase 1 (Setup / DB)
T001 → T002, T003

# Phase 2 (Foundational — service + hooks)
T002 → T004
T003 → T004

# Phase 3–7 (US tests — all fork off after Foundational is complete)
T004 → T005, T006, T007, T008, T009, T010

# Phase 8 (Polish — waits for all US phases)
T006 + T007 + T008 + T009 + T010 → T011
T011 → T012
T003 + T004 → T013
```

### Self-validation (must pass)

- [X] Every task ID referenced in Dependencies exists in the task list (T001–T013).
- [X] No circular dependencies — DAG topologically ordered from T001.
- [X] No orphan references (all IDs in the graph are defined tasks).
- [X] Fan-in uses `+` only (e.g. `T006 + T007 + T008 + T009 + T010 → T011`), fan-out uses `,` only (e.g. `T004 → T005, T006, T007, T008, T009, T010`).
- [X] No chained arrows on a single line.

---

## Parallel Lanes

Each lane is a sequential chain assignable to one agent. Lanes run in parallel subject to the graph.

| Lane | Agent | Tasks | Starts after |
|---|---|---|---|
| L1 — Schema | [SETUP]/[DB] | T001 → T002 | — |
| L2 — Service | [BE] | T003 | T001 |
| L3 — Hooks | [BE] | T004 | T002 + T003 |
| L4 — US1 tests | [BE] | T005, T006 (parallel within lane) | T004 |
| L5 — US2 tests | [BE] | T007 | T004 |
| L6 — US3 tests | [BE] | T008 | T004 |
| L7 — US4 tests | [BE] | T009 | T004 |
| L8 — US5 tests | [BE] | T010 | T004 |
| L9 — Legacy cleanup | [BE] | T011 | all of L4–L8 |
| L10 — Regression | [OPS] | T012 | T011 |
| L11 — SEC audit | [SEC] | T013 | T003 + T004 (can run parallel to L4–L10) |

---

## Agent Summary

| Agent | Tasks | Start condition |
|---|---|---|
| `[SETUP]` | T001 | — |
| `[DB]` | T002 | after T001 |
| `[BE]` | T003, T004, T005, T006, T007, T008, T009, T010, T011 | T003: after T001; T004: after T002+T003; T005–T010: after T004; T011: after T005–T010 |
| `[OPS]` | T012 | after T011 |
| `[SEC]` | T013 | after T003+T004 |

Total: **13 tasks**.

---

## Critical Path

The longest dependency chain (determines minimum shipping time):

```
T001 → T002 → T004 → T006 → T011 → T012
```

6 tasks on the critical path. Everything else (T005, T007, T008, T009, T010, T013) parallelises.

---

## Implementation Strategy

### MVP scope

**Phases 1 → 2 → 3** ship the core promise: the lock works, no SSH, no filesystem. That's T001 → T002 → T003 → T004 → T005 → T006 (6 tasks). At this point the feature is functional in prod but only US-001 is test-covered. Subsequent test phases (T007–T010) are **correctness insurance** — they'll catch regressions but don't change runtime behaviour.

Ship order if under time pressure:
1. **Day-1 cut**: T001–T006 (service works, US1 test green). Feature live in prod.
2. **Correctness cut**: + T007–T010 (all US tests). Guaranteed to catch regressions.
3. **Release-readiness cut**: + T011–T013 (legacy cleanup, regression verify, SEC audit).

### Incremental delivery

- **After T004**: endpoint behaviour is fully swapped. Deploy smoke test via `POST /api/apps/:appId/deploy` should produce identical 409 conflict on repeated clicks, but now backed by Postgres. Worth a manual verification step in staging before pushing to prod.
- **After T010**: regression sentinel in place. Any future attempt to reintroduce SSH-based locking will fail US5's test.
- **After T013**: SEC review artifact exists for audit trail.

### Parallel agent strategy

- **Post-T001**: L2 ([BE] service) starts immediately. L1 continues with T002 in parallel.
- **Post-T004**: Five US test lanes (L4–L8) fork out simultaneously — any one [BE] agent can pick them in any order, no inter-lane dependencies.
- **[SEC] audit (T013)** runs **in parallel** with test lanes — only needs the service + hooks to be code-complete, not the tests to be green.
- **[OPS] regression (T012)** is the final gate — must wait for legacy cleanup (T011) to ensure no stale tests pollute the regression run.
