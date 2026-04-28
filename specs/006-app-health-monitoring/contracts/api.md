# API Contract: Application Health Monitoring & Post-Deploy Verification

**Version**: 1.0 | **Date**: 2026-04-28

## Scope

Four new HTTP endpoints (per-app health resource), three new WebSocket event types, and one manifest-extension contract on existing deploy entries. No changes to feature 005's `/api/scripts/manifest` or `/api/runs` shapes — `waitForHealthy` is a manifest-author concern, surfaced in the descriptor when set.

All endpoints require `requireAuth` and are captured by `auditMiddleware`. New fields on `applications` (8 columns from data-model.md) are exposed in the existing `GET /api/apps/:id` and `GET /api/apps` responses; new fields are accepted in `POST /api/apps` and `PATCH /api/apps/:id` requests.

---

## Modified endpoints (existing apps surface)

### `POST /api/apps` and `PATCH /api/apps/:id` — new accepted fields

```jsonc
{
  // ... existing fields ...
  "healthUrl": "https://app.example.com/health",   // ← NEW — optional, string|null
  "monitoringEnabled": true,                        // ← NEW — optional, defaults true
  "alertsMuted": false,                             // ← NEW — optional, defaults false
  "healthProbeIntervalSec": 60,                     // ← NEW — optional, ≥10, default 60
  "healthDebounceCount": 2                          // ← NEW — optional, ≥1, default 2
}
```

Validation (server-side Zod):

```ts
const healthFields = z.object({
  healthUrl: z.union([z.string().url(), z.null(), z.undefined()]).optional(),
  monitoringEnabled: z.boolean().optional(),
  alertsMuted: z.boolean().optional(),
  healthProbeIntervalSec: z.number().int().min(10).optional(),
  healthDebounceCount: z.number().int().min(1).optional(),
});
```

`healthUrl` rules:

- `null` / `undefined` / `""` → persisted as `NULL` (HTTP probe disabled, container probe still runs).
- Non-empty string → must be a valid URL (`z.string().url()`); the schema `https?://` is enforced; relative paths rejected.
- Per FR-029: probes will use `redirect: "manual"` regardless of URL — the URL is the canonical entry point.

**Response 400 `INVALID_PARAMS`** — same shape as feature 005:

```json
{
  "error": {
    "code": "INVALID_PARAMS",
    "message": "Parameter validation failed",
    "details": {
      "fieldErrors": {
        "healthProbeIntervalSec": ["Number must be greater than or equal to 10"]
      }
    }
  }
}
```

**Side effects on PATCH**: when `monitoringEnabled` flips `true → false` OR `false → true`, the route handler calls `appHealthPoller.reloadApp(appId)` after the DB write. The poller adds/removes the per-app tick accordingly. Same for `healthProbeIntervalSec` changes — reload picks up the new cadence on the next tick.

### `GET /api/apps/:id` and `GET /api/apps` — new response fields

The 8 new columns (per data-model.md) are always present in the response, even when NULL:

```jsonc
{
  "id": "app-123",
  "name": "ai-digital-twins",
  // ... existing fields ...
  "healthUrl": "https://app.example.com/health",          // string | null
  "healthStatus": "healthy",                              // 'healthy' | 'unhealthy' | 'unknown'
  "healthCheckedAt": "2026-04-28T12:34:56Z",              // ISO | null
  "healthLastChangeAt": "2026-04-28T11:00:00Z",           // ISO | null
  "healthMessage": null,                                   // string | null
  "healthProbeIntervalSec": 60,
  "healthDebounceCount": 2,
  "monitoringEnabled": true,
  "alertsMuted": false
}
```

---

## New endpoints (per-app health resource)

### `GET /api/applications/:id/health`

Current health state + last 50 probe results.

**Response 200**:

```jsonc
{
  "appId": "app-123",
  "status": "healthy",
  "checkedAt": "2026-04-28T12:34:56Z",
  "lastChangeAt": "2026-04-28T11:00:00Z",
  "message": null,
  "config": {
    "healthUrl": "https://app.example.com/health",
    "intervalSec": 60,
    "debounceCount": 2,
    "monitoringEnabled": true,
    "alertsMuted": false
  },
  "probes": [
    {
      "id": "probe-7f3b",
      "probedAt": "2026-04-28T12:34:56Z",
      "probeType": "container",
      "outcome": "healthy",
      "latencyMs": 42,
      "statusCode": null,
      "errorMessage": null,
      "containerStatus": "healthy"
    },
    {
      "id": "probe-7f3a",
      "probedAt": "2026-04-28T12:34:56Z",
      "probeType": "http",
      "outcome": "healthy",
      "latencyMs": 137,
      "statusCode": 200,
      "errorMessage": null,
      "containerStatus": null
    }
    // ... up to 50 most recent probes ordered by probedAt DESC ...
  ]
}
```

**Response 404 `APP_NOT_FOUND`** when the app id doesn't resolve.

### `POST /api/applications/:id/health/check-now`

Trigger an out-of-cycle probe (FR-023). Returns immediately with the probe handle; UI subscribes to WS for the result.

