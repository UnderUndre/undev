# Feature Specification: DevOps Dashboard

**Version**: 1.2 | **Status**: Approved | **Date**: 2026-04-14

## Problem Statement

Managing VPS deployments, database backups, server health, and other DevOps operations through terminal-only bash scripts is fragmented and error-prone. There is no unified interface to execute operations, view real-time logs, monitor server state, or roll back deployments. Each operation requires SSH access, knowledge of script locations, correct environment variables, and manual monitoring of output.

Teams and solo developers need a centralized, browser-accessible control panel that wraps existing proven bash scripts with a visual interface — preserving the reliability of the scripts while adding visibility, access control, and auditability.

## User Scenarios

### US-001: Deploy Application to Production

**Actor**: Developer
**Precondition**: Application code is committed and pushed to the target branch.

1. Developer opens the dashboard in a browser
2. Developer selects the target server and application
3. Dashboard shows current deployment state (branch, commit, version, last deploy time)
4. Developer clicks "Deploy"
5. Dashboard runs pre-flight checks (SSH connectivity, disk space, git status)
6. Dashboard executes the deploy script with zero-downtime strategy (start-before-stop)
7. Developer sees real-time log output streamed in the browser
8. On success: dashboard shows green status, new commit/version, and notifies via configured channels
9. On failure: dashboard shows red status with error context, offers rollback button

### US-002: Rollback Deployment

**Actor**: Developer
**Precondition**: At least one previous successful deployment exists.

1. Developer sees failed deployment or broken production
2. Developer clicks "Rollback" and selects target version (previous or specific commit)
3. Dashboard executes rollback script
4. Developer sees real-time rollback progress
5. On success: previous version restored, status updated

### US-003: Database Backup and Restore

**Actor**: Developer / DBA
**Precondition**: PostgreSQL database is accessible.

1. Developer navigates to Database section
2. Dashboard shows list of existing backups with size, date, retention status
3. Developer can:
   - Trigger manual backup (one click)
   - Download a backup file
   - Restore from a specific backup (with confirmation dialog)
   - Configure automated backup schedule
4. Real-time progress shown during backup/restore operations

### US-004: Monitor Server Health

**Actor**: Developer / Ops
**Precondition**: Server is reachable via SSH.

1. Developer opens the server's dashboard page
2. Dashboard displays current metrics: CPU load, memory, disk usage, swap, running services
3. Metrics auto-refresh on configurable interval
4. Thresholds trigger visual warnings (yellow > 80%, red > 90%)
5. Docker container status shown (running/stopped, resource usage per container)

### US-005: Tail Production Logs

**Actor**: Developer
**Precondition**: Application is deployed and running.

1. Developer navigates to Logs section
2. Developer selects log source: application (pm2/docker), nginx access, nginx error
3. Dashboard streams logs in real-time via WebSocket
4. Developer can filter/search within the log stream
5. Developer can pause/resume streaming

### US-006: Run Security Audit

**Actor**: Developer / Security Lead
**Precondition**: Application codebase is accessible.

1. Developer navigates to Security section
2. Developer clicks "Run Audit"
3. Dashboard executes the security audit script
4. Results displayed: npm vulnerabilities, outdated deps, hardcoded secrets found/not found
5. Severity badges (critical, high, medium, low)

### US-007: Setup New Server

**Actor**: DevOps Engineer
**Precondition**: Fresh VPS accessible via root SSH.

1. Engineer navigates to Servers section
2. Clicks "Add Server" — enters IP, SSH credentials
3. Dashboard verifies SSH connectivity
4. Engineer selects setup tasks: create deploy user, SSH hardening, firewall, swap, Node.js, SSL
5. Dashboard executes selected setup scripts sequentially
6. Real-time log output for each step
7. On completion: server appears in the dashboard with health status

### US-008: Docker Cleanup

**Actor**: Developer / Ops
**Precondition**: Docker is installed on the target server.

1. Developer navigates to Docker section of a server
2. Dashboard shows Docker disk usage (images, containers, volumes)
3. Developer can run "Safe Cleanup" (dangling only) or "Aggressive Cleanup" (all unused)
4. Confirmation dialog for aggressive mode
5. Results show space freed

### US-009: LiteLLM Provider Management

**Actor**: Developer / Admin
**Precondition**: LiteLLM sidecar is running (via Docker Compose `ai` profile).

