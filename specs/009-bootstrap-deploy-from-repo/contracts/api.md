# API Contract: Bootstrap Deploy from GitHub Repo

**Version**: 1.0 | **Date**: 2026-04-28

## Scope

Six new REST endpoints, two new WebSocket event types, five new manifest entries (treated as a contract). The repo selector reuses feature 002's `GET /api/github/repos` endpoint with `?sort=pushed&per_page=20` and adds one new endpoint for compose pre-fetch. All endpoints require `requireAuth` and are captured by `auditMiddleware`. PAT values are routed through feature 005's `secret`-marked Zod schema, so `audit_entries.details` and `script_runs.params` only ever see `"***"` per FR-015.

---

## REST endpoints

### `GET /api/github/repos?q=<query>&sort=pushed&per_page=20`

Repo search/list — backed by feature 002's `githubService`. Already exists; we re-state the contract here for completeness because the wizard depends on these query params.

**Query**:

| Param | Type | Notes |
|----|----|----|
| `q` | string | Optional. ≥2 chars triggers GitHub Search API (`/search/repositories?q=user:<user>+<query>`); empty triggers `/user/repos?sort=pushed`. |
| `sort` | string | Optional. `'pushed'` for the recent-20 default. Defaults to `'pushed'` when omitted. |
| `per_page` | int | Optional. Default 30 (existing); wizard sends 20 (FR-002). |

**Response 200**:

```jsonc
{
  "repos": [
    {
      "fullName": "owner/repo",
      "name": "repo",
      "owner": "owner",
      "isPrivate": false,
      "defaultBranch": "main",
      "updatedAt": "2026-04-27T...",
      "description": "..."
    }
  ]
}
```

**Response 400 `VALIDATION_ERROR`**: `q` provided but <2 chars.
**Response 401 `GITHUB_UNAUTHORIZED`**: PAT expired/revoked.
**Response 429 `GITHUB_RATE_LIMITED`**: `{ resetAt: "<ISO>" }`. Surfaced verbatim in wizard's "search disabled" banner.

Frontend caches `(account, q)` tuples for 60s per FR-002a (R-009).

---

### `GET /api/github/repos/:owner/:repo/compose?path=<path>` (NEW)

Pre-fetch the compose file via the GitHub Contents API. Used by Step 2 of the wizard (FR-003).

**Path params**: `owner`, `repo` — both `^[A-Za-z0-9._-]+$`.

**Query**:

| Param | Type | Notes |
|----|----|----|
| `path` | string | Optional. Default `'docker-compose.yml'`. Falls back to `'docker-compose.yaml'` if first 404s. |
| `ref` | string | Optional. Branch / commit. Defaults to repo's `default_branch`. |

**Response 200**:

```jsonc
{
  "found": true,
  "path": "docker-compose.yml",
  "ref": "main",
  "services": [
    {
      "name": "app",
      "exposeOrPorts": 3000,
      "networkModeHost": false,
      "replicas": 1,
      "hasHealthcheck": true
    },
    {
      "name": "db",
      "exposeOrPorts": null,
      "networkModeHost": false,
      "replicas": 1,
      "hasHealthcheck": false
    }
  ],
  "errors": [],
  "warnings": []
}
```

`errors` is non-fatal compose-parser warnings (e.g. "service `worker` has multiple `ports:` entries; using first"). `warnings` is wizard-level guidance (e.g. "service `web` uses `network_mode: host` — port conflicts at server level become possible").

**Response 200 (not found)** — both extension fallbacks 404:

```jsonc
{
  "found": false,
  "errors": ["No docker-compose.yml or docker-compose.yaml at the configured path"],
  "warnings": []
}
```

The wizard's Step 2 displays this `errors` content to the operator and blocks progression.

**Response 401 `GITHUB_UNAUTHORIZED`**: PAT expired/revoked.
**Response 403 `GITHUB_REPO_NOT_ACCESSIBLE`**: PAT lacks `Contents: read` for this repo / org SSO.
**Response 422 `COMPOSE_PARSE_ERROR`**: yaml.parse threw — invalid YAML. `details: { line, message }`.

---

### `POST /api/applications/bootstrap` (NEW)

Start a new bootstrap. Inserts the `applications` row in `bootstrap_state = 'init'`, then enqueues the orchestrator's `start(appId)` call.

**Request body** (Zod-validated):

