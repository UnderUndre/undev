# API Contracts: Zero-Touch VPS Onboarding & Secrets Management

**Date**: 2026-05-03 | **Branch**: `011-zero-touch-onboarding` | **Plan**: [../plan.md](../plan.md)

All endpoints are under `/api`. All bodies are JSON. All endpoints
require auth (existing session middleware) and emit `audit_entries` per
FR-026. Bodies are validated with Zod (CLAUDE.md AGCG); the schemas
shown here are the contract — the route's Zod schema MUST match exactly.

---

## Server lifecycle

**Revised per github P0 #1 + P0 #2 + P1 #1 review feedback.** The
original draft conflated "test the connection before committing" with
"create the server row" into a single endpoint, leaving `:id` ambiguous
for the pre-create probe. The flow now splits into:

1. `POST /api/servers/probe` — stateless probe, no DB write. Returns
   what Add Server would create. Operator iterates until satisfied.
2. `POST /api/servers` — final commit using a probe-token returned by
   step 1, so the server doesn't repeat the (expensive) probe.

### `POST /api/servers/probe` — pre-save probe (NEW per github P0 #1)

**Request**:

```ts
const ProbeBody = z.object({
  host: z.string().min(1).max(253),
  port: z.number().int().min(1).max(65535).default(22),
  sshUser: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/),

  // bootstrapAuth — "how do I get onto this VPS RIGHT NOW" — disposable
  bootstrapAuth: z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("paste-key"), privateKey: z.string().min(1) }),
    z.object({ mode: z.literal("paste-password"), password: z.string().min(1) }),
    z.object({ mode: z.literal("generate-key") }),  // dashboard generates Ed25519
  ]),
});
```

**Response 200**:

```ts
const ProbeResponse200 = z.object({
  probeToken: z.string(),               // opaque, ~10min TTL, replayable to POST /api/servers
  hostKeyFingerprint: z.string(),       // SHA256 of target's host key (per github P0 #4)
  hostKeyMismatch: z.object({           // present iff a previous probe of this host had a different fingerprint
    previous: z.string(),
    current: z.string(),
  }).nullable(),
  generatedPublicKey: z.string().nullable(),  // generate-key mode only
  compatibility: CompatibilityReport,
  cloudProvider: z.enum(["gcp", "aws", "do", "hetzner", "vanilla"]),
  identity: z.object({ whoami: z.string(), id: z.string(), uname: z.string() }),
});
```

**Response 401** — SSH auth failed: `{ error: "ssh_auth_failed", detail }`.

**Probe token**: opaque server-side cache key (10 min TTL) holding the
probe results AND the bootstrapAuth (so generate-key mode doesn't have to
re-generate on POST /api/servers). Token never persisted; in-memory
`Map<token, ProbeCacheEntry>`. Replay attack mitigation: token is
single-use — first POST /api/servers consumes and removes it.

### `POST /api/servers` — final commit using probe token

**Request**:

```ts
const Body = z.object({
  probeToken: z.string(),               // from /probe response — single-use
  label: z.string().min(1).max(64),

  // managedSshCredential — "what does the dashboard use long-term"
  // (per github P0 #2 split)
  managedSshCredential: z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("reuse-bootstrap-key") }),  // copy bootstrap key into managed slot
    z.object({ mode: z.literal("use-generated-key") }),     // valid only if probe was generate-key mode
    z.object({ mode: z.literal("generate-fresh") }),         // generate a NEW Ed25519 separate from bootstrap
  ]),

  // Optional advanced settings — sensible defaults so operators of
  // fresh VPSes don't have to think about these (per github P1 #1)
  scriptsPath: z.string().min(1).default("/opt/dashboard-scripts"),
  scanRoots: z.array(z.string()).default(["/opt", "/srv", "/var/www", "/home"]),

  // US5 — explicit per-row warn acknowledgement
  acknowledgedWarnings: z.array(z.string()).default([]),

  // Host key trust decision — required if hostKeyMismatch was present in probe
  acceptHostKeyChange: z.boolean().default(false),
});
```

**Response 201**:

```ts
const Response201 = z.object({
  server: ServerSerialised,
  managedPublicKey: z.string().nullable(),  // surfaced ONCE for operator to install if not already installed
});
```

**Response 401** — bootstrapAuth no longer works (token expired between
probe and commit): `{ error: "probe_token_expired", detail }`.

**Response 422** — compatibility report from the cached probe has
unresolved `fail` rows OR unacknowledged `warn` rows (per github P1 #4
+ semantic correctness, replacing the earlier 400):

