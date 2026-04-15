# API Contract: GitHub Integration

**Version**: 1.0

## Base URL

```
http://localhost:3000/api
```

All endpoints require valid session cookie (existing auth).

---

## Settings / GitHub Connection

```
GET    /api/settings/github              → GitHubConnection | null
POST   /api/settings/github              { token } → GitHubConnection
DELETE /api/settings/github              → 204
GET    /api/settings/github/rate-limit   → GitHubRateLimit
```

### POST /api/settings/github

Validates the token by calling GitHub API (`GET /user`). If valid, stores connection and returns user info. If invalid, returns 400.

**Request**:
```json
{ "token": "github_pat_..." }
```

**Response** (201):
```json
{
  "username": "UnderUndre",
  "avatarUrl": "https://avatars.githubusercontent.com/u/...",
  "tokenExpiresAt": "2027-04-15T00:00:00Z",
  "connectedAt": "2026-04-15T12:00:00Z"
}
```

**Error** (400):
```json
{
  "error": {
    "code": "INVALID_TOKEN",
    "message": "GitHub token is invalid or expired"
  }
}
```

### GET /api/settings/github/rate-limit

**Response**:
```json
{
  "remaining": 4832,
  "limit": 5000,
  "resetAt": "2026-04-15T13:00:00Z"
}
```

---

## GitHub Repositories

```
GET    /api/github/repos?q=<search>      → GitHubRepository[]
GET    /api/github/repos/:owner/:repo/branches  → GitHubBranch[]
GET    /api/github/repos/:owner/:repo/commits?branch=<name>&count=20  → GitHubCommit[]
```

### GET /api/github/repos

Search repositories. Query parameter `q` is required (min 2 chars). Returns top 30 matches.

**Response**:
```json
[
  {
    "fullName": "UnderUndre/undev",
    "name": "undev",
    "owner": "UnderUndre",
    "isPrivate": false,
    "defaultBranch": "main",
    "updatedAt": "2026-04-15T10:00:00Z",
    "description": "Dev scripts and configs"
  }
]
```

**Error when GitHub not connected** (400):
```json
{
  "error": {
    "code": "GITHUB_NOT_CONNECTED",
    "message": "Connect GitHub in Settings first"
  }
}
```

**Error when rate limited** (429):
```json
{
  "error": {
    "code": "GITHUB_RATE_LIMITED",
    "message": "GitHub API rate limit exceeded",
    "details": { "resetAt": "2026-04-15T13:00:00Z" }
  }
}
```

### GET /api/github/repos/:owner/:repo/branches

**Response**:
```json
[
  { "name": "main", "isDefault": true },
  { "name": "develop", "isDefault": false },
  { "name": "feature/new-thing", "isDefault": false }
]
```

### GET /api/github/repos/:owner/:repo/commits

**Query params**: `branch` (required), `count` (default 20, max 100)

**Response**:
```json
[
  {
    "sha": "abc123def456...",
    "shortSha": "abc123d",
    "message": "feat: add user auth",
    "author": "UnderUndre",
    "date": "2026-04-15T09:30:00Z",
    "status": "success"
  }
]
```

`status` is `null` if no CI configured, otherwise `"success"` | `"failure"` | `"pending"`.

---

## Modified Endpoints

### POST /api/servers/:serverId/apps (extended)

New optional field `githubRepo`:

```json
{
  "name": "my-api",
  "repoUrl": "https://github.com/UnderUndre/my-api",
  "branch": "main",
  "remotePath": "/home/deploy/my-api",
  "deployScript": "scripts/deploy.sh",
  "githubRepo": "UnderUndre/my-api"
}
```

`githubRepo` is nullable — omit for non-GitHub apps.

### POST /api/apps/:appId/deploy (extended)

New optional field `commit`:

```json
{
  "branch": "main",
  "commit": "abc123def456"
}
```

`commit` must match `^[0-9a-f]{7,40}$` — validated before passing to SSH. If omitted, deploys HEAD.

---

## Error Codes (new)

| Code | HTTP | When |
|------|------|------|
| GITHUB_NOT_CONNECTED | 400 | No GitHub token configured |
| INVALID_TOKEN | 400 | Token validation failed |
| GITHUB_RATE_LIMITED | 429 | Rate limit exceeded |
| GITHUB_API_ERROR | 502 | GitHub API returned error |
| INVALID_SHA | 400 | Commit SHA failed validation |
