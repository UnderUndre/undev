# Implementation Plan: Scan Server for Existing Repositories and Docker Apps

**Branch**: `003-scan-for-repos` | **Date**: 2026-04-20 | **Spec**: [spec.md](spec.md)

## Summary

Add a server-side scanner that uses the dashboard's existing SSH connection to discover already-deployed git repositories and Docker apps, then lets admins import each candidate into the `applications` table with one click and pre-filled fields. No new runtime infrastructure, no new auth surface — all logic sits behind `POST /api/servers/:id/scan`, reusing `sshPool`, the existing session auth, and the existing Add Application form.

The only deploy-contract change is that scan-imported applications must **not** re-clone on first deploy — the existing working tree is the source of truth. The rest of the feature is additive: new route, new service, new modal, one extra (optional) field on the apps POST payload.

## Technical Context

**Existing stack** (from `001-devops-app`, extended by `002-gh-integration`):
- **Backend**: Express 5 + TypeScript + ESM
- **SSH**: `ssh2` via `server/services/ssh-pool.ts` — pooled connections per server, `exec()` with timeout, `execStream()` with `kill()`
- **Frontend**: React 19 + Vite 8 + Tailwind v4 + `@tanstack/react-query`
- **Database**: PostgreSQL 16 via Drizzle ORM — `applications` table already has `name`, `repoUrl`, `branch`, `remotePath`, `deployScript`, `envVars`, `githubRepo`, `currentCommit`
- **Auth**: API key + session cookies (`middleware/auth.ts`)
- **GitHub**: `server/services/github.ts` exports a URL normaliser already used by apps routes

**New for this feature**:
- **Scanner service**: new `server/services/scanner.ts` — composes SSH commands, parses output, deduplicates against DB
- **Scan route**: new `POST /api/servers/:id/scan` in a dedicated `routes/scan.ts`
- **UI**: new `components/scan/ScanModal.tsx`, reuses existing Add Application form for import
- **Deploy-contract change**: scan-imported apps get a database flag so the deploy runner picks the "existing working tree" path (`fetch` + `reset --hard`) instead of `git clone`

**Open unknowns** (resolved in `research.md`):
- Scan traversal strategy (single SSH command vs many) → R-001
- Docker detection without new tooling → R-002
- How to mark "do not clone on first deploy" in schema → R-003
- Cancellation semantics across client abort and SSH → R-004
- Schema relaxation for Docker-only apps (empty `repoUrl`) → R-005

## Project Structure (new/modified files)

```
devops-app/
├── server/
│   ├── services/
│   │   ├── scanner.ts             # NEW: scan orchestration, output parsing, dedup
│   │   └── ssh-pool.ts            # UNCHANGED: used as-is (exec + execStream)
│   ├── routes/
│   │   ├── scan.ts                # NEW: POST /api/servers/:id/scan
│   │   └── apps.ts                # MODIFIED: accept `source: "scan"` and `skipInitialClone`
│   ├── db/
│   │   ├── schema.ts              # MODIFIED: applications.skipInitialClone boolean (default false)
│   │   └── migrations/
│   │       └── 0003_scan.sql      # NEW: ALTER TABLE applications ADD COLUMN skip_initial_clone
│   └── index.ts                   # MODIFIED: mount scanRouter
├── client/
│   ├── components/
│   │   └── scan/
│   │       ├── ScanModal.tsx      # NEW: scan trigger, progress, result list, cancel
│   │       ├── GitCandidateRow.tsx # NEW: renders one git candidate
│   │       └── DockerCandidateRow.tsx # NEW: renders one docker candidate
│   ├── hooks/
│   │   └── useScan.ts             # NEW: react-query mutation wrapping POST /scan + abort controller
│   └── pages/
│       └── ServerPage.tsx         # MODIFIED: add "Scan Server" button + modal wiring
└── tests/
    ├── unit/
    │   └── scanner.test.ts        # NEW: output parsing, dedup logic
    └── integration/
        └── scan-route.test.ts     # NEW: route with mocked sshPool
```

No new npm dependencies.

## Key Implementation Notes

**Scanner service** (`server/services/scanner.ts`):
- Single entrypoint: `async scan(serverId, roots): Promise<ScanResult>`
- Builds one shell pipeline composed of: probe `command -v git/docker`, one `find` invocation with `-maxdepth 6` and prune rules, a batched loop that cats git metadata for each found `.git`, and `docker ps --format` / compose file list
- All output is emitted on stdout using a line-prefixed protocol (e.g. `GIT\t/path\tbranch\tsha\tdirty`, `COMPOSE\t/path`, `CONTAINER\t<json>`) so parsing is a trivial line-by-line split
- Single `sshPool.execStream()` call used so the scan is cancellable via `kill()` when the HTTP request is aborted
- 60s hard timeout set via `setTimeout` in the route; expiry kills the stream and returns `{ partial: true, ... }` with whatever lines arrived