1. Admin navigates to AI Providers section in the dashboard
2. Dashboard shows LiteLLM connection status (healthy/offline, model count, last sync)
3. Admin sees list of all available models from LiteLLM with toggle switches
4. Admin enables/disables individual models (persisted in dashboard DB)
5. Admin can add new providers by configuring LiteLLM (link to LiteLLM admin UI or config)
6. Dashboard periodically syncs model list from LiteLLM API

## Functional Requirements

### Server Management

- **FR-001**: The system must allow adding servers by SSH host, port, and credentials (key-based auth only — no passwords stored).
- **FR-002**: The system must verify SSH connectivity before adding a server.
- **FR-003**: The system must access SSH keys via Docker volume mount (e.g., `~/.ssh/key:/app/.ssh/key:ro`) or base64-encoded environment variable (`SSH_PRIVATE_KEY`). Keys must never be stored in the application database.
- **FR-004**: The system must support multiple servers, each with its own set of applications and configuration.

### Deployment

- **FR-010**: The system must execute deployment via the existing `deploy.sh` script over SSH.
- **FR-011**: The system must implement zero-downtime deployment using start-before-stop strategy.
- **FR-012**: The system must stream real-time deployment logs to the browser via WebSocket.
- **FR-013**: The system must run pre-flight checks before deployment: SSH connectivity, disk space (>1GB free), working tree cleanliness.
- **FR-014**: The system must record deployment history: timestamp, user, branch, commit, outcome, duration.
- **FR-015**: The system must support rollback to any previous successful deployment.
- **FR-016**: Deployments must be cancellable while in progress.
- **FR-017**: Only one deployment per server may run at a time (deployment lock via atomic `mkdir` on target server — not `test -f`).
- **FR-018**: On dashboard startup, all deployments with status `running` must be force-transitioned to `failed` (zombie triage) and remote deploy locks must be released.

### Database Operations

- **FR-020**: The system must execute `backup.sh` and `restore.sh` scripts over SSH.
- **FR-021**: The system must display a list of available backups with metadata (size, date, database name).
- **FR-022**: The system must support manual one-click backup.
- **FR-023**: The system must support restore with mandatory confirmation step.
- **FR-024**: The system must enforce backup retention policy (configurable days, default 14).

### Monitoring

- **FR-030**: The system must execute `health-check.sh` and display structured results.
- **FR-031**: The system must auto-refresh health metrics on a configurable interval (default 60 seconds).
- **FR-032**: The system must show visual severity indicators based on thresholds (CPU, memory, disk).
- **FR-033**: The system must show Docker container status and per-container resource usage.

### Logs

- **FR-040**: The system must stream server logs in real-time via WebSocket.
- **FR-041**: The system must support multiple log sources: application (pm2 or docker), nginx access, nginx error.
- **FR-042**: The system must support text search/filter within the log stream.
- **FR-043**: The system must support pause/resume of log streaming.

### Security

- **FR-050**: The system must execute the `security-audit.sh` script and parse structured output.
- **FR-051**: The system must display audit results grouped by severity.
- **FR-052**: The system must store audit history for comparison over time.

### Server Setup

- **FR-060**: The system must execute server setup scripts (`setup-vps.sh`, `setup-ssl.sh`) over SSH.
- **FR-061**: The system must allow selecting individual setup tasks (deploy user, SSH hardening, firewall, swap, Node.js, SSL).
- **FR-062**: The system must stream real-time output for each setup step.

### Docker Management

- **FR-070**: The system must execute `cleanup.sh` in safe or aggressive mode.
- **FR-071**: The system must display Docker disk usage before and after cleanup.

### Script Output Contract

- **FR-075**: All `@underundre/undev` scripts must support a `--json` flag that outputs structured JSON instead of human-readable text with ANSI colors.
- **FR-076**: JSON output must follow a consistent envelope format: `{ "status": "ok"|"error", "data": {...}, "message": "..." }`.
- **FR-077**: The dashboard must parse JSON output when available (`--json` mode) and fall back to raw text streaming when not (graceful degradation for MVP).
- **FR-078**: The `--json` flag must be implemented in `common.sh` as a shared utility so all scripts inherit it consistently.

### SSH Connection Management

- **FR-082**: The system must use SSH connection multiplexing (`ControlMaster`) to maintain a persistent connection per server, reusing it for all commands.
- **FR-083**: Health check polling (default every 60 seconds) must reuse the persistent SSH connection — not open a new connection per poll.
- **FR-084**: The system must detect and recover from stale SSH connections (automatic reconnect on `ControlPath` socket failure).
- **FR-085**: No agent or daemon must be installed on target servers — all operations execute over SSH using existing scripts.

### LiteLLM Integration

