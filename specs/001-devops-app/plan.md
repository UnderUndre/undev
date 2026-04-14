# Implementation Plan: DevOps Dashboard

**Branch**: `001-devops-app` | **Date**: 2026-04-14 | **Spec**: [spec.md](spec.md)

## Summary

Build a self-hosted DevOps dashboard that wraps `@underundre/undev` bash scripts with a browser-based UI. Single Docker container, SQLite database, real-time WebSocket log streaming, SSH-based execution with connection multiplexing.

## Technical Context

**Language/Runtime**: TypeScript 5.x, Node.js 20+ (ESM)
**Frontend**: React 18 + Vite + Tailwind CSS + shadcn/ui
**Backend**: Express + ws (WebSocket) + ssh2
**Database**: PostgreSQL 16 via Drizzle ORM (`postgres` driver — fully async)
**Auth**: Session-based, bcrypt, single admin user
**Runtime**: Docker + Docker Compose (app + PostgreSQL containers)
**Testing**: Vitest (unit + integration), Playwright (E2E)

**Key libraries**:
- `ssh2` — programmatic SSH execution + connection pool
- `ws` — WebSocket server for real-time streaming
- `drizzle-orm` + `postgres` (porsager) — type-safe async PostgreSQL
- `bcrypt` — password hashing
- `zod` — request validation
- `@tanstack/react-query` — client data fetching
- `recharts` — health metrics charts

## Project Structure

```
devops-app/
├── docker-compose.yml          # Two services: app + PostgreSQL
├── Dockerfile                  # Multi-stage build
├── package.json
├── tsconfig.json
├── vite.config.ts
├── drizzle.config.ts
├── server/
│   ├── index.ts                # Express + WebSocket server entry
│   ├── db/
│   │   ├── schema.ts           # Drizzle schema (all entities)
│   │   └── migrations/         # SQL migrations
│   ├── routes/
│   │   ├── auth.ts             # Login/logout/me
│   │   ├── servers.ts          # Server CRUD + verify + setup
│   │   ├── apps.ts             # Application CRUD
│   │   ├── deployments.ts      # Deploy + rollback + cancel
│   │   ├── backups.ts          # Backup + restore
│   │   ├── health.ts           # Health check + history
│   │   ├── docker.ts           # Docker cleanup + status
│   │   ├── audit.ts            # Security audit + audit trail
│   │   └── logs.ts             # Log source listing
│   ├── services/
│   │   ├── ssh-pool.ts         # SSH connection pool (ControlMaster-style)
│   │   ├── script-runner.ts    # Execute scripts over SSH, parse output
│   │   ├── job-manager.ts      # Async job lifecycle (start, stream, complete)
│   │   ├── deploy-lock.ts      # Per-server deployment lock
│   │   ├── health-poller.ts    # Background health check scheduler
│   │   └── notifier.ts         # Telegram notifications
│   ├── ws/
│   │   ├── handler.ts          # WebSocket connection handler
│   │   └── channels.ts         # Channel subscription management
│   └── middleware/
│       ├── auth.ts             # Session verification middleware
│       ├── audit.ts            # Auto-log every mutating request
│       └── validate.ts         # Zod schema validation
├── client/
│   ├── main.tsx                # React entry
│   ├── App.tsx                 # Router
│   ├── components/
│   │   ├── layout/             # Sidebar, header, mobile nav
│   │   ├── deploy/             # Deploy button, progress, history
│   │   ├── health/             # Metrics cards, charts
│   │   ├── logs/               # Log viewer (virtual scroll + search)
│   │   ├── backups/            # Backup list, restore dialog
│   │   ├── docker/             # Docker status, cleanup
│   │   ├── servers/            # Server list, add dialog, setup wizard
│   │   └── ui/                 # shadcn/ui components
│   ├── hooks/
│   │   ├── useWebSocket.ts     # WS connection + channel subscriptions
│   │   ├── useJob.ts           # Track async job progress
│   │   └── useHealth.ts        # Real-time health data
│   ├── lib/
│   │   ├── api.ts              # Fetch wrapper with auth
│   │   └── ws.ts               # WebSocket client with reconnect
│   └── pages/
│       ├── LoginPage.tsx
│       ├── DashboardPage.tsx   # Overview: all servers, recent deploys
│       ├── ServerPage.tsx      # Single server: health, apps, docker
│       ├── AppPage.tsx         # Single app: deploy, logs, history
│       ├── BackupsPage.tsx     # Database backups for a server
│       └── AuditPage.tsx       # Audit trail
├── data/                       # Docker volume mount (logs + data)
└── scripts/                    # Copied from @underundre/undev
```

## Key Implementation Notes

**PostgreSQL (async driver)**: Using `postgres` (porsager) driver — fully async, non-blocking. No event loop concerns unlike synchronous better-sqlite3. Standard MVCC handles concurrent reads/writes from WebSocket + API + health poller.

**Deployment logs on disk, not in DB**: Logs are written to `/app/data/logs/deploy-<id>.log` as plain text files via async `fs.createWriteStream`. PostgreSQL stores only `logFilePath`. Keeps DB lean, log reads are async fs streams.

**Zombie deploy triage on startup**: On Express server start, force-fail all `status = "running"` deployments with `errorMessage: "Interrupted by dashboard restart"`. Also release remote deploy locks via SSH `rm -rf /tmp/deploy.lock`.

**SSH connection pool**: `ssh2` is pure-JS — ignores `~/.ssh/config` and `ControlMaster`. Multiplexing implemented in `ssh-pool.ts`: `Map<serverId, Client>` with auto-reconnect and exponential backoff. One TCP connection per server, multiple concurrent channels via `client.exec()`.

**Atomic deploy lock**: `mkdir /tmp/deploy.lock` on target server (not `test -f`). `mkdir` is POSIX-atomic — prevents TOCTOU race conditions.

## Complexity Tracking

| Deviation | Why Needed | Simpler Alternative Rejected |
|-----------|-----------|------------------------------|
| WebSocket (not REST polling) | NFR-002 requires <500ms latency for logs | Polling at 500ms intervals = 2x bandwidth, inconsistent timing |
| SSH connection pool (in-process) | `ssh2` is pure-JS, ignores system SSH config | `child_process.exec("ssh ...")` — less control over connection lifecycle |
| PostgreSQL + file logs | Fully async driver; MVCC concurrency; familiar stack (underproxy) | SQLite sync driver stalls event loop under concurrent WS + deploy writes |
| Atomic mkdir lock | `test -f` has TOCTOU race | File-based lock → two processes can both pass the check simultaneously |