**Route** (`server/routes/scan.ts`):
- Registers an `AbortController` tied to `req.on("close")`; abort triggers `kill()` on the stream
- Reuses `authRequired` middleware — no new auth surface
- Loads the server's existing SSH config from DB, ensures connection via `sshPool.connect()` (already idempotent)
- Dedup pass runs after collection: fetches all `applications` for the server once, walks candidates once — O(n+m) map lookup

**Deploy contract change** (`skipInitialClone`):
- New boolean column on `applications`, default `false`
- When a scan import sets it to `true`, the deploy runner takes the `fetch`+`reset --hard FETCH_HEAD` path instead of `clone` (no explicit checkout — FETCH_HEAD avoids failures on local divergence)
- For Docker-only imports, the flag is also `true` AND `repoUrl` is the synthetic sentinel `docker://<abs-path>` (see R-005) — the deploy runner recognises `docker://` and skips all git operations
- Existing manual-add flow is unaffected (flag stays `false`, behaviour unchanged)

**Schema relaxation for Docker-only** (see R-005):
- `createAppSchema` in `routes/apps.ts` stays strict: `repoUrl.min(1)`, `branch.min(1)`. Docker-only candidates satisfy this by passing `docker://<path>` and `branch: "-"`. No schema change needed — we keep the invariant "every app has a repoUrl and branch" and use the sentinel as the escape hatch
- This also means: no conditional validation, no polymorphic app type — simpler tests and UI

**Security**:
- All SSH commands are built from whitelisted root paths in the server config. The user's browser never sends a path that becomes a shell fragment — root paths come from the DB column `servers.scanRoots` (new) and are validated on write
- Candidate paths echoed back are treated as untrusted in the backend: used only as literal `git -C <path>` arguments quoted with single quotes and a single-quote escape (`'` → `'\''`)
- Permission-denied paths are skipped with `2>/dev/null`, not surfaced

**Performance target** (SC-002 — 200 candidates under 15s):
- One SSH session = one TCP handshake + one auth. Sequential per-candidate `sshPool.exec` would be ~100ms each × 200 = 20s just in round-trips. The batched pipeline avoids this by design
- Parsing happens in Node after the stream ends — no structured JSON from the server, just tab-separated lines

**Cancellation**:
- Client aborts an in-flight `fetch` via `AbortController` from `useScan`
- Server's `req.on("close")` fires → route invokes `kill()` on the SSH stream → `SIGKILL` sent to the remote shell → shell exits within ~1s
- SC-003 (no orphaned processes) is met because the scan pipeline is a single `bash -c` invocation, and killing the SSH channel kills the remote shell which reaps its children via normal POSIX rules

## Constitution Check

No `.specify/memory/constitution.md` is present in this repository. Applying the project-level constitution stand-ins from `CLAUDE.md`:

| Principle | Status | Note |
|---|---|---|
| No commits/pushes without request | ✅ | Plan only, no git operations |
| No new packages without approval | ✅ | Zero new npm dependencies |
| No `--force` / bypass flags | ✅ | N/A — no destructive shell flags in scanner |
| No secrets in code/logs | ✅ | Scanner logs paths and branch names; no tokens touched |
| No direct DB migrations | ✅ | `0003_scan.sql` will be generated for review, not run by scanner |
| No destructive ops without consent | ✅ | Scanner is read-only on the server; import requires admin click |
| Plan-first if >3 files changed | ✅ | This plan lists all files |
| Check context7 before unfamiliar API | ✅ | `ssh2` and Drizzle are already in use; no new libraries |

No gate violations. Proceed to Phase 2 (tasks).

## Complexity Tracking

| Addition | Why Needed | Simpler Alternative Rejected |
|---|---|---|
| `scanner.ts` service | Keeps route thin, makes output parsing unit-testable in isolation | Inline everything in route → untestable without SSH mocks at HTTP layer |
| `skipInitialClone` column | Scan-imports must reuse existing working tree (FR-052) | Detect at deploy time by probing the remote path → flaky and requires another SSH round-trip per deploy |
| `docker://<path>` sentinel in `repoUrl` | Keeps `applications` shape uniform, avoids polymorphic type | Nullable `repoUrl` → every consumer needs null-handling, broader blast radius |
| Single `execStream` pipeline (not many `exec` calls) | Hits SC-002 (15s / 200 candidates) and SC-003 (clean cancellation) | Parallel `exec` per root → ssh2 channel limits, harder to cancel cleanly |
| New `routes/scan.ts` instead of extending `routes/servers.ts` | Keeps routing files single-purpose, matches house pattern (`github.ts`, `docker.ts`) | Inline in servers.ts → file grows beyond 300 lines, harder to test |

## Out of Plan

These are explicit non-goals for this implementation (mirrors spec § Out of Scope):

- No cron / scheduled re-scan
- No bulk import (one candidate at a time)
- No Kubernetes / systemd / PM2 detection
- No `.env` import
- No drift reconciliation after import