```ts
const bootstrapRequestSchema = z.object({
  serverId: z.string().min(1),
  githubRepo: z.string().regex(/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/),  // "owner/repo"
  name: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/).max(64),          // FR-006 slug; client-derived, server-validated (FR-027)
  branch: z.string().regex(/^[a-zA-Z0-9._\-/]+$/),                     // matches feature 005's BRANCH_REGEX
  composePath: z.string().max(256).default("docker-compose.yml"),
  remotePath: z.string().min(1).max(512),                              // ${DEPLOY_USER_HOME}/apps/${slug} server-computed default; client may override via Advanced
  upstreamService: z.string().nullable(),
  upstreamPort: z.number().int().min(1).max(65535).nullable(),
  domain: z.string().regex(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/).nullable(),
  acmeEmail: z.string().email().nullable(),                            // optional per-app override (feature 008 FR-002)
  bootstrapAutoRetry: z.boolean().default(false),
});
```

`upstreamService` + `upstreamPort` MUST be both null or both non-null (server-side check; rejects mixed state per data-model invariant 4).

**Response 201**:

```jsonc
{
  "id": "app-uuid",
  "bootstrapState": "init",
  "createdVia": "bootstrap",
  "events": []                                  // empty initially; populated by subsequent state transitions
}
```

The orchestrator dispatches `start()` asynchronously after the response is sent. The client immediately switches to the WS-subscribed progress view OR polls `GET /api/applications/:id/bootstrap-state` every 2s per FR-026.

**Response 400 `INVALID_PARAMS`**: Zod validation failed. `details.fieldErrors.<field>` shape.
**Response 409 `SLUG_COLLISION`**: `applications.name` already exists on this server. `{ existingAppId, message }`. Wizard offers to rename.
**Response 409 `REMOTE_PATH_COLLISION`**: pre-flight check (`stat <remotePath>` over SSH) found a non-git directory at the path. Wizard offers Advanced override.
**Response 422 `COMPOSE_NO_SERVICES`**: `upstream_service`/`upstream_port` were not provided AND the parsed compose has no service with `expose:`/`ports:`. Wizard prompts manual input.
**Response 503 `SSH_UNREACHABLE`**: server is offline; bootstrap blocked.

---

### `GET /api/applications/:id/bootstrap-state` (NEW)

Polled by the wizard at 2s intervals (FR-026). Source of truth — the wizard's WS subscription is an accelerant; this endpoint is canonical.

**Response 200**:

```jsonc
{
  "id": "app-uuid",
  "name": "foo",
  "bootstrapState": "compose_up",
  "createdVia": "bootstrap",
  "domain": "foo.example.com",                  // null if not set
  "upstreamService": "app",
  "upstreamPort": 3000,
  "composePath": "docker-compose.yml",
  "events": [
    {
      "id": "ev-1",
      "fromState": "init",
      "toState": "cloning",
      "occurredAt": "2026-04-28T12:00:00Z",
      "metadata": { "runId": "run-abc", "repoUrl": "https://github.com/owner/foo.git", "branch": "main" },
      "actor": "user-42"
    },
    {
      "id": "ev-2",
      "fromState": "cloning",
      "toState": "compose_up",
      "occurredAt": "2026-04-28T12:00:23Z",
      "metadata": { "runId": "run-def", "composePath": "docker-compose.yml" },
      "actor": "system"
    }
  ],
  "currentRun": {
    "runId": "run-def",
    "scriptId": "bootstrap/compose-up",
    "status": "running",
    "logTail": "Pulling app (alpine)...\nStarting...",
    "startedAt": "2026-04-28T12:00:23Z"
  }
}
```

`currentRun` is null when `bootstrapState` is terminal (`active` or `failed_*`).

**Response 404 `NOT_FOUND`**: app not found.
**Response 410 `HARD_DELETED`**: app was hard-deleted in the last 60s; cached client should clear.

---

### `POST /api/applications/:id/bootstrap/retry?from=<step>` (NEW)

Retry a failed step (FR-019). Validates that the requested `from` step matches the app's current `failed_<step>` state OR is earlier in the chain (per the canTransition table in plan.md).

**Query**:

| Param | Type | Notes |
|----|----|----|
| `from` | string | Required. One of `cloning`, `compose_up`, `healthcheck`, `proxy_applied`, `cert_issued`. |

**Request body**: empty.

**Response 202 (accepted, async)**:

```jsonc
{
  "id": "app-uuid",
  "bootstrapState": "cloning",                  // transitioned synchronously; orchestrator dispatches async
  "events": [...]
}
```

