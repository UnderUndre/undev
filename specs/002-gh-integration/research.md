# Research: GitHub Integration

**Phase 0 output** | **Date**: 2026-04-15

---

## R-001: GitHub API Authentication — Fine-grained PAT

**Decision**: Use Fine-grained Personal Access Tokens (not classic tokens).

**Rationale**: Classic `repo` scope grants full read+write access to all repositories — overkill for a read-only dashboard. Fine-grained PATs allow scoping to specific permissions (Contents: read, Metadata: read, Commit statuses: read) and even specific repositories. This follows the principle of least privilege.

**Key details**:
- Fine-grained PATs are GA as of 2024
- Token format: `github_pat_*` (vs classic `ghp_*`)
- API validation: `GET /user` with `Authorization: Bearer <token>` returns user info
- Fine-grained PATs send `X-OAuth-Scopes` header differently — use `GET /user` response to verify access
- Token can be scoped to specific repos or all repos
- Expiration: configurable (30 days to 1 year), dashboard must handle expired tokens

**Alternatives considered**:
- **Classic PAT with `repo` scope**: Simpler but dangerous — full write access. Rejected per security review.
- **OAuth App flow**: Redirect dance, requires Client ID/Secret, callback URL. Overkill for single-admin self-hosted.
- **GitHub App**: Most secure (installation-based access) but requires app registration, webhook endpoint, JWT flow. Way overkill for v1.

---

## R-002: GitHub REST API vs GraphQL

**Decision**: REST API v3 — simpler, sufficient for our needs.

**Rationale**: We need 4 endpoints: user info, repo search, branches list, commits list. REST API covers all with simple GET requests. GraphQL would reduce request count (batch queries) but adds complexity (query construction, pagination cursors) for minimal benefit at our scale.

**Key endpoints**:
- `GET /user` — validate token, get username + avatar
- `GET /search/repositories?q=user:USERNAME+QUERY` — search repos (30 results per page)
- `GET /repos/{owner}/{repo}/branches` — list branches
- `GET /repos/{owner}/{repo}/commits?sha={branch}&per_page=20` — recent commits
- `GET /repos/{owner}/{repo}/commits/{sha}/status` — CI status (combined)

**Rate limits**:
- REST API: 5,000 requests/hour for authenticated users
- Search API: 30 requests/minute (separate limit!)
- Headers: `X-RateLimit-Remaining`, `X-RateLimit-Reset` (Unix timestamp)

**Alternatives considered**:
- **GraphQL API v4**: Fewer requests (fetch repos + branches in one query). But adds `@octokit/graphql` dependency, query complexity, cursor pagination. Not worth it for 4 endpoints.

---

## R-003: Server-side Caching Strategy

**Decision**: LRU cache with 5-minute TTL and max 500 entries, keyed by request URL.

**Rationale**: GitHub data (repos, branches, commits) doesn't change every second. Caching for 5 minutes reduces API calls by ~60x during active use. In-memory is sufficient — dashboard is single-instance, cache loss on restart is acceptable (cold start just means one extra API call). LRU eviction prevents unbounded memory growth from diverse queries.

**Implementation**:
- LRU cache (e.g. `lru-cache` package or simple LRU implementation) with `max: 500` entries and `ttl: 5 * 60 * 1000`
- Cache key = full GitHub API URL
- Manual invalidation via "Refresh" button (deletes cache entry, re-fetches)
- Search queries NOT cached (user expects real-time search results)
- Branches and commits cached per repo/branch combination

**Alternatives considered**:
- **Unbounded `Map`**: Simpler but risks OOM if many unique URLs are queried (scrapers, diverse commits). Rejected per code review.
- **Redis**: Persistent cache, but adds infrastructure. Overkill for single-instance dashboard.
- **No cache**: Hit rate limits quickly with multiple page navigations. Rejected.
- **Database cache**: Adds schema complexity for ephemeral data. Rejected.

---

## R-004: GitHub API Client Architecture

**Decision**: Thin wrapper service (`server/services/github.ts`) using native `fetch`.

**Rationale**: We only need 5 REST endpoints. `@octokit/rest` is 2MB+ and brings 20+ dependencies for features we don't use (pagination helpers, plugin system, webhooks). Native `fetch` with a small wrapper is cleaner and has zero dependencies.

**Architecture**:
```
github.ts (service)
├── validateToken(token) → { user, avatar }
├── searchRepos(query) → Repository[]
├── getBranches(owner, repo) → Branch[]
├── getCommits(owner, repo, branch, count) → Commit[]
└── getCommitStatus(owner, repo, sha) → Status
```

Each method:
1. Check cache → return if fresh
2. Call GitHub API with `Authorization: Bearer <token>`
3. Handle rate limits (read `X-RateLimit-*` headers)
4. Cache response (except search)
5. Return typed result

**Alternatives considered**:
- **@octokit/rest**: Official SDK, great for complex integrations. But 2MB+ bundle, 20+ deps for 5 endpoints. Rejected.
- **@octokit/core**: Lighter but still adds dependency for something native `fetch` handles.

---

## R-005: Token Storage Security

**Decision**: Store PAT as plain text in PostgreSQL (same as SSH keys, DASHBOARD_KEY).

**Rationale**: The dashboard already stores SSH private keys and the admin API key in plain text in PostgreSQL. Adding encryption for just the GitHub token would be inconsistent. The real security boundary is PostgreSQL access — if an attacker can read the database, they already have SSH keys which are more dangerous than a read-only GitHub token.

**TODO (v2 — separate spec)**: Implement encryption at rest for ALL secrets (SSH keys, GitHub PAT, DASHBOARD_KEY) with a master key from environment variable. This is a cross-cutting concern that should be addressed holistically, not per-secret. Track as `specs/003-secrets-encryption`.

**Alternatives considered**:
- **Encrypted with master key**: More secure. Deferred to v2 as cross-cutting concern — encrypting only GitHub token while SSH keys stay plain text is security theater.
- **Environment variable only**: Would require restart to change token. Rejected — admin should be able to connect/disconnect from UI.
