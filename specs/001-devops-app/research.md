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

**Decision**: Express + PostgreSQL 16 (via Drizzle ORM + `postgres` driver).

**Rationale**: Developer already uses Drizzle + Postgres in underproxy — zero learning curve. The `postgres` (porsager) driver is fully async and non-blocking, which matters since the dashboard runs WebSocket + health pollers + deploy jobs concurrently on one event loop. SQLite's `better-sqlite3` driver is synchronous and would block the event loop during writes (flagged in Gemini review). PostgreSQL adds one Docker Compose service but eliminates this entire class of concurrency bugs.

**Alternatives considered**:
- **SQLite (better-sqlite3)**: Zero infra, but synchronous writes block event loop. Gemini review identified this as a production risk for a WebSocket-heavy app.
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

**Decision**: Node.js `ssh2` library with in-process connection pool (one persistent `Client` per server).

**Rationale**: `ssh2` is the de facto SSH library for Node.js (18M weekly downloads). It's a pure-JS SSH implementation — it does NOT use the system `ssh` binary and ignores `~/.ssh/config` entirely (including `ControlMaster`). This means connection multiplexing must be implemented in application code.

**Architecture**: `ssh-pool.ts` maintains a `Map<serverId, ssh2.Client>`. Each `Client` is a single TCP connection that supports multiple concurrent channels (`client.exec()` opens a new channel on the existing connection). This is effectively the same as `ControlMaster` but in-process.

We use it to:
1. Hold one persistent connection per server in Express memory
2. Execute scripts via `client.exec("bash /path/to/deploy.sh --json")`
3. Stream stdout/stderr from the channel directly to WebSocket
4. Health check poller reuses the same connection (no new TCP handshake per poll)
5. On connection drop → auto-reconnect with exponential backoff

**Alternatives considered**:
- **child_process.exec("ssh ...")** + system ControlMaster: Works, leverages OS-level multiplexing, but harder to manage connection lifecycle, no programmatic channel control, stdout parsing more complex.
- **Install agent on servers**: Violates FR-085 (no agents on target servers).

---

## R-006: Authentication

**Decision**: Simple session-based auth with bcrypt password hash. Single admin user, credentials in env vars.

**Rationale**: v1 is single-user (FR-091). No need for OAuth, JWT, or user management. Admin sets `ADMIN_USER` and `ADMIN_PASSWORD_HASH` in Docker Compose env. Session stored server-side (in PostgreSQL). Cookie-based, httpOnly, secure.

**Alternatives considered**:
- **JWT**: Stateless but adds complexity (refresh tokens, token storage). No benefit for single-user.
- **OAuth2**: Way overkill — no external identity provider needed.
- **Basic Auth**: No session, credentials sent every request. Less secure.

---

## R-007: Docker Compose Architecture

**Decision**: Two containers — app + PostgreSQL 16. Volume mounts for SSH keys, DB data, and log files.

```yaml
services:
  db:
    image: postgres:16-alpine
    restart: unless-stopped
    volumes:
      - pgdata:/var/lib/postgresql/data
    environment:
      POSTGRES_USER: ${POSTGRES_USER:-dashboard}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?required}
      POSTGRES_DB: ${POSTGRES_DB:-dashboard}
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER:-dashboard}"]
      interval: 5s
      timeout: 5s
      retries: 5

  dashboard:
    build: .
    ports:
      - "${PORT:-3000}:3000"
    depends_on:
      db:
        condition: service_healthy
    volumes:
      - ./data/logs:/app/data/logs  # Deploy log files
      - ~/.ssh:/app/.ssh:ro         # SSH keys (read-only)
    environment:
      - DATABASE_URL=postgresql://${POSTGRES_USER:-dashboard}:${POSTGRES_PASSWORD}@db:5432/${POSTGRES_DB:-dashboard}
      - ADMIN_USER=admin
      - ADMIN_PASSWORD_HASH=...
      - TELEGRAM_BOT_TOKEN=
      - TELEGRAM_CHAT_ID=

volumes:
  pgdata:
```

**Rationale**: Two containers but still `docker compose up` and done (SC-008). Postgres healthcheck ensures app waits for DB. Log files on disk volume, not in DB. SSH keys read-only mount.

**Alternatives considered**:
- **Single container with SQLite**: Simpler setup, but synchronous driver blocks event loop. Eliminated after Gemini review.
- **Traefik sidecar**: Only needed if exposing to internet. For local use, direct port is fine.

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

**Decision**: Atomic directory-based lock on target server via `mkdir`.

```bash
# Acquire (atomic — mkdir fails if dir exists):
ssh server "mkdir /tmp/deploy.lock && echo $DASHBOARD_ID > /tmp/deploy.lock/owner"

# Check who holds it:
ssh server "cat /tmp/deploy.lock/owner 2>/dev/null || echo 'free'"

# Release:
ssh server "rm -rf /tmp/deploy.lock"
```

`mkdir` is atomic on all POSIX filesystems — two concurrent `mkdir` calls on the same path guarantee exactly one succeeds (returns 0) and the other fails (returns 1). This eliminates the TOCTOU race condition that `test -f` + `echo >` has.

**Rationale**: Simple, no extra infrastructure. Atomic lock on the target server prevents parallel deploys regardless of how many dashboard instances exist. `owner` file inside the lock dir identifies who holds it for debugging.
