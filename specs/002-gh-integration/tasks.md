# Tasks: GitHub Integration

**Input**: Design documents from `/specs/002-gh-integration/`
**Prerequisites**: plan.md (v1.0), spec.md (v1.0), research.md, data-model.md, contracts/api.md, quickstart.md

**Tests**: Yes — integration tests for GitHub API service and settings flow.

**Organization**: Tasks grouped by foundation + user stories (US1–US4 from spec.md). Each task assigned to a specialist agent.

## Format: `[ID] [AGENT] [Story?] Description`

## Agent Tags

| Tag | Agent | Domain |
|-----|-------|--------|
| `[SETUP]` | — (orchestrator) | Shared dependencies, schema, config |
| `[DB]` | database-architect | Schema, migrations |
| `[BE]` | backend-specialist | Express routes, services |
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

All paths relative to `devops-app/` (the application root).

---

## Phase 1: Setup

**Purpose**: Install dependencies, extend DB schema

- [ ] T001 [SETUP] Install `lru-cache` dependency: `npm install lru-cache`
- [ ] T002 [DB] Add `githubConnection` table to `server/db/schema.ts` per data-model.md: id (text, PK, CHECK='DEFAULT'), token (text), username (text), avatarUrl (text), tokenExpiresAt (text), connectedAt (text). Add `githubRepo` (text, nullable) column to existing `applications` table
- [ ] T003 [DB] Create migration `server/db/migrations/0002_github.sql`: CREATE TABLE github_connection with `CHECK ("id" = 'DEFAULT')` constraint on PK, all columns as text (token, username, avatar_url, token_expires_at, connected_at). ALTER TABLE applications ADD COLUMN github_repo text. Update `meta/_journal.json` with idx=2 entry

**Checkpoint**: Schema extended, lru-cache available

---

## Phase 2: Foundational (GitHub Service)

**Purpose**: GitHub API client with caching and rate limiting — required by ALL user stories

- [ ] T004 [BE] Implement GitHub API service in `server/services/github.ts` with typed inputs/outputs: LRU cache (max 500, TTL 5min), rate limit tracking from `X-RateLimit-*` headers, cooldown mode when rate limited. Methods: `validateToken(token) → { username, avatarUrl, tokenExpiresAt }`, `searchRepos(token, query) → GitHubRepository[]` (NOT cached), `getBranches(token, owner, repo) → GitHubBranch[]`, `getCommits(token, owner, repo, branch, count) → GitHubCommit[]`, `getCommitStatus(token, owner, repo, sha) → CommitStatus`, `getRateLimit() → GitHubRateLimit`, `invalidateCache(pattern) → void`. Parse `github-authentication-token-expiration` header on token validation
- [ ] T005 [BE] Implement settings routes in `server/routes/settings.ts` with Zod validation: GET /api/settings/github (return connection or null, never expose token), POST /api/settings/github { token } (validate via github service → upsert with ON CONFLICT DO UPDATE → return connection), DELETE /api/settings/github (delete row → 204), GET /api/settings/github/rate-limit (return rate limit from github service)
- [ ] T006 [BE] Implement GitHub proxy routes in `server/routes/github.ts` with Zod validation: GET /api/github/repos?q= (search repos via github service, require q min 2 chars), GET /api/github/repos/:owner/:repo/branches, GET /api/github/repos/:owner/:repo/commits?branch=&count=20. All routes: check github connection exists first → 400 GITHUB_NOT_CONNECTED if missing. Handle rate limit → 429 GITHUB_RATE_LIMITED. Handle 401 from GitHub API (token revoked/expired) → return 401 GITHUB_UNAUTHORIZED with message "GitHub token expired or revoked — update in Settings"
- [ ] T007 [BE] Wire settings and github routes into `server/index.ts`: import and register `settingsRouter` at `/api/settings`, `githubRouter` at `/api/github`
- [ ] T008 [BE] Extend deploy route in `server/routes/deployments.ts`: accept optional `commit` field in deploy schema, validate SHA with regex `^[0-9a-f]{7,40}$` (return 400 INVALID_SHA if fails), pass validated SHA to script-runner
- [ ] T009 [BE] Extend app creation in `server/routes/apps.ts`: add optional `githubRepo` field to createAppSchema, store in DB on insert

**Checkpoint**: GitHub service operational, all API endpoints functional, deploy accepts commit SHA

---

## Phase 3: User Story 1 — Connect GitHub Account (Priority: P1)

**Goal**: Admin pastes PAT in Settings, dashboard validates and shows connection status.

