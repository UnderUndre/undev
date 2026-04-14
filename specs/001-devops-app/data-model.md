# Data Model: DevOps Dashboard

**Phase 1 output** | **Date**: 2026-04-14

---

## Entities

### Server

Represents a remote machine managed via SSH.

```ts
interface Server {
  id: string;               // UUID
  label: string;            // Human-readable name ("prod-1", "staging")
  host: string;             // SSH host (IP or hostname)
  port: number;             // SSH port (default 22)
  sshUser: string;          // SSH username (e.g., "deploy")
  sshKeyPath: string;       // Path to SSH key inside container (e.g., "/app/.ssh/id_ed25519")
  scriptsPath: string;      // Path to undev scripts on remote server (e.g., "/home/deploy/scripts")
  status: ServerStatus;     // online | offline | unknown
  lastHealthCheck: string;  // ISO 8601
  createdAt: string;        // ISO 8601
}

enum ServerStatus {
  Online = "online",
  Offline = "offline",
  Unknown = "unknown",
}
```

### Application

A deployable project on a server.

```ts
interface Application {
  id: string;               // UUID
  serverId: string;         // FK → Server
  name: string;             // Human-readable name ("underproxy", "api")
  repoUrl: string;          // Git repository URL
  branch: string;           // Default deploy branch
  remotePath: string;       // Path on server ("/home/deploy/underproxy")
  deployScript: string;     // Relative script path ("scripts/deploy/deploy.sh")
  currentCommit?: string;   // Currently deployed commit SHA
  currentVersion?: string;  // Currently deployed version
  envVars: Record<string, string>; // Environment variables for scripts
  createdAt: string;
}
```

### Deployment

A recorded deploy/rollback event.

```ts
interface Deployment {
  id: string;               // UUID
  applicationId: string;    // FK → Application
  serverId: string;         // FK → Server
  userId: string;           // Who triggered it
  type: DeploymentType;     // deploy | rollback
  status: DeploymentStatus;
  branch: string;
  commitBefore: string;     // Commit SHA before deploy
  commitAfter: string;      // Target commit SHA
  startedAt: string;        // ISO 8601
  finishedAt?: string;
  duration?: number;        // Seconds
  logs: string;             // Full log output (stored as text)
  errorMessage?: string;
}

enum DeploymentType {
  Deploy = "deploy",
  Rollback = "rollback",
}

enum DeploymentStatus {
  Pending = "pending",
  Running = "running",
  Success = "success",
  Failed = "failed",
  Cancelled = "cancelled",
}
```

### Backup

A database backup record.

```ts
interface Backup {
  id: string;               // UUID
  serverId: string;         // FK → Server
  databaseName: string;
  filePath: string;         // Path on remote server
  fileSize: number;         // Bytes
  retentionDays: number;
  expiresAt: string;        // ISO 8601
  createdAt: string;
  status: BackupStatus;
}

enum BackupStatus {
  InProgress = "in-progress",
  Complete = "complete",
  Failed = "failed",
  Expired = "expired",
}
```

### HealthSnapshot

Point-in-time server metrics.

```ts
interface HealthSnapshot {
  id: string;
  serverId: string;         // FK → Server
  timestamp: string;        // ISO 8601
  cpuLoadPercent: number;
  memoryPercent: number;
  diskPercent: number;
  swapPercent: number;
  dockerContainers: ContainerInfo[];
  services: ServiceInfo[];
}

interface ContainerInfo {
  name: string;
  status: "running" | "stopped" | "restarting";
  cpuPercent?: number;
  memoryMb?: number;
}

interface ServiceInfo {
  name: string;             // nginx, docker, pm2
  running: boolean;
}
```

### AuditEntry

Log of every user action.

```ts
interface AuditEntry {
  id: string;
  userId: string;
  action: AuditAction;
  targetType: "server" | "application" | "deployment" | "backup";
  targetId: string;
  details?: string;         // JSON string with action-specific data
  result: "success" | "failure";
  timestamp: string;
}

enum AuditAction {
  ServerAdd = "server.add",
  ServerRemove = "server.remove",
  ServerSetup = "server.setup",
  Deploy = "deploy.start",
  DeployCancel = "deploy.cancel",
  Rollback = "rollback.start",
  BackupCreate = "backup.create",
  BackupRestore = "backup.restore",
  DockerCleanup = "docker.cleanup",
  SecurityAudit = "security.audit",
  Login = "auth.login",
  Logout = "auth.logout",
}
```

### User (v1: single admin)

```ts
interface User {
  id: string;
  username: string;
  passwordHash: string;     // bcrypt
  createdAt: string;
  lastLoginAt?: string;
}
```

---

## Relationships

```
User ──1:N──→ AuditEntry
User ──1:N──→ Deployment (triggered by)

Server ──1:N──→ Application
Server ──1:N──→ HealthSnapshot
Server ──1:N──→ Backup

Application ──1:N──→ Deployment

Server ──1:N──→ AuditEntry (target)
Application ──1:N──→ AuditEntry (target)
```

---

## State Machines

### DeploymentStatus

```
pending → running → success
                  → failed
                  → cancelled (from running only)
```

### ServerStatus

```
unknown → online  (after successful health check)
        → offline (after failed SSH connection)
online  → offline (health check fails)
offline → online  (health check succeeds)
```

### BackupStatus

```
in-progress → complete
            → failed
complete    → expired (retention policy cleanup)
```

---

## Indexes

| Table | Index | Purpose |
|-------|-------|---------|
| deployments | (applicationId, startedAt DESC) | Recent deploys per app |
| deployments | (serverId, status) | Active deploys per server (lock check) |
| health_snapshots | (serverId, timestamp DESC) | Latest health per server |
| audit_entries | (timestamp DESC) | Audit trail pagination |
| backups | (serverId, createdAt DESC) | Recent backups per server |
| backups | (expiresAt) | Retention cleanup |
