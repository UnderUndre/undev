# API Contract: Scan Server for Existing Repositories and Docker Apps

**Version**: 1.0

## Base URL

```
http://localhost:3000/api
```

All endpoints require valid session cookie (existing `authRequired` middleware) and admin role.

---

## Scan

```
POST /api/servers/:serverId/scan    → ScanResult
```

### POST /api/servers/:serverId/scan

Runs a one-shot discovery pass on the target server over the existing SSH connection. Not persisted. Cancellable by aborting the HTTP request.

**Request**: empty body.

**Response** (200):

```json
{
  "gitAvailable": true,
  "dockerAvailable": true,
  "partial": false,
  "durationMs": 4821,
  "gitCandidates": [
    {
      "path": "/opt/my-app",
      "remoteUrl": "git@github.com:acme/my-app.git",
      "githubRepo": "acme/my-app",
      "branch": "main",
      "commitSha": "9b1c3f4aa0c7e1e3d2f1b6a4c8e2d7b5a3c1f4e9",
      "commitSubject": "fix: retry queue flush",
      "commitDate": "2026-04-19T18:42:01+00:00",
      "dirty": false,
      "suggestedDeployScripts": ["/opt/my-app/scripts/deploy.sh"],
      "alreadyImported": false,
      "existingApplicationId": null
    }
  ],
  "dockerCandidates": [
    {
      "kind": "compose",
      "path": "/srv/stack/docker-compose.yml",
      "name": "stack",
      "services": [
        { "name": "api", "image": "ghcr.io/acme/api:1.4.0", "running": true },
        { "name": "db",  "image": "postgres:16",            "running": true }
      ],
      "alreadyImported": true,
      "existingApplicationId": "app_01HT..."
    }
  ]
}
```

**Error** (503) — SSH unreachable:

```json
{
  "error": {
    "code": "SSH_UNREACHABLE",
    "message": "Server unreachable — check SSH credentials"
  }
}
```

**Error** (403) — non-admin:

```json
{
  "error": { "code": "FORBIDDEN", "message": "Admin role required" }
}
```

**Error** (409) — scan already in progress on this server (FR-074):

```json
{
  "error": {
    "code": "SCAN_IN_PROGRESS",
    "message": "Another scan is already running on this server",
    "since": "2026-04-20T14:30:12Z",
    "byUserId": "usr_01HT..."
  }
}
```

**Notes**:
- 60 s hard timeout on the server side. If exceeded, response still returns 200 with `partial: true` and whatever was collected.
- Client may abort the request; the backend kills the remote scan within ~2 s (FR-062).
- No response body caching — always fresh.

---

## Applications (extended)

The existing create endpoint is extended with two optional fields. No new endpoint is added.

```
POST /api/servers/:serverId/apps    { ...createAppSchema, source?, skipInitialClone? } → Application
```

### Extensions to request body

| Field | Type | Default | Meaning |
|---|---|---|---|
| `source` | `"manual" \| "scan"` | `"manual"` | Audit tag; when `"scan"`, backend sets `skipInitialClone: true` |
| `skipInitialClone` | `boolean` | `false` | Ignored unless `source === "scan"`; scan-imports always set `true` |

Admins cannot toggle `skipInitialClone` from the normal form — it is only honoured when `source === "scan"`.

### Docker-only import payload shape

For Docker-only candidates the client posts:

```json
{
  "name": "stack",
  "repoUrl": "docker:///srv/stack/docker-compose.yml",
  "branch": "-",
  "remotePath": "/srv/stack",
  "deployScript": "/srv/stack/deploy.sh",
  "githubRepo": null,
  "source": "scan"
}
```

The `repoUrl` prefix `docker://` is the deploy runner's signal to skip git operations entirely.

---

## Server scanRoots (extended)

The existing server CRUD accepts one new field. No new endpoint.

```
POST   /api/servers        { ...createServerSchema, scanRoots? } → Server
PATCH  /api/servers/:id    { ...updateServerSchema, scanRoots? } → Server
```

### Field

| Field | Type | Constraints | Default |
|---|---|---|---|
| `scanRoots` | `string[]` | Each: absolute path, ≤512 chars, no shell metacharacters. Array length ≤ 20 | `["/opt","/srv","/var/www","/home"]` (column-level default). On insert, the backend appends the server's `scriptsPath` when set and not already present — so an API consumer observing `GET /api/servers/:id` right after creation may see a 5-element list. |

This two-step default (DB column default + backend append) is deliberate: PostgreSQL column defaults cannot reference another column's value at insert time, so `scriptsPath` is appended at the application layer. Both `data-model.md` and this contract describe the same behaviour from different angles.

### Validation error (400)

```json
{
  "error": {
    "code": "INVALID_SCAN_ROOT",
    "message": "scanRoots[2] contains shell metacharacters"
  }
}
```

Or (FR-073):

```json
{
  "error": {
    "code": "NON_LOCAL_FS",
    "message": "scanRoots[1] '/mnt/nfs' resides on filesystem type 'nfs4' — non-local filesystems are not supported"
  }
}
```

---

## Error Envelope

All errors follow the existing house shape:

```json
{
  "error": {
    "code": "UPPER_SNAKE",
    "message": "human-readable explanation"
  }
}
```

New codes introduced by this feature:

| Code | HTTP | Meaning |
|---|---|---|
| `SSH_UNREACHABLE` | 503 | `sshPool.connect()` or `execStream` failed before any output arrived |
| `INVALID_SCAN_ROOT` | 400 | `scanRoots` entry failed syntactic validation on server create/update |
| `NON_LOCAL_FS` | 400 | `scanRoots` entry resides on a non-local filesystem (nfs/cifs/smbfs/fuse.sshfs) — FR-073 |
| `SCAN_IN_PROGRESS` | 409 | Another scan is already running on this server — FR-074 |
| `SCAN_TIMEOUT` | — | Not an error — returned as `partial: true` in 200 body |