**Independent Test**: Open Settings → paste token → see "Connected as @username" with avatar and expiry date → disconnect → status cleared.

- [ ] T010 [FE] [US1] Create SettingsPage in `client/pages/SettingsPage.tsx`: GitHub section with token input (type=password), "Connect" button, connected state display (username, avatar, token expiry as "expires in N days"), "Disconnect" button with confirmation. Rate limit display (remaining/limit). Show warning note: "All dashboard users will access repositories available to this GitHub account"
- [ ] T011 [FE] [US1] Add `/settings` route to `client/App.tsx` and "Settings" link to sidebar in `client/components/layout/Layout.tsx`
- [ ] T012 [FE] [US1] Create `client/hooks/useGitHub.ts`: `useGitHubConnection()` hook (GET /api/settings/github via react-query), `useConnectGitHub()` mutation (POST), `useDisconnectGitHub()` mutation (DELETE), `useGitHubRateLimit()` query

**Checkpoint**: US1 complete — GitHub connection manageable from Settings

---

## Phase 4: User Story 2 — Add Application from GitHub (Priority: P1)

**Goal**: Select repo from GitHub instead of typing URL manually.

**Independent Test**: Server → Apps → Add App → search repos → select → fields auto-populate → add → app linked with githubRepo.

- [ ] T013 [FE] [US2] Create RepoSearch component in `client/components/github/RepoSearch.tsx`: search input with debounce (300ms), calls GET /api/github/repos?q=, displays results as selectable list (name, owner, private badge, default branch). On select: emits { fullName, name, repoUrl, defaultBranch }. Show "GitHub not connected" fallback if no connection
- [ ] T014 [FE] [US2] Create BranchSelect component in `client/components/github/BranchSelect.tsx`: dropdown fetching GET /api/github/repos/:owner/:repo/branches, shows all branches with default highlighted. On change: emits selected branch name
- [ ] T015 [FE] [US2] Update Add Application form in `client/pages/ServerPage.tsx` and `client/pages/DashboardPage.tsx`: when GitHub connected → show RepoSearch + BranchSelect instead of manual URL/branch inputs. On repo select → auto-populate name, repoUrl, branch. Keep manual fallback toggle ("Enter manually" link). Pass `githubRepo` field to POST /api/servers/:serverId/apps

**Checkpoint**: US2 complete — apps can be created from GitHub repo search

---

## Phase 5: User Story 3 — Commit History & Deploy Target (Priority: P1)

**Goal**: See commits, deploy specific SHA.

**Independent Test**: Open GitHub-linked app → see 20 recent commits with CI status → click Deploy on a commit → deploy runs with that SHA.

- [ ] T016 [FE] [US3] Create CommitList component in `client/components/github/CommitList.tsx`: fetches GET /api/github/repos/:owner/:repo/commits?branch=&count=20, displays list with: message, author, date, short SHA, CI status badge (green/red/yellow/gray). "Deploy" button per commit row. "Refresh" button to invalidate cache. Show "GitHub not connected" fallback
- [ ] T017 [FE] [US3] Update AppPage in `client/pages/AppPage.tsx`: if app has `githubRepo` → show CommitList below deploy section. Deploy button passes selected commit SHA. Update deploy mutation to include optional `commit` field. Keep "Deploy Latest" button for HEAD deploy

**Checkpoint**: US3 complete — commit picker + targeted deploy work

---

## Phase 6: User Story 4 — Branch Switching (Priority: P2)

**Goal**: Switch deploy branch from dropdown.

**Independent Test**: Open GitHub-linked app → see branch dropdown → switch to different branch → commit history updates → deploy uses new branch.

- [ ] T018 [FE] [US4] Update AppPage in `client/pages/AppPage.tsx`: add BranchSelect dropdown next to app name (only when `githubRepo` is set). On branch change → update app branch via PUT /api/apps/:appId { branch } → refetch commit list for new branch. Show current branch as selected

**Checkpoint**: US4 complete — branch switching works

---

## Phase 7: Polish & Cross-Cutting

**Purpose**: Error handling UI, integration tests, graceful degradation

- [ ] T019 [FE] Add inline GitHub warning component in `client/components/github/GitHubWarning.tsx`: reusable banner ("GitHub not connected" / "Rate limit exceeded" / "Token expired — update in Settings"). Use in RepoSearch, CommitList, BranchSelect as fallback when GitHub unavailable
- [ ] T020 [FE] Responsive polish: test SettingsPage, RepoSearch, CommitList, BranchSelect at mobile (375px), tablet (768px), desktop (1280px)
- [ ] T021 [E2E] Integration test in `tests/integration/github.test.ts`: mock GitHub API responses, verify: token validation → connection stored → repo search → branches list → commits list → deploy with SHA → rate limit handling → graceful degradation on disconnect

