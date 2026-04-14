# Research: DevOps Dashboard

**Phase 0 output** | **Date**: 2026-04-14

---

## R-001: Application Architecture

**Decision**: Monolithic full-stack app — single Express server serving both API and React SPA.

**Rationale**: Dashboard is a single-team tool, not a distributed system. Monolith minimizes operational complexity (one container, one port, one process). Matches the underproxy pattern the developer already uses (Express + Vite + React).

**Alternatives considered**:
- **Separate frontend/backend**: More complex Docker setup, CORS, two build steps. Overkill for admin dashboard.
- **Next.js full-stack**: SSR not needed for admin tool (no SEO, no public pages). Adds framework complexity.
- **Hono/Fastify instead of Express**: Good performance, but Express is already familiar from underproxy. Ecosystem maturity matters for SSH/WebSocket middleware.

---

## R-002: Frontend Framework

**Decision**: React 18 + Vite + Tailwind CSS + shadcn/ui.

**Rationale**: Developer already uses this stack in underproxy. Zero learning curve. shadcn/ui provides pre-built components (tables, dialogs, badges, charts) that map directly to dashboard UI needs. Tailwind handles responsive mobile layout (NFR-005).

**Alternatives considered**:
- **Vue/Nuxt**: Good, but developer's muscle memory is React.
- **Svelte**: Great DX, but smaller ecosystem for dashboard components.
- **Plain HTML + htmx**: Simpler but no real-time WebSocket handling, and harder for complex state (deployment progress, log streaming).

---

## R-003: Backend + Database

**Decision**: Express + SQLite (via better-sqlite3 or Drizzle + libsql).

**Rationale**: SQLite is perfect for a single-user admin tool — zero infrastructure, runs in-process, file-based (easy backup, Docker volume). No need for PostgreSQL/Redis for the dashboard itself (we already have enough infrastructure to manage). Drizzle ORM provides type-safe queries consistent with the developer's existing projects.

**Alternatives considered**:
- **PostgreSQL**: Overkill — adds another container, connection management. Dashboard data is small (<1GB ever).
- **JSON file storage**: Too fragile for concurrent writes (WebSocket + API), no querying capability.
- **MongoDB**: Wrong tool — relational data (servers → apps → deployments).

---

## R-004: Real-time Log Streaming

**Decision**: Native WebSocket (via `ws` library) on Express, not Socket.IO.

**Rationale**: Socket.IO adds 40KB client bundle and auto-reconnect complexity we don't need. Native WebSocket is lighter, and we control reconnect logic ourselves. Server-side: spawn SSH child process, pipe stdout to WebSocket. Client-side: native `WebSocket` API + reconnect wrapper.

**Architecture**:
```
Browser ←WebSocket→ Express ←SSH child_process→ Remote Server
                     ↓
              Parse stdout lines → Forward to client
```

**Alternatives considered**:
- **Socket.IO**: Unnecessary abstraction layer, larger bundle.
- **Server-Sent Events**: One-directional (server→client only), can't send commands back (pause/resume, cancel).
- **Polling**: Too slow for real-time logs (500ms latency NFR).

---

## R-005: SSH Execution Layer

**Decision**: Node.js `ssh2` library for programmatic SSH, with `ControlMaster` multiplexing via ssh config.

**Rationale**: `ssh2` is the de facto SSH library for Node.js (18M weekly downloads). Supports shell execution, port forwarding, SFTP. We use it to:
1. Establish persistent connections (multiplexed via `ControlMaster`)
2. Execute scripts remotely (`ssh.exec("bash /path/to/deploy.sh --json")`)
3. Stream stdout/stderr back to WebSocket

For `ControlMaster` multiplexing: configure via `~/.ssh/config` inside the Docker container, or use `ssh2`'s built-in connection pooling.

**Alternatives considered**:
- **child_process.exec("ssh ...")**: Works but no programmatic control over connection state, harder to pool.
- **mscdex/ssh2-streams**: Lower-level, more code.
- **Install agent on servers**: Violates FR-085 (no agents on target servers).

---

## R-006: Authentication

**Decision**: Simple session-based auth with bcrypt password hash. Single admin user, credentials in env vars.

**Rationale**: v1 is single-user (FR-091). No need for OAuth, JWT, or user management. Admin sets `ADMIN_USER` and `ADMIN_PASSWORD_HASH` in Docker Compose env. Session stored server-side (in SQLite). Cookie-based, httpOnly, secure.

**Alternatives considered**:
- **JWT**: Stateless but adds complexity (refresh tokens, token storage). No benefit for single-user.
- **OAuth2**: Way overkill — no external identity provider needed.
- **Basic Auth**: No session, credentials sent every request. Less secure.

---

## R-007: Docker Compose Architecture

**Decision**: Single container with app + SQLite. Volume mounts for SSH keys and data.

```yaml
services:
  dashboard:
    build: .
    ports:
      - "${PORT:-3000}:3000"
    volumes:
      - ./data:/app/data           # SQLite DB + backups
      - ~/.ssh:/app/.ssh:ro        # SSH keys (read-only)
    environment:
      - ADMIN_USER=admin
      - ADMIN_PASSWORD_HASH=...
      - TELEGRAM_BOT_TOKEN=...
      - TELEGRAM_CHAT_ID=...
```

**Rationale**: One container = `docker compose up` and done (SC-008). SQLite file lives in `./data/` volume — survives container restarts. SSH keys mounted read-only.

**Alternatives considered**:
- **Two containers (app + db)**: Needed only for PostgreSQL. SQLite eliminates this.
- **Traefik sidecar**: Only needed if exposing to internet. For local use, direct port is fine. User can add their own reverse proxy.

---

## R-008: Script JSON Output Format

**Decision**: Envelope format with streaming support.

**Standard envelope** (for one-shot commands like health-check, backup):
```json
{
  "status": "ok",
  "data": { ... },
  "message": "Backup complete",
  "timestamp": "2026-04-14T12:00:00Z"
}
```

**Streaming format** (for long-running commands like deploy, logs):
```
Each line is a JSON object (NDJSON):
{"type":"log","level":"info","message":"Building...","timestamp":"..."}
{"type":"log","level":"error","message":"Failed","timestamp":"..."}
{"type":"progress","step":"build","status":"done","timestamp":"..."}
{"type":"result","status":"ok","data":{...},"timestamp":"..."}
```

**Rationale**: NDJSON (newline-delimited JSON) allows streaming parse — each line is independent. Dashboard reads line by line, forwards to WebSocket. Final line has `type: "result"` with the summary.

---

## R-009: Deployment Lock Mechanism

**Decision**: Server-side lock file via SSH check (reuse existing `process-lock` pattern from clai-helpers).

Before deploy: `ssh server "test -f /tmp/deploy.lock && cat /tmp/deploy.lock || echo 'free'"`
- If locked: show who holds it, offer force-unlock
- If free: `ssh server "echo $PID > /tmp/deploy.lock"` then proceed
- On complete/fail: `ssh server "rm -f /tmp/deploy.lock"`

**Rationale**: Simple, no extra infrastructure. Lock file on the target server prevents parallel deploys regardless of how many dashboard instances exist.