- **FR-086**: The system must support an optional LiteLLM sidecar via Docker Compose profile (`docker compose --profile ai up`).
- **FR-087**: The system must query the LiteLLM API (`GET /models`) to discover available models and display them with enable/disable toggles.
- **FR-088**: Model enable/disable state must be persisted in the dashboard database (not in LiteLLM config).
- **FR-089**: The system must show LiteLLM connection status (healthy/offline, model count, last sync time) in the dashboard.

### Notifications

- **FR-080**: The system must support Telegram notifications for deployment events (start, success, failure, rollback).
- **FR-081**: Notification channels must be configurable per server.

### Access and Authentication

- **FR-090**: The system must require authentication to access the dashboard.
- **FR-091**: The system must support at minimum a single admin user with password-based login.
- **FR-092**: All actions must be logged with the acting user and timestamp (audit trail).

## Non-Functional Requirements

- **NFR-001**: The dashboard must load in under 2 seconds on standard broadband.
- **NFR-002**: WebSocket log streaming must have under 500ms latency from server event to browser display.
- **NFR-003**: The system must run entirely in Docker (single `docker compose up` to start).
- **NFR-004**: The system must work without internet access after initial setup (air-gapped operation for the dashboard itself).
- **NFR-005**: The system must be usable on mobile browsers (responsive layout).
- **NFR-006**: The system must support HTTPS via reverse proxy or built-in TLS.
- **NFR-007**: SSH keys must never be exposed through the UI or API responses.
- **NFR-008**: The system must handle SSH connection timeouts gracefully (30-second timeout, retry with exponential backoff for health checks). SSH multiplexing (`ControlMaster auto`, `ControlPersist 10m`) must be used to avoid per-command connection overhead.

## Success Criteria

- **SC-001**: A developer can deploy an application from browser click to live production in under 5 minutes (including build time).
- **SC-002**: Zero-downtime deployment: existing users experience no errors or timeouts during deployment.
- **SC-003**: A failed deployment can be rolled back to the previous version in under 2 minutes.
- **SC-004**: Database backup of a 5GB database completes and appears in the backup list within 10 minutes.
- **SC-005**: Real-time log streaming displays server output with less than 1 second perceived delay.
- **SC-006**: Server health dashboard loads and displays all metrics within 3 seconds of navigation.
- **SC-007**: A new server can be added and verified (SSH check) in under 30 seconds.
- **SC-008**: The entire system starts from `docker compose up` with zero additional configuration beyond environment variables.
- **SC-009**: All operations produce an audit trail entry within 1 second of completion.

## Out of Scope (v1)

- Multi-tenant support (single-team use only)
- CI/CD pipeline integration (GitHub Actions, GitLab CI)
- Custom script editor in the UI
- Role-based access control (admin-only in v1)
- Kubernetes support
- Cloud provider APIs (AWS, GCP, Azure)
- Built-in monitoring agent (relies on SSH + existing scripts)
- Automated scaling
- Mobile native app

## Key Entities

- **Server**: A remote machine accessible via SSH (host, port, SSH key reference, label, status)
- **Application**: A deployable project on a server (name, repo URL, branch, deploy script path, env vars)
- **Deployment**: A recorded deploy event (server, app, user, timestamp, commit, branch, status, duration, logs)
- **Backup**: A database backup file (server, database name, file path, size, timestamp, retention expiry)
- **AuditEntry**: A log of user action (user, action type, target, timestamp, result)
- **HealthSnapshot**: Point-in-time server metrics (server, timestamp, CPU, memory, disk, swap, containers)

## Assumptions

- All target servers run Linux (Ubuntu/Debian) with Docker installed
- SSH key-based authentication is used (no password auth)
- Existing bash scripts (`deploy.sh`, `backup.sh`, etc.) from `@underundre/undev` are the execution layer — the dashboard wraps them, not replaces them
- Scripts will be extended with `--json` flag for structured output (phased: MVP uses text parsing, v1.1 uses JSON)
- SSH keys are provided via Docker volume mount or env var — never stored in application database
- SSH connection multiplexing (`ControlMaster`) is used for monitoring — no agent installed on target servers
- PostgreSQL is the primary database for backup/restore operations
- Single admin user is sufficient for v1 (no team management)
- Telegram is the primary notification channel for v1
- The dashboard itself runs on the developer's local machine or a dedicated management server, NOT on the production VPS being managed

## Dependencies

- `@underundre/undev` scripts (deploy, db, server, docker, monitoring)
- Docker + Docker Compose (runtime)
- SSH access to target servers
- PostgreSQL on target servers (for DB operations)