**Request body**: empty.

**Response 202 `Accepted`**:

```json
{
  "appId": "app-123",
  "queuedAt": "2026-04-28T12:34:56Z",
  "expectedWithinSec": 15
}
```

The route handler invokes `appHealthPoller.runOutOfCycleProbe(appId)` — fire-and-forget. The poller publishes to the `app-health:<appId>` WS channel when the probe completes (FR-023's 15-second budget).

**Response 409 `DEPLOY_IN_PROGRESS`** when `deploy_locks.app_id = :id` exists — out-of-cycle probe is also gated by the FR-011 interlock; operator must wait or cancel the deploy.

```json
{
  "error": {
    "code": "DEPLOY_IN_PROGRESS",
    "message": "Cannot probe while a deploy is active for this app"
  }
}
```

**Response 404 `APP_NOT_FOUND`** when the app id doesn't resolve.

### `PATCH /api/applications/:id/health/config`

Convenience endpoint to update only the health-related config (avoids round-tripping the whole app row).

**Request body**:

```jsonc
{
  "healthUrl": "https://app.example.com/health",     // optional, string | null
  "monitoringEnabled": true,                          // optional
  "alertsMuted": false,                               // optional
  "healthProbeIntervalSec": 60,                       // optional, ≥10
  "healthDebounceCount": 2                            // optional, ≥1
}
```

Same validation rules as `PATCH /api/apps/:id`. PATCH semantics: omitted fields are NOT touched; `null` for `healthUrl` clears the override.

**Response 200**: full updated `health` resource (same shape as `GET /api/applications/:id/health` minus the `probes` array).

**Side effect**: same as `PATCH /api/apps/:id` — `appHealthPoller.reloadApp(appId)` is called after the DB write.

### `GET /api/applications/:id/health/history?since=<iso>&until=<iso>`

Sparkline data + paginated history for the app detail view.

**Query params**:

- `since` — ISO 8601, default `now - 24h`. Lower bound on `probed_at`.
- `until` — ISO 8601, default `now`. Upper bound.
- `limit` — default 1500 (covers 24h × 1/min × 2 probe types + headroom), max 10000.
- `probeType` — optional filter (`container` | `http` | `cert_expiry` | `caddy_admin`).

**Response 200**:

```jsonc
{
  "appId": "app-123",
  "windowStart": "2026-04-27T12:34:56Z",
  "windowEnd":   "2026-04-28T12:34:56Z",
  "probes": [
    { "probedAt": "2026-04-27T12:35:00Z", "probeType": "container", "outcome": "healthy", "latencyMs": 41 },
    { "probedAt": "2026-04-27T12:35:01Z", "probeType": "http",      "outcome": "healthy", "latencyMs": 122, "statusCode": 200 }
    // ... in ASC order for left-to-right rendering ...
  ]
}
```

The response intentionally omits `errorMessage` / `containerStatus` from the slim sparkline payload (the detail view's tooltip fetches the full row via `GET /api/applications/:id/health` if needed). Smaller payloads = faster sparkline render.

---

## WebSocket events

All published via the existing `channelManager.broadcast(channel, payload)` API. Clients subscribe via the existing `useChannel(channelName)` hook.

### Channel `app-health:<appId>`

Fired on every probe completion AND every state-machine commit. UI uses this for the detail-view sparkline updates and the dot's tooltip refresh.

```jsonc
{
  "type": "probe-completed",
  "data": {
    "appId": "app-123",
    "probedAt": "2026-04-28T12:34:56Z",
    "probeType": "container",
    "outcome": "healthy",
    "latencyMs": 42,
    "statusCode": null,
    "containerStatus": "healthy",
    "errorMessage": null
  }
}
```

```jsonc
{
  "type": "health-changed",
  "data": {
    "appId": "app-123",
    "from": "healthy",          // previous committed status
    "to": "unhealthy",
    "at": "2026-04-28T12:34:56Z",
    "reason": "HTTP 503"
  }
}
```

The two event types coexist; clients should branch on `payload.type`.

### Channel `server-apps-health:<serverId>`

Fan-out channel for the Apps tab. Fired ONLY on state-machine commits (not on every probe — keeps the apps list update rate sane).

```jsonc
{
  "type": "app-health-changed",
  "data": {
    "serverId": "srv-1",
    "appId": "app-123",
    "to": "unhealthy",
    "at": "2026-04-28T12:34:56Z"
  }
}
```

The Apps tab subscribes once per render and invalidates the apps-list react-query cache on every event — natural re-fetch via `react-query`'s invalidate semantics.

### Channel `app.cert-expiring` (broadcast — singleton channel)

Per FR-015a windowed alerts. Fired ONCE per (cert_id, window_days) per cert lifecycle. Mirrors the Telegram message — UI surfaces a warning banner on the app's detail view.

```jsonc
{
  "type": "cert-expiring",
  "data": {
    "appId": "app-123",
    "domain": "app.example.com",
    "expiresAt": "2026-05-12T00:00:00Z",
    "daysLeft": 13,
    "windowDays": 14,
    "lastRenewAt": "2026-02-12T00:00:00Z"
  }
}
```

### Channel `server.caddy-unreachable`

Per FR-015b. Fired on `caddy_admin` transition `healthy → unhealthy` (after debounce, FR-007).

```jsonc
{
  "type": "caddy-unreachable",
  "data": {
    "serverId": "srv-1",
    "lastSuccessAt": "2026-04-28T11:30:00Z",
    "errorMessage": "fetch failed: connect ECONNREFUSED 127.0.0.1:2019"
  }
}
```

Recovery (`unhealthy → healthy`) fires `type: "caddy-recovered"` on the same channel — payload `{ serverId, recoveredAt }`. Standard recovery wording matches the Telegram body in feature 008's notifier.

---

## Manifest extension contract (feature 005's `/api/scripts/manifest`)

Existing endpoint shape is unchanged. New fields appear on entries that opt in:

```jsonc
{
  "scripts": [
    {
      "id": "deploy/server-deploy",
      "category": "deploy",
      "description": "Deploy an application",
      "locus": "target",
      "requiresLock": true,
      "timeout": 1800000,
      "dangerLevel": null,
      "outputArtifact": null,
      "waitForHealthy": true,                     // ← NEW — defaults to false when omitted
      "healthyTimeoutMs": 180000,                 // ← NEW — defaults to 180000 when waitForHealthy is true and field is omitted
      "fields": [ /* ... */ ]
    }
  ]
}
```

**UI effect** (feature 005's RunDialog): when `waitForHealthy: true` is present on an entry, the Run dialog renders a small note: "This deploy will wait up to {healthyTimeoutMs / 1000}s for the container to report healthy before completing." No new form field — the toggle is a manifest-author choice, not a runtime param.

**Type contract** (TypeScript surface in feature 005's manifest):

```ts
interface ScriptManifestEntry<TParams extends z.ZodObject<z.ZodRawShape> = z.ZodObject<z.ZodRawShape>> {
  // ... existing fields ...
  waitForHealthy?: boolean;
  healthyTimeoutMs?: number;
}
```

---

## Failure modes

### App probes never converge (chronic `unknown`)

When a container has no defined healthcheck AND `healthUrl` is null, the app stays at `unknown` forever (FR-006: no probe succeeded yet). The UI shows a grey dot with tooltip "No healthcheck configured. Add a healthcheck to the compose file or set Health Check URL in Edit Application." No alert fires (FR-008 silent on unknown).

### `healthUrl` points to an unreachable target from the dashboard's network

HTTP probe records `outcome: error, errorMessage: "fetch failed: ENOTFOUND"`. Container probe still runs. Effective state computed per FR-006 — if container is healthy, app is `healthy` (HTTP probe in `error` does NOT poison the state, just records the issue).

Spec edge case: "If the dashboard is isolated from egress, the HTTP probe is disabled automatically and only container-level health is shown." V1 implementation interprets this as "individual probe failures don't disable the probe type; HTTP probes continue and fail". Operator-driven disable is the `monitoringEnabled` flip on the per-app override OR clearing `healthUrl`.

### `caddy_admin` probe flapping (rare)

Caddy admin API on `127.0.0.1:2019` is local — flapping should not happen unless Caddy itself is restarting. Standard FR-007 debounce (2 consecutive probes in new state) handles transient blips.

### Out-of-cycle probe (Check Now) requested while another out-of-cycle probe is in flight

`runOutOfCycleProbe(appId)` is idempotent — the second call returns the in-flight promise's result. WS event fires once per actual probe execution.

---

## Compatibility matrix

| Caller | Before 006 | After 006 | Change |
|---|---|---|---|
| `GET /api/apps/:id` client | (existing fields) | + 8 health fields | Purely additive |
| `POST /api/apps` client | (existing fields) | + 5 optional health fields | Purely additive |
| `PATCH /api/apps/:id` client | (existing fields) | + 5 optional health fields | Purely additive |
| `/api/applications/:id/health/*` | did not exist | new resource | Purely additive |
| `app-health:*` WS channels | did not exist | new channels | Purely additive |
| `server.caddy-unreachable` channel | did not exist | new channel | Purely additive |
| `GET /api/scripts/manifest` consumer | shape stable | + optional waitForHealthy/healthyTimeoutMs | Backward-compatible — clients ignore unknown fields |
| Deploy runner (`POST /api/apps/:id/deploy`) | success on `docker compose up -d` exit 0 | success only when waitForHealthy passes (when entry opts in) | Behaviour change — gated by manifest opt-in |

---

## Error code catalogue (feature 006 additions)

| Code | HTTP | Meaning |
|---|---|---|
| `APP_NOT_FOUND` | 404 | `:id` not in `applications` table |
| `DEPLOY_IN_PROGRESS` | 409 | Out-of-cycle probe blocked by FR-011 interlock |
| `INVALID_PARAMS` | 400 | (reused from feature 005) Zod validation failed on health config fields |
| `MONITORING_DISABLED` | 409 | Out-of-cycle probe attempted on `monitoringEnabled: false` app — prompts operator to re-enable first |