```ts
const Response422 = z.object({
  error: z.literal("compatibility_unresolved"),
  failRows: z.array(z.string()),         // checkIds with fail status
  unacknowledgedWarns: z.array(z.string()),
});
```

**Response 409** — host key mismatch and `acceptHostKeyChange === false`:

```ts
const Response409 = z.object({
  error: z.literal("host_key_changed"),
  previous: z.string(),
  current: z.string(),
  detail: z.string(),
});
```

**Side effects**:

1. Probe token consumed (removed from cache).
2. `bootstrapAuth` persisted: password → `ssh_password_encrypted`, key →
   `ssh_private_key_encrypted` per `managedSshCredential` mode.
3. `host_key_fingerprint` persisted from probe result.
4. `setup_state` derived from probe compatibility: any `fail` (without
   "auto-fixable by Initialise" marker) → `unknown` (shouldn't reach 422);
   any `warn` with auto-fixable marker → `needs_initialisation`; all
   `pass` → `ready`.
5. Audit `server.added` with `cloud_provider`, `bootstrap_auth_mode`,
   `managed_credential_mode`, `host_key_fingerprint`.

---

### `POST /api/servers/:id/initialise` — run Initialise wizard

**Request**:

```ts
const Body = z.object({
  deployUser: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/).default("deploy"),
  swapSize: z.string().regex(/^\d+G$/).default("2G"),
  ufwPorts: z.array(z.number().int().min(1).max(65535)).default([22, 80, 443]),
  useNoPty: z.boolean().default(false),  // default inferred from cloud_provider
  typedAcknowledgement: z.literal("INITIALISE"),  // FR-007 typed-confirm
});
```

**Response 202** — accepted, runs async:

```ts
const Response202 = z.object({
  scriptRunId: z.string(),               // feature 005 script_runs.id
  wsTopic: z.string(),                   // subscribe for live progress
});
```

**Side effects**:

1. `setup_state` → `'initialising'`.
2. `scriptsRunner.runScript("server-ops/initialise", serverId, params, userId)`
   dispatched.
3. On success: `setup_state` → `'ready'`, audit `server.initialised`,
   notification `server.init.succeeded` dispatched (gated by preferences).
4. On failure: `setup_state` → `'needs_initialisation'` (allows retry),
   notification `server.init.failed` dispatched.
5. Live progress streams via existing `script.run.tail` WS topic
   (feature 009 file-tail modal pattern).

---

### `POST /api/servers/:id/compatibility` — re-run compatibility probe

**Request**: empty body.

**Response 200**:

```ts
const Response200 = z.object({
  report: CompatibilityReport,
  cloudProvider: z.enum(["gcp", "aws", "do", "hetzner", "vanilla"]),
  setupState: z.enum(["unknown", "needs_initialisation", "initialising", "ready"]),
});
```

**Side effects**: updates `cloud_provider` + `setup_state` columns.

---

### `POST /api/servers/:id/rotate-key` — atomic SSH key rotation

**Request**:

```ts
const Body = z.object({
  removeOldKeyFromTarget: z.boolean().default(true),  // Step 5 toggle
  typedAcknowledgement: z.literal("ROTATE"),           // typed confirm
});
```

**Response 200**:

```ts
const Response200 = z.object({
  newFingerprint: z.string(),
  oldFingerprint: z.string(),
  rotatedAt: z.string(),
  oldKeyRemovedFromTarget: z.boolean(),
});
```

**Response 409** — deploy lock held:

```ts
const Response409 = z.object({
  error: z.literal("deploy_in_progress"),
  retryAfterMs: z.number().int(),
});
```

**Response 500** — rotation failed mid-flow, rolled back:

```ts
const Response500 = z.object({
  error: z.literal("rotation_failed"),
  failedAtStep: z.enum(["generate", "install_pubkey", "verify_new_key", "swap_db", "remove_old_key"]),
  rolledBack: z.boolean(),               // true unless Step 5 partial
  detail: z.string(),
});
```

---

## Per-app env vars

### `PATCH /api/applications/:id/env-vars` — update env vars

**Request**:

```ts
const Body = z.object({
  vars: z.record(
    z.string().regex(/^[A-Z_][A-Z0-9_]*$/),  // POSIX env name
    z.string(),                               // value (may contain =, newlines, etc)
  ),
  acknowledgePlaceholders: z.boolean().default(false),  // FR-015 confirm
});
```

**Response 200**:

```ts
const Response200 = z.object({
  app: ApplicationSerialised,             // env_vars_encrypted reflected; values omitted
  changedKeys: z.array(z.string()),
  removedKeys: z.array(z.string()),
  addedKeys: z.array(z.string()),
});
```

**Response 400** — placeholder-style values present and not acknowledged:

```ts
const Response400 = z.object({
  error: z.literal("placeholder_values_detected"),
  changeMeKeys: z.array(z.string()),       // keys whose values match CHANGE_ME pattern
});
```

**Side effects**:

1. Each value sealed with `envelope-cipher.seal()`.
2. `env_vars_encrypted` UPDATE; legacy `env_vars` set to `{}`.
3. Audit `app.env_vars_changed` with key lists (NEVER values).

---

### `POST /api/applications/:id/env-vars/import` — import from .env.example

**Request**:

```ts
const Body = z.object({
  mode: z.enum(["merge"]).default("merge"),  // v1: merge only (OQ-002 deferred to v2)
});
```

**Response 200**:

```ts
const Response200 = z.object({
  importedKeys: z.array(z.string()),
  changeMeKeys: z.array(z.string()),       // keys with CHANGE_ME-style placeholder values
  skippedKeys: z.array(z.string()),        // keys that already existed
});
```

**Response 404** — `.env.example` not found in cloned repo:

```ts
const Response404 = z.object({
  error: z.literal("env_example_not_found"),
});
```

**Side effects**:

1. Reads `.env.example` over SSH from `application.remotePath`.
2. Parses key=value lines (comments stripped, blank lines ignored).
3. New keys added to `env_vars_encrypted`; existing keys NOT touched.
4. Audit `app.env_vars_imported_from_example`.

---

## Notification settings

### `GET /api/settings/notifications` — current state

**Response 200**:

```ts
const Response200 = z.object({
  telegram: z.object({
    botTokenConfigured: z.boolean(),       // true iff token != null
    chatId: z.string().nullable(),
    lastTestAt: z.string().nullable(),
    lastTestOk: z.boolean(),
  }),
  events: z.array(z.object({
    type: z.string(),
    description: z.string(),
    category: z.enum(["failure", "security", "success", "operational"]),
    enabled: z.boolean(),
    defaultEnabled: z.boolean(),
  })),
});
```

NOTE: `botToken` value NEVER returned — only `botTokenConfigured` boolean.

---

### `PUT /api/settings/notifications/telegram` — update TG config

**Request**:

```ts
const Body = z.object({
  botToken: z.string().regex(/^\d+:[A-Za-z0-9_-]{30,}$/).nullable(),  // null clears
  chatId: z.string()
    .regex(/^(@[A-Za-z][A-Za-z0-9_]{4,31}|-?\d{1,16})$/)
    .nullable(),
});
```

**Response 200**: same shape as `GET /api/settings/notifications`.

**Side effects**:

1. Token sealed with `envelope-cipher.seal()` if non-null.
2. `telegram_last_test_ok` reset to `false` on any change (operator must
   re-test).
3. Audit `notification.settings_changed` with field name (NEVER token value).

---

### `POST /api/settings/notifications/telegram/test` — Test connection

**Request**: empty body.

**Response 200** — test succeeded:

```ts
const Response200 = z.object({
  ok: z.literal(true),
  testedAt: z.string(),
});
```

**Response 502** — test failed:

```ts
const Response502 = z.object({
  ok: z.literal(false),
  testedAt: z.string(),
  httpStatus: z.number().int().nullable(),
  tgErrorCode: z.number().int().nullable(),
  tgErrorDescription: z.string().nullable(),
  classification: z.enum(["transient", "permanent", "unconfigured"]),
});
```

**Side effects**:

1. Sends a probe message ("Dashboard test connection at <ISO>") via
   `TelegramChannel.send` direct (bypasses gate).
2. Updates `telegram_last_test_at` + `telegram_last_test_ok`.

---

### `PUT /api/settings/notifications/events/:eventType` — toggle one event

**Request**:

```ts
const Body = z.object({
  enabled: z.boolean(),
});
```

**Response 200**:

```ts
const Response200 = z.object({
  eventType: z.string(),
  enabled: z.boolean(),
  updatedAt: z.string(),
});
```

**Response 404** — `eventType` not in catalogue:

```ts
const Response404 = z.object({
  error: z.literal("unknown_event_type"),
});
```

**Side effects**: row UPSERTed into `notification_preferences`. Audit
`notification.settings_changed`.

---

## Shared types

### `ServerSerialised`

```ts
const ServerSerialised = z.object({
  id: z.string(),
  label: z.string(),
  host: z.string(),
  port: z.number().int(),
  sshUser: z.string(),
  sshAuthMethod: z.enum(["key", "password"]),
  // SSH private key NEVER serialised (plain or encrypted)
  // SSH password (plain or encrypted) NEVER serialised
  sshKeyFingerprint: z.string().nullable(),     // client key fingerprint
  sshKeyRotatedAt: z.string().nullable(),
  hostKeyFingerprint: z.string().nullable(),    // target's host key (per github P0 #4)
  scriptsPath: z.string(),
  status: z.enum(["online", "offline", "unknown"]),
  setupState: z.enum(["unknown", "needs_initialisation", "initialising", "ready"]),
  cloudProvider: z.enum(["gcp", "aws", "do", "hetzner", "vanilla"]).nullable(),
  lastHealthCheck: z.string().nullable(),
  scanRoots: z.array(z.string()),
  createdAt: z.string(),
});
```

### `ApplicationSerialised` (envVars excluded)

Existing shape per features 001-009 plus `envVarsKeys: string[]` —
list of keys from `env_vars_encrypted` (or legacy `env_vars`). Values
NEVER returned.

```ts
const ApplicationSerialised = z.object({
  // ... existing fields ...
  envVarsKeys: z.array(z.string()),       // names only
  envVarsEncryptedAt: z.string().nullable(), // when last sealed (v2 hint)
});
```

### `CompatibilityReport`

```ts
const CompatibilityCheck = z.object({
  id: z.enum([
    "ssh_connection",
    "sudo_nopasswd",
    "use_pty_set",
    "docker_installed",
    "disk_free_gb",
    "swap_configured",
    "os_family_version",
    "architecture",
  ]),
  // Per github P0 #3 + research.md R-010 warn/fail matrix.
  // "auto-fixable by Initialise" checks (docker missing, swap absent,
  // use_pty set) MUST come back as `warn` not `fail` — Save proceeds
  // with warn-acknowledgement and resulting setup_state will be
  // `needs_initialisation`. Hard `fail` is reserved for unfixable
  // conditions (no SSH, sudo absent, non-Linux, etc).
  status: z.enum(["pass", "warn", "fail"]),
  summary: z.string(),                    // plain-language one-liner
  remediation: z.object({                  // optional one-click fix
    label: z.string(),
    action: z.enum(["initialise", "edit-server", "manual"]),
  }).nullable(),
  autoFixableByInitialise: z.boolean(),    // true ⇒ warn (not fail) per matrix
  raw: z.unknown().optional(),             // probe output for debugging
});

const CompatibilityReport = z.object({
  checks: z.array(CompatibilityCheck),
  overall: z.enum(["pass", "warn", "fail"]),  // worst row
  hints: z.array(z.string()),              // cloud-provider hint banners (US6)
});
```

---

## Manifest entry: `server-ops/initialise`

Added to `devops-app/server/scripts-manifest.ts`:

```ts
{
  id: "server-ops/initialise",
  category: "server-ops",
  description: "Initialise a fresh VPS (deploy user, hardening, docker, swap, ufw)",
  locus: "target",
  requiresLock: true,                     // serialise vs deploys
  timeout: 1_200_000,                     // 20 min — apt-get can be slow
  dangerLevel: "medium",
  params: z.object({
    deployUser: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/),
    swapSize: z.string().regex(/^\d+G$/),
    ufwPorts: z.array(z.number().int().min(1).max(65535)),
    useNoPty: z.boolean(),
    pubkey: z.string().min(1),             // OpenSSH public key to install for deploy user
  }),
}
```

The script `scripts/server/setup-vps.sh` is invoked with these params
exported as `INITIALISE_*` env vars (existing manifest convention).
The script must already accept `INITIALISE_DEPLOY_USER`,
`INITIALISE_SWAP_SIZE`, `INITIALISE_UFW_PORTS`, `INITIALISE_USE_NO_PTY`,
`INITIALISE_PUBKEY` — verify in Phase 0 and add the parameter parsing
section to the script if absent.

---

## WebSocket events

Reused from existing infra:

| Topic | Payload | When |
|---|---|---|
| `script.run.tail` (feature 009) | `{ scriptRunId, line, timestamp }` | Every stdout/stderr line during Initialise |
| `script.run.complete` (feature 005) | `{ scriptRunId, exitCode, durationMs }` | On script-runner finalisation |

No new WS event types added by this feature.

---

## Error response convention

All 4xx/5xx responses follow existing `AppError` shape (feature 001):

```ts
{
  error: string,                   // canonical error code (e.g. "ssh_auth_failed")
  message: string,                 // human-readable
  detail?: unknown,                // structured context
  requestId: string,               // for log correlation
}
```

Per CLAUDE.md AGCG: never `throw new Error()` raw; use the existing
`AppError.badRequest()`, `AppError.notFound()`, `AppError.conflict()`,
`AppError.internal()` factory methods.
