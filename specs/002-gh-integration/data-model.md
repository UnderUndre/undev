# Data Model: GitHub Integration

**Phase 1 output** | **Date**: 2026-04-15

---

## New Entity

### GitHubConnection

Singleton — one row per dashboard instance (enforced by `id = 'DEFAULT'` constraint). Stores the connected GitHub account.

```ts
interface GitHubConnection {
  id: string;              // Always 'DEFAULT' — enforced by CHECK constraint
  token: string;           // Fine-grained PAT value
  username: string;        // GitHub username (from /user API)
  avatarUrl: string;       // GitHub avatar URL
  tokenExpiresAt: string;  // ISO 8601 — parsed from GitHub response header
  connectedAt: string;     // ISO 8601
}
```

**Lifecycle**:
```
(empty) → connected (token saved + validated)
connected → disconnected (token deleted, row removed)
connected → invalid (token expired/revoked, detected on API call)
invalid → connected (admin pastes new token)
```

---

## Extended Entity

### Application (existing, add field)

Add nullable `githubRepo` field to link applications to GitHub repositories.

```ts
// Added to existing Application interface:
interface Application {
  // ... existing fields ...
  githubRepo: string | null;  // "owner/repo" format, null for non-GitHub apps
}
```

**Rules**:
- `githubRepo` is set when app is created from GitHub repo selector
- `githubRepo` is null when app is created via manual URL entry
- When `githubRepo` is set, dashboard can fetch branches/commits from GitHub API
- When GitHub is disconnected, `githubRepo` stays in DB but GitHub features are hidden

---

## Transient Types (from GitHub API, not stored in DB)

### GitHubRepository

```ts
interface GitHubRepository {
  fullName: string;        // "owner/repo"
  name: string;            // "repo"
  owner: string;           // "owner"
  isPrivate: boolean;
  defaultBranch: string;   // "main"
  updatedAt: string;       // ISO 8601
  description: string | null;
}
```

### GitHubBranch

```ts
interface GitHubBranch {
  name: string;            // "main", "develop", "feature/xyz"
  isDefault: boolean;
}
```

### GitHubCommit

```ts
interface GitHubCommit {
  sha: string;             // Full 40-char SHA
  shortSha: string;        // First 7 chars
  message: string;         // First line only
  author: string;          // Author name
  date: string;            // ISO 8601
  status: CommitStatus | null;
}

type CommitStatus = "success" | "failure" | "pending" | null;
```

### GitHubRateLimit

```ts
interface GitHubRateLimit {
  remaining: number;       // Requests remaining
  limit: number;           // Total limit (usually 5000)
  resetAt: string;         // ISO 8601 when limit resets
}
```

---

## Database Migration

### 0002_github.sql

```sql
-- GitHub connection (singleton — enforced by CHECK constraint)
CREATE TABLE IF NOT EXISTS "github_connection" (
  "id" text PRIMARY KEY CHECK ("id" = 'DEFAULT'),
  "token" text NOT NULL,
  "username" text NOT NULL,
  "avatar_url" text NOT NULL,
  "token_expires_at" text,
  "connected_at" text NOT NULL
);

-- Extend applications with GitHub repo reference
ALTER TABLE "applications" ADD COLUMN IF NOT EXISTS "github_repo" text;
```

**Singleton pattern**: `INSERT INTO github_connection (id, ...) VALUES ('DEFAULT', ...) ON CONFLICT (id) DO UPDATE SET ...` — guarantees exactly one row. The `CHECK` constraint prevents inserting with any other ID.

---

## Indexes

No new indexes needed — `github_connection` is a singleton table (1 row), and `github_repo` on `applications` is not queried independently (always accessed via application ID).