**Checkpoint**: All features complete, error handling solid, tests passing

---

## Dependency Graph

### Legend

- `→` means "unlocks" (left must complete before right can start)
- `+` means "all of these" (join point)

### Dependencies

```
# Phase 1: Setup
T001 → T004
T002 → T003
T003 → T004

# Phase 2: Foundational
T004 → T005, T006
T005 + T006 → T007
T004 → T008, T009

# Phase 2 → Phase 3: service unlocks UI
T005 → T010, T012
T007 → T011

# Phase 3: Connect GitHub
T012 → T010
T010 → T011

# Phase 3 → Phase 4: connection UI unlocks repo features
T006 + T012 → T013
T006 → T014
T009 + T013 + T014 → T015

# Phase 4 → Phase 5: repo linking unlocks commit features
T006 + T012 → T016
T015 + T016 → T017

# Phase 5 → Phase 6: commit list unlocks branch switching
T014 + T017 → T018

# Phase 7: Polish
T013 + T016 → T019
T010 + T015 + T017 + T018 → T020
T017 + T018 → T021
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
| 1 | [SETUP] → [DB] | T001, T002 → T003 | — |
| 2 | [BE] GitHub service | T004 → T005, T006 → T007 | T001, T003 |
| 3 | [BE] Deploy + Apps extend | T008, T009 | T004 |
| 4 | [FE] Settings page | T010 → T011, T012 | T005 |
| 5 | [FE] Repo + Branch UI | T013, T014 → T015 | T006, T012 |
| 6 | [FE] Commit + Deploy UI | T016 → T017 | T006, T012 |
| 7 | [FE] Branch switch | T018 | T014, T017 |
| 8 | [FE] Polish | T019, T020 | T013, T016 |
| 9 | [E2E] | T021 | T017, T018 |

---

## Agent Summary

| Agent | Task Count | Can Start After |
|-------|-----------|-----------------|
| [SETUP] | 1 | immediately |
| [DB] | 2 | T001 (setup complete) |
| [BE] | 6 | T003 (schema ready) |
| [FE] | 9 | T005 (settings routes ready) |
| [E2E] | 1 | T017 + T018 (all features) |
| **Total** | **21** | — |

**Critical Path**: T001 → T003 → T004 → T006 → T012 → T013 → T015 → T017 → T018

Length: 9 sequential steps (Setup → Schema → GitHub Service → GitHub Routes → Hooks → RepoSearch → Add App Form → Commit + Deploy → Branch Switch)

---

## Implementation Strategy

### MVP First (US1 Only)

1. Complete Phase 1: Setup (T001–T003)
2. Complete Phase 2: Foundational (T004–T009)
3. Complete Phase 3: Connect GitHub (T010–T012)
4. **STOP and VALIDATE**: Settings → paste token → connected → disconnect works
5. Ship as v0.2.0-alpha (GitHub connection only)

### Incremental Delivery

1. v0.2.0-alpha: GitHub connection (US1) → can connect/disconnect
2. v0.2.0-beta: + Repo search + Add app from GitHub (US2) → reduced manual config
3. v0.2.0-rc: + Commit picker + targeted deploy (US3) → full deploy workflow
4. v0.2.0: + Branch switching (US4) + Polish → feature-complete

### Parallel Agent Strategy (Claude Code)

1. **Orchestrator** does T001 (install lru-cache)
2. **database-architect** does T002–T003 (schema + migration) — fast, 2 tasks
3. **backend-specialist** picks up T004–T009 — GitHub service + routes (critical path)
4. **frontend-specialist** starts after T005 — Settings page, then all UI components
5. **test-engineer** kicks in after T017+T018 for integration test

---

## Notes

- `[BE]` handles all backend code AND Zod validation schemas
- `[FE]` handles all React components, hooks, and page modifications
- `[E2E]` handles cross-boundary integration tests only (mocking GitHub API)
- `[DB]` is lightweight (2 tasks) — schema extension + migration
- All BE routes include Zod validation per coding standards
- SHA validation is security-critical — strict regex before any shell execution
- GitHub API responses are typed — never use `as any`
- LRU cache prevents OOM from unbounded growth (max 500 entries)