**Response 400 `INVALID_TRANSITION`**: `from` is not a valid retry step for the current state. `details: { currentState, requestedFrom, allowedFroms }`.
**Response 409 `BOOTSTRAP_IN_PROGRESS`**: a `script_runs` row tagged `script_id = bootstrap/*` is currently `running` for this app.
**Response 404 `NOT_FOUND`**: app not found.

---

### `PATCH /api/applications/:id/bootstrap/config` (NEW)

Edit Config — only the four fields in FR-020 are mutable on a `failed_*` app. Other fields rejected.

**Request body** (Zod-validated):

```ts
const editConfigSchema = z.object({
  branch: z.string().regex(/^[a-zA-Z0-9._\-/]+$/).optional(),
  composePath: z.string().max(256).optional(),
  upstreamService: z.string().nullable().optional(),
  upstreamPort: z.number().int().min(1).max(65535).nullable().optional(),
}).refine(
  // upstreamService + upstreamPort move together
  (v) => (v.upstreamService === undefined) === (v.upstreamPort === undefined),
  "upstreamService and upstreamPort must be edited together",
);
```

`remotePath` and `repoUrl` are NOT in the schema. Sending them returns 400 `IMMUTABLE_FIELD`.

**Response 200**: full updated app row.

**Response 400 `INVALID_PARAMS`**: Zod validation failed.
**Response 400 `IMMUTABLE_FIELD`**: request included `remotePath` or `repoUrl`. `details: { field }`.
**Response 409 `BOOTSTRAP_NOT_FAILED`**: app is not in a `failed_*` state. `{ currentState }`.
**Response 404 `NOT_FOUND`**: app not found.

---

### `POST /api/applications/:id/hard-delete` (NEW)

Typed-confirm Hard Delete (FR-021). Order of operations on success: cert revoke (feature 008 hard-delete) → compose down -v → SSH-side `rm -rf` after `realpath` jail check → DB row delete.

**Request body** (Zod-validated):

```ts
const hardDeleteSchema = z.object({
  confirmName: z.string().min(1),               // must equal applications.name; checked server-side per FR-027
});
```

**Response 200**:

```jsonc
{
  "id": "app-uuid",
  "removed": {
    "remotePath": "/home/deploy/apps/foo",
    "containers": ["foo-app-1", "foo-db-1"],
    "caddySites": ["foo.example.com"],
    "certIds": ["cert-abc"]
  }
}
```

**Response 400 `CONFIRM_MISMATCH`**: `confirmName !== applications.name`. `details: { expected: app.name }`.
**Response 422 `JAIL_ESCAPE`**: `path-jail.resolveAndJailCheck` rejected the resolved path. `details: { remotePath, resolved, jailRoot }`. Operator must investigate manually before retry.
**Response 503 `SSH_UNREACHABLE`**: target offline; partial cleanup may have occurred. `details: { stagesCompleted: ['cert-revoke'], stagesFailed: ['compose-down', 'rm-rf'] }`.

The endpoint is itself a `script_runs` row (`script_id = 'bootstrap/hard-delete'`, `dangerLevel: high`). Audit captures `confirmName` masked as `"***"` if it equals `applications.name` — actually it's safer to log the comparison result, not the input.

---

## WebSocket events

Both reuse feature 001's existing WS broadcast infrastructure (`ws/broadcaster.ts`). Channel scoping matches feature 005's run-log convention.

### `bootstrap.state-changed`

Fired AFTER the DB transition is committed (R-012). At-most-once delivery.

```jsonc
{
  "type": "bootstrap.state-changed",
  "appId": "app-uuid",
  "fromState": "cloning",
  "toState": "compose_up",
  "occurredAt": "2026-04-28T12:00:23Z",
  "actor": "system",
  "metadata": { "runId": "run-def", "composePath": "docker-compose.yml" }
}
```

The wizard tracks `lastAppliedOccurredAt` and drops out-of-order events. The full audit chain is always available via `GET /api/applications/:id/bootstrap-state`.

### `bootstrap.step-log`

Streamed for every log line from the underlying `script_runs` of a bootstrap step. Fired at the same cadence as feature 005's existing run-log WS events.

```jsonc
{
  "type": "bootstrap.step-log",
  "appId": "app-uuid",
  "runId": "run-def",
  "scriptId": "bootstrap/compose-up",
  "stream": "stdout",
  "line": "Pulling app (alpine)...",
  "timestamp": "2026-04-28T12:00:24.123Z"
}
```

