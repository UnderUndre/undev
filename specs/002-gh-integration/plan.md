# Implementation Plan: GitHub Integration

**Branch**: `002-gh-integration` | **Date**: 2026-04-15 | **Spec**: [spec.md](spec.md)

## Summary

Add GitHub integration to the DevOps Dashboard — connect via Fine-grained PAT, search repositories, list branches/commits, deploy specific commits. Extends the existing Express + React + PostgreSQL stack without new infrastructure.

## Technical Context

**Existing stack** (from 001-devops-app):
- **Backend**: Express 5 + TypeScript + ESM
- **Frontend**: React 19 + Vite 8 + Tailwind CSS v4 + @tanstack/react-query
- **Database**: PostgreSQL 16 via Drizzle ORM (`postgres` driver)
- **Auth**: API key (DASHBOARD_KEY) + session cookies
- **Runtime**: Docker + Docker Compose

**New for this feature**:
- **GitHub API**: REST v3, native `fetch` (no SDK)
- **Caching**: In-memory `Map` with 5-minute TTL
- **Token**: Fine-grained PAT stored in PostgreSQL

## Project Structure (new/modified files)

```
devops-app/
├── server/
│   ├── services/
│   │   └── github.ts            # NEW: GitHub API client + cache
│   ├── routes/
│   │   ├── github.ts            # NEW: GitHub API proxy routes
│   │   └── settings.ts          # NEW: Settings routes (token CRUD)
│   └── db/
│       ├── schema.ts            # MODIFIED: add githubConnection table, extend applications
│       └── migrations/
│           └── 0002_github.sql  # NEW: migration
├── client/
│   ├── pages/
│   │   └── SettingsPage.tsx     # NEW: Settings page
│   ├── components/
│   │   ├── github/
│   │   │   ├── RepoSearch.tsx   # NEW: Repository search/select
│   │   │   ├── BranchSelect.tsx # NEW: Branch dropdown
│   │   │   └── CommitList.tsx   # NEW: Commit history with deploy buttons
│   │   └── layout/
│   │       └── Layout.tsx       # MODIFIED: add Settings link to sidebar
│   ├── hooks/
│   │   └── useGitHub.ts         # NEW: GitHub data hooks
│   └── pages/
│       ├── AppPage.tsx          # MODIFIED: add commit picker, branch switch
│       ├── ServerPage.tsx       # MODIFIED: repo selector in add-app form
│       └── DashboardPage.tsx    # MODIFIED: repo selector in add-app dialog
```

## Key Implementation Notes

**GitHub API client** (`server/services/github.ts`): Thin wrapper around native `fetch` with built-in caching and rate limit handling. All GitHub API calls go through this service — never call GitHub directly from routes.

**Cache strategy**: `Map<url, { data, expiresAt }>`. Search queries are NOT cached (real-time results expected). Branches and commits cached per `owner/repo/branch` key. Manual invalidation via "Refresh" button clears relevant cache entries.

**Rate limit handling**: Service reads `X-RateLimit-Remaining` and `X-RateLimit-Reset` headers from every GitHub response. When remaining = 0, enters cooldown mode — rejects new requests with 429 until reset time. Cooldown state exposed via `GET /api/settings/github/rate-limit`.

**SHA validation**: Before passing commit SHA to deploy process, validate with strict regex `^[0-9a-f]{7,40}$`. This prevents command injection via malformed SHA values.

**Graceful degradation**: Every GitHub-dependent UI component checks connection status. If token invalid/missing/rate-limited → show inline warning, hide GitHub-specific controls, keep manual deploy working.

## Complexity Tracking

| Addition | Why Needed | Simpler Alternative Rejected |
|----------|-----------|------------------------------|
| In-memory cache | Avoid hitting rate limits with repeated page loads | No cache → 5000 req/hr limit burns fast |
| GitHub service (not SDK) | 5 endpoints, native fetch is 0 deps | @octokit/rest → 2MB, 20+ deps |
| Fine-grained PAT | Read-only scoped access, principle of least privilege | Classic `repo` PAT → full write access |
| Settings page | GitHub token management, future extensibility | Hardcode token in env → can't disconnect from UI |
