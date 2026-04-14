# API Contract: DevOps Dashboard

**Version**: 1.0

## Base URL

```
http://localhost:3000/api
```

## Authentication

All endpoints except `POST /api/auth/login` require a valid session cookie.

```
POST /api/auth/login    { username, password } → { user }  (sets httpOnly cookie)
POST /api/auth/logout   → 204
GET  /api/auth/me       → { user } | 401
```

---

## Servers

```
GET    /api/servers                        → Server[]
POST   /api/servers                        { label, host, port, sshUser, sshKeyPath, scriptsPath } → Server
GET    /api/servers/:id                    → Server
PUT    /api/servers/:id                    { label, host, ... } → Server
DELETE /api/servers/:id                    → 204
POST   /api/servers/:id/verify             → { status: "online"|"offline", latencyMs }
POST   /api/servers/:id/setup              { tasks: string[] } → { jobId }  (async, stream via WS)
```

## Applications

```
GET    /api/servers/:serverId/apps         → Application[]
POST   /api/servers/:serverId/apps         { name, repoUrl, branch, remotePath, deployScript } → Application
GET    /api/apps/:id                       → Application
PUT    /api/apps/:id                       { name, branch, ... } → Application
DELETE /api/apps/:id                       → 204
```

## Deployments

```
POST   /api/apps/:appId/deploy            { branch?, commit? } → { deploymentId, jobId }  (async)
POST   /api/apps/:appId/rollback           { targetCommit? } → { deploymentId, jobId }  (async)
POST   /api/deployments/:id/cancel         → { status }
GET    /api/apps/:appId/deployments        ?limit=20&offset=0 → { items: Deployment[], total }
GET    /api/deployments/:id                → Deployment (includes logs)
```

## Database Backups

```
GET    /api/servers/:serverId/backups      → Backup[]
POST   /api/servers/:serverId/backups       { databaseName } → { backupId, jobId }  (async)
POST   /api/backups/:id/restore            → { jobId }  (async, requires confirmation header)
DELETE /api/backups/:id                    → 204
```

Restore requires header: `X-Confirm-Destructive: true`

## Health

```
GET    /api/servers/:serverId/health        → HealthSnapshot (latest)
GET    /api/servers/:serverId/health/history ?hours=24 → HealthSnapshot[]
POST   /api/servers/:serverId/health/refresh → HealthSnapshot (force immediate check)
```

## Docker

```
GET    /api/servers/:serverId/docker        → { diskUsage, containers: ContainerInfo[] }
POST   /api/servers/:serverId/docker/cleanup { mode: "safe"|"aggressive" } → { jobId }
```

## Security Audit

```
POST   /api/apps/:appId/audit              → { jobId }  (async)
GET    /api/apps/:appId/audits             → AuditResult[]
GET    /api/audits/:id                     → AuditResult (detailed)
```

## Logs

```
GET    /api/servers/:serverId/logs/sources  → string[] ("pm2", "docker", "nginx-access", "nginx-error")
```

Log streaming is WebSocket-only (see ws.md).

## Audit Trail

```
GET    /api/audit-trail                    ?limit=50&offset=0&targetType=&action= → { items: AuditEntry[], total }
```

---

## Async Jobs

Operations that execute scripts (deploy, backup, restore, setup, cleanup, audit) are async:
- The REST endpoint returns `{ jobId }` immediately
- Progress is streamed via WebSocket (see ws.md)
- Final result is stored in the database and accessible via GET

## Error Format

```json
{
  "error": {
    "code": "DEPLOYMENT_LOCKED",
    "message": "Another deployment is in progress on this server",
    "details": { "lockedBy": "admin", "since": "2026-04-14T12:00:00Z" }
  }
}
```

## HTTP Status Codes

| Code | When |
|------|------|
| 200 | Success (GET, PUT) |
| 201 | Created (POST) |
| 204 | Deleted (DELETE) |
| 400 | Validation error |
| 401 | Not authenticated |
| 404 | Resource not found |
| 409 | Conflict (deployment locked, backup in progress) |
| 500 | Internal error |
