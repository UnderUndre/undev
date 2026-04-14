# WebSocket Contract: DevOps Dashboard

**Version**: 1.0

## Connection

```
ws://localhost:3000/ws
```

Authentication via existing session cookie (httpOnly, same origin). No token in query string — avoids credential leakage in logs, proxy caches, and browser history. Connection rejected with 401 if no valid session cookie.

## Message Format (Server → Client)

All messages are JSON:

```json
{
  "channel": "job:<jobId>" | "logs:<serverId>:<source>" | "health:<serverId>",
  "type": "log" | "progress" | "result" | "error" | "health" | "metric",
  "data": { ... },
  "timestamp": "2026-04-14T12:00:00.000Z"
}
```

## Channels

### Job Progress: `job:<jobId>`

Subscribed automatically when a job is created via REST API.

```json
// Log line from script execution
{ "channel": "job:abc123", "type": "log", "data": { "level": "info", "message": "Building..." } }

// Progress step update
{ "channel": "job:abc123", "type": "progress", "data": { "step": "build", "status": "running" } }
{ "channel": "job:abc123", "type": "progress", "data": { "step": "build", "status": "done" } }

// Final result
{ "channel": "job:abc123", "type": "result", "data": { "status": "ok", "deploymentId": "..." } }

// Error
{ "channel": "job:abc123", "type": "error", "data": { "message": "SSH connection failed" } }
```

### Log Streaming: `logs:<serverId>:<source>`

Sources: `pm2`, `docker`, `nginx-access`, `nginx-error`.

```json
{ "channel": "logs:srv1:pm2", "type": "log", "data": { "line": "2026-04-14 12:00:00 [INFO] Request handled" } }
```

### Health Updates: `health:<serverId>`

Sent on each health check poll (default every 60s).

```json
{
  "channel": "health:srv1",
  "type": "health",
  "data": {
    "cpuLoadPercent": 45,
    "memoryPercent": 72,
    "diskPercent": 55,
    "swapPercent": 10,
    "dockerContainers": [
      { "name": "app-web-1", "status": "running", "cpuPercent": 12, "memoryMb": 256 }
    ],
    "services": [
      { "name": "nginx", "running": true },
      { "name": "docker", "running": true }
    ]
  }
}
```

## Client → Server Messages

```json
// Subscribe to log stream
{ "action": "subscribe", "channel": "logs:srv1:pm2" }

// Unsubscribe (pause)
{ "action": "unsubscribe", "channel": "logs:srv1:pm2" }

// Cancel a running job
{ "action": "cancel", "jobId": "abc123" }
```

## Connection Lifecycle

1. Client connects with session token
2. Server validates token, sends `{ "type": "connected", "data": { "userId": "..." } }`
3. Client subscribes to channels as needed
4. Server pushes events on subscribed channels
5. Client can unsubscribe/resubscribe at any time
6. On disconnect: all subscriptions cleaned up, SSH processes for log tailing killed

## Reconnection

Client should implement exponential backoff reconnect:
- 1s → 2s → 4s → 8s → 16s → 30s (max)
- On reconnect: re-subscribe to previous channels
- Server re-sends latest health snapshot on re-subscribe to health channel