Lines are NOT rate-limited at the broadcast level — the existing WS backpressure handling applies.

### Subscription / replay

Client subscribes once on dashboard load (existing connection). The Bootstrap Wizard filters incoming events by `appId`. On reconnect, the wizard re-fetches `GET /api/applications/:id/bootstrap-state` to resync; subsequent WS events are deduped against `lastAppliedOccurredAt`.

---

## Manifest entries (contract — `scripts-manifest.ts`)

Five new entries appended to `manifest`:

```ts
// scripts-manifest.ts — new entries

{
  id: "bootstrap/clone",
  category: "deploy",
  description: "Clone a repo to the target via PAT-injected git clone (or fetch+reset if already cloned)",
  locus: "target",
  requiresLock: true,
  dangerLevel: "low",
  timeout: 600_000,                              // 10 min — large repos need headroom
  params: z.object({
    appId: z.string().uuid(),                    // included so reconciler Q7 can find the run
    remotePath: z.string().min(1),
    repoUrl: z.string().url(),                   // unauthenticated form: https://github.com/owner/repo.git
    branch: z.string().regex(/^[a-zA-Z0-9._\-/]+$/),
    pat: z.string().describe("secret"),          // routes via env-var transport per feature 005 R-006
  }),
},
{
  id: "bootstrap/compose-up",
  category: "deploy",
  description: "docker compose up -d --remove-orphans on the target",
  locus: "target",
  requiresLock: true,
  dangerLevel: "low",
  timeout: 1_800_000,                            // 30 min — image builds can be slow
  params: z.object({
    appId: z.string().uuid(),
    remotePath: z.string().min(1),
    composePath: z.string().min(1).max(256),
  }),
},
{
  id: "bootstrap/wait-healthy",
  category: "deploy",
  description: "Poll docker compose healthcheck until healthy or timeout (delegates to feature 006 FR-025)",
  locus: "target",
  requiresLock: false,                           // safe to run alongside other ops on the server
  dangerLevel: "low",
  timeout: 300_000,                              // 5 min — matches feature 006's default healthyTimeoutMs
  params: z.object({
    appId: z.string().uuid(),
    remotePath: z.string().min(1),
    composePath: z.string().min(1).max(256),
    composeService: z.string().min(1),           // service name to inspect; from upstream_service
  }),
},
{
  id: "bootstrap/finalise",
  category: "deploy",
  description: "Persist current_commit, transition to ACTIVE, fire success Telegram",
  locus: "target",
  requiresLock: false,
  dangerLevel: "low",
  timeout: 60_000,
  outputArtifact: { type: "json", captureFrom: "stdout-json" },  // emits {"currentCommit":"abc123"}
  params: z.object({
    appId: z.string().uuid(),
    remotePath: z.string().min(1),
  }),
},
{
  id: "bootstrap/hard-delete",
  category: "deploy",
  description: "Hard-delete bootstrapped app: realpath jail check, compose down -v, rm -rf, Caddy/cert removal",
  locus: "target",
  requiresLock: true,
  dangerLevel: "high",                           // FR-021 + manifest UI typed-confirm
  timeout: 600_000,
  params: z.object({
    appId: z.string().uuid(),
    remotePath: z.string().min(1),
    composePath: z.string().min(1).max(256),
    jailRoot: z.string().min(1),                 // injected by orchestrator from env DEPLOY_USER_HOME
  }),
},
```

### Manifest descriptor exposure

These entries appear in `GET /api/scripts/manifest` (feature 005's existing endpoint). The wizard does NOT use the generic Run dialog for bootstrap — orchestration goes through `POST /api/applications/bootstrap` and friends. The descriptor exposure is for ops visibility (an admin can see "the runner has these registered") and for the existing Runs page filter UI. The descriptor's `dangerLevel: high` on `bootstrap/hard-delete` makes the generic Run dialog refuse to dispatch without typed-confirm — a defence-in-depth layer in case an operator clicks Run on it manually instead of going through the app detail page.

### Transport details

All four `target`-locus entries use feature 005's standard `bash -s` stdin pipe with the common.sh override pattern (R-003 in feature 005). PAT routing for `bootstrap/clone` follows the env-var transport — the `pat` field is `.describe("secret")`, so feature 005's `serialiseParams` exports it as `SECRET_PAT='...'` inside the bash buffer; never on argv.

---

## Failure modes (consolidated)

### Write-time validation (400)

| Field | Failure | Error code |
|----|----|----|
| `name` | doesn't match slug regex | `INVALID_PARAMS` (`details.fieldErrors.name`) |
| `name` | already exists on server | `SLUG_COLLISION` |
| `domain` | wildcard / control char | `INVALID_PARAMS` |
| `domain` | already exists on server (feature 008 UNIQUE) | `DOMAIN_COLLISION` (delegated to 008's check) |
| `upstreamService`/`upstreamPort` | one set, other null | `INVALID_PARAMS` |
| `composePath` | absolute / contains `..` | `INVALID_PARAMS` |
| `remotePath` | exists with different repo | `REMOTE_PATH_COLLISION` |

### Runtime (state machine reflects in `bootstrap_state` + Telegram alert per FR-024)

| Step | Failure | DB state | `script_runs.status` |
|----|----|----|----|
| CLONING | PAT scope insufficient | `failed_clone` | `failed`; error_message="Authentication failed: PAT for connection X lacks repo scope. Reconnect GitHub" |
| CLONING | repo not found | `failed_clone` | `failed`; error_message="Repo X not accessible" |
| CLONING | disk full | `failed_clone` | `failed`; error_message="No space left on device" |
| CLONING | dir exists with different repo | `failed_clone` | `failed` (exit code 2); error_message="Directory exists with different repo" |
| COMPOSE_UP | broken compose syntax | `failed_compose` | `failed`; error_message captured from compose stderr |
| COMPOSE_UP | host port conflict | `failed_compose` | `failed`; error_message="port is already allocated" |
| HEALTHCHECK | container exits during startup | `failed_healthcheck` | `failed`; error_message="container exited within healthcheck window" |
| HEALTHCHECK | healthcheck never reaches healthy | `failed_healthcheck` | `timeout`; error_message="healthcheck did not turn healthy within Xms" (matches feature 006 FR-026) |
| PROXY_APPLIED | Caddy admin API unreachable | `failed_proxy` | `failed`; delegates to feature 008 retry flow (FR-009 there) |
| CERT_ISSUED | DNS not pointed | `failed_cert` | `failed`; pre-check warning was overridden by operator (feature 008 FR-014) |
| CERT_ISSUED | Let's Encrypt rate-limit | `failed_cert` | `failed`; error_message="Rate limit reached. Next slot at <ts>" |

---

## Wire format

camelCase JSON across all endpoints. DB columns are snake_case (`bootstrap_state`, `created_via`, etc.); routes convert via the Drizzle schema.

| Layer | Name |
|----|----|
| DB column | `bootstrap_state` |
| Drizzle schema field | `bootstrapState` |
| API request/response JSON key | `bootstrapState` |
| WS event field | `toState`, `fromState` (still camelCase) |
| Manifest descriptor `fields[].name` | kebab-case (`compose-path`, `upstream-service`) per feature 005 |

---

## Summary

- **6 new REST endpoints**: `GET /api/github/repos/:owner/:repo/compose`, `POST /api/applications/bootstrap`, `GET /api/applications/:id/bootstrap-state`, `POST /api/applications/:id/bootstrap/retry`, `PATCH /api/applications/:id/bootstrap/config`, `POST /api/applications/:id/hard-delete`.
- **2 new WS event types**: `bootstrap.state-changed`, `bootstrap.step-log`.
- **5 new manifest entries**: `bootstrap/clone`, `bootstrap/compose-up`, `bootstrap/wait-healthy`, `bootstrap/finalise`, `bootstrap/hard-delete`.
- **0 new error code categories** — reuse `INVALID_PARAMS`, `NOT_FOUND`, plus the new bootstrap-specific codes (`SLUG_COLLISION`, `REMOTE_PATH_COLLISION`, `BOOTSTRAP_IN_PROGRESS`, `BOOTSTRAP_NOT_FAILED`, `INVALID_TRANSITION`, `IMMUTABLE_FIELD`, `JAIL_ESCAPE`, `CONFIRM_MISMATCH`, `COMPOSE_NO_SERVICES`, `COMPOSE_PARSE_ERROR`, `GITHUB_REPO_NOT_ACCESSIBLE`, `HARD_DELETED`).
- **Three-layer PAT defence**: secret-marked Zod schema (DB+log mask) + env-var transport (no argv) + heredoc reconstruction inside script (no `git clone` URL on argv).

Proceed to `quickstart.md`.
