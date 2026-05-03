# Data Model: Zero-Touch VPS Onboarding & Secrets Management

**Date**: 2026-05-03 | **Branch**: `011-zero-touch-onboarding` | **Plan**: [plan.md](plan.md)

This document is the canonical reference for the schema additions
introduced by feature 011. Every column / table / index here MUST appear
in `devops-app/server/db/migrations/0010_zero_touch.sql` and
`devops-app/server/db/schema.ts`. Any drift = test failure (T001 of
generated tasks).

---

## Modified entities

### `servers` — 7 new columns

| Column | Type | Null | Default | FR | Notes |
|---|---|---|---|---|---|
| `ssh_private_key_encrypted` | TEXT | yes | NULL | FR-002, FR-004 | Envelope blob (jsonb-stringified `{ ct, iv, tag }`). Replaces plaintext `ssh_private_key` lazily. |
| `ssh_password_encrypted` | TEXT | yes | NULL | FR-004 (extended per gemini #3) | Envelope blob for the transient root password used during password-mode setup. Replaces plaintext `ssh_password`. Cleared (NULL) on successful Initialise per US1/US2 password-mutation edge case. |
| `ssh_key_fingerprint` | TEXT | yes | NULL | FR-016 | SHA256 of active client public key, format `SHA256:<base64-no-padding>`. NULL when no key configured (password-only mode during initial setup). |
| `ssh_key_rotated_at` | TEXT | yes | NULL | FR-016 | ISO-8601 UTC. NULL until first rotation; set at rotation Step 4 commit. |
| `host_key_fingerprint` | TEXT | yes | NULL | spec edge case "host key changed since last connection" (per github P0 #4) | SHA256 of the TARGET'S host key as observed during last successful connection. NULL until first connect. Compared on every reconnect; mismatch triggers MITM warning per US1 edge cases. |
| `cloud_provider` | TEXT | yes | NULL | FR-023, FR-024 | Enum `gcp \| aws \| do \| hetzner \| vanilla`. NULL during pre-detection. |
| `setup_state` | TEXT | no | `'unknown'` | FR-006 | Enum `unknown \| needs_initialisation \| initialising \| ready`. Drives Initialise button visibility. |

Existing relevant columns (recap, lazy-deprecated):

- `ssh_private_key` — plaintext, lazy-deprecated. R-011 lazy-migration on
  any UPDATE that touches the auth method.
- `ssh_password` — plaintext, lazy-deprecated. R-004 (revised) writes new
  passwords to `ssh_password_encrypted` instead; existing plaintext
  values rotated on next edit.

**State transitions for `setup_state`** (driven by `server-onboarding.ts`
+ `server-bootstrap.ts`):

```
unknown ──┬─ compatibility-probe sees no docker / no deploy user / no fail2ban ──▶ needs_initialisation
          └─ compatibility-probe sees all required tooling ──▶ ready

needs_initialisation ── operator clicks Initialise ──▶ initialising

initialising ──┬─ setup-vps.sh exits 0 + post-probe ok ──▶ ready
               └─ setup-vps.sh exits non-0 OR post-probe fail ──▶ needs_initialisation (allows retry)

ready ── compatibility-probe re-run sees regression ──▶ needs_initialisation (rare)
```

No `failed_*` sub-states for setup — failure is recoverable by re-running
Initialise (idempotent per FR-010). Live progress comes from script-runner
+ file-tail modal, not from the column.

### `applications` — 1 new column

| Column | Type | Null | Default | FR | Notes |
|---|---|---|---|---|---|
| `env_vars_encrypted` | JSONB | yes | NULL | FR-011, FR-014 | Per-key envelope blobs: `{ "VAR_NAME": { ct, iv, tag }, ... }`. NULL when no encrypted vars yet. |

Existing relevant column:

- `env_vars` — plaintext jsonb, lazy-deprecated. First save through the
  new editor moves all values to `env_vars_encrypted` and replaces
  `env_vars` with `'{}'::jsonb`.

**Read precedence** (`env-vars-store.ts:load`):

```
if env_vars_encrypted is non-null → return decrypted map
else if env_vars is non-empty → return plaintext map (legacy)
else → return {}
```

**Invariants**:

- After any successful write through the new editor, `env_vars` MUST be
  `'{}'::jsonb` for that row. Validation: integration test
  `env-vars-editor-deploy.test.ts` asserts post-edit row state.
- `env_vars_encrypted` keys MUST match the regex `^[A-Z_][A-Z0-9_]*$` (POSIX
  env-var name) — validated server-side in the route.

### `audit_entries` — new event types

Additions to the existing FR-026 catalogue:

| Action | Payload shape |
|---|---|
| `server.added` | `{ serverId, authMethod: 'key' \| 'password' \| 'generated', keyFingerprint?: string, cloudProvider?: string }` |
| `server.initialised` | `{ serverId, deployUser, options: { swapSize, ufwPorts, useNoPty } }` |
| `server.key_rotated` | `{ serverId, oldFingerprint, newFingerprint }` |
| `app.env_vars_changed` | `{ appId, addedKeys: string[], removedKeys: string[], changedKeys: string[] }` (no values, ever) |
| `app.env_vars_imported_from_example` | `{ appId, importedKeys: string[], changeMeKeys: string[] }` |
| `notification.dropped.telegram_unconfigured` | `{ eventType, resourceId? }` |
| `notification.dropped.throttled` | `{ eventType, resourceId, reason: 'cooldown' \| 'token_bucket', suppressedCount?: number }` |
| `notification.dropped.delivery_failed` | `{ eventType, resourceId, httpStatus, tgErrorCode?, tgErrorDescription?, retryCount }` |
| `notification.settings_changed` | `{ field: 'telegram_token' \| 'telegram_chat_id' \| 'event_preference', eventType?: string, newEnabled?: boolean }` (token value never logged) |

---

## New entities

### `notification_preferences`

```sql
CREATE TABLE "notification_preferences" (
  "event_type" TEXT PRIMARY KEY,
  "enabled" BOOLEAN NOT NULL,
  "updated_at" TEXT NOT NULL DEFAULT (
    to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  )
);
```

| Column | Type | Notes |
|---|---|---|
| `event_type` | TEXT PK | Canonical event identifier from `event-catalogue.ts`. No FK — orphan rows ignored at dispatch. |
| `enabled` | BOOLEAN | Current toggle state. |
| `updated_at` | TEXT | ISO-8601 UTC, set by code on every UPDATE (DEFAULT only fires on INSERT). |

**Seeding**: NOT in SQL. On dashboard boot, `event-catalogue.ts` is
walked; for any catalogue entry with no row in `notification_preferences`,
INSERT with the catalogue's declared default. This keeps the source of
truth in code (FR-030 typecheck-enforced) — if you add a new event without
a default declaration, typecheck fails before the row can exist.

**Orphan handling**: Row exists for `event_type` but catalogue has no
matching entry → `notification-gate.ts` ignores the row at dispatch
lookup (`catalogue.has(eventType)` check). Cleanup is a code-side concern
(cron / migration); no DB-level FK to enforce.

### `notification_settings` (singleton)

```sql
CREATE TABLE "notification_settings" (
  "id" INTEGER PRIMARY KEY CHECK ("id" = 1),
  "telegram_bot_token_encrypted" TEXT NULL,
  "telegram_chat_id" TEXT NULL,
  "telegram_last_test_at" TEXT NULL,
  "telegram_last_test_ok" BOOLEAN NOT NULL DEFAULT FALSE,
  "updated_at" TEXT NOT NULL
);

INSERT INTO "notification_settings" ("id", "updated_at")
VALUES (1, to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
```

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | INTEGER PK | no | Always 1 (`CHECK (id = 1)`). Singleton enforcement, precedent: `github_connection`. |
| `telegram_bot_token_encrypted` | TEXT | yes | Envelope blob (jsonb-stringified `{ ct, iv, tag }`). NULL = not configured. |
| `telegram_chat_id` | TEXT | yes | Plaintext (numeric `-100...` or `@channelname`). NULL = not configured. |
| `telegram_last_test_at` | TEXT | yes | ISO-8601 UTC of most recent Test Connection (success or fail). |
| `telegram_last_test_ok` | BOOLEAN | no | Last test outcome. Drives "needs reconfiguration" banner per FR-036/042. |
| `master_key_canary` | TEXT | yes | Envelope-sealed canary value (per gemini #1) — sealed at first boot with literal string `"ok"`. Boot-time decrypt attempt: fail → master key mismatch → fail-fast crash with actionable error. NULL on fresh install before first seal. |
| `updated_at` | TEXT | no | ISO-8601 UTC, set on every UPDATE. |

**Invariants**:

- Exactly one row, ever (`CHECK (id = 1)`).
- Row exists from migration time forward — no need for "create if not
  exists" logic in code.
- `telegram_bot_token_encrypted IS NULL XOR telegram_chat_id IS NULL` is
  NOT enforced — operator can paste token without chat ID (or vice versa)
  in a partial save flow. Effective "is configured?" check is
  `token IS NOT NULL AND chat_id IS NOT NULL AND last_test_ok = TRUE`.

---

## Code-side catalogue: `event-catalogue.ts`

Single source of truth for notifiable events. Schema:

```ts
type EventDefault = "on" | "off";

export interface EventCatalogueEntry {
  type: string;             // canonical event identifier, e.g. "deploy.failed"
  description: string;      // plain-language for Settings UI
  defaultEnabled: boolean;  // seeded on dashboard boot
  category: "failure" | "security" | "success" | "operational";
}

export const EVENT_CATALOGUE: ReadonlyArray<EventCatalogueEntry> = [
  // Failure events — defaults ON
  { type: "deploy.failed", description: "Deploy failed", defaultEnabled: true, category: "failure" },
  { type: "server.init.failed", description: "Server initialisation failed", defaultEnabled: true, category: "failure" },
  { type: "key.rotation.failed", description: "SSH key rotation failed", defaultEnabled: true, category: "failure" },
  { type: "healthcheck.degraded", description: "App health degraded", defaultEnabled: true, category: "failure" },
  { type: "cert.issuance.failed", description: "TLS cert issuance failed", defaultEnabled: true, category: "failure" },
  { type: "caddy.unreachable", description: "Caddy admin API unreachable", defaultEnabled: true, category: "failure" },

  // Security events — defaults ON
  { type: "server.added", description: "Server added", defaultEnabled: true, category: "security" },
  { type: "server.initialised", description: "Server initialised", defaultEnabled: true, category: "security" },
  { type: "key.rotated", description: "SSH key rotated", defaultEnabled: true, category: "security" },
  { type: "env_vars.changed", description: "App environment variables changed", defaultEnabled: true, category: "security" },

  // Success events — defaults OFF
  { type: "deploy.succeeded", description: "Deploy succeeded", defaultEnabled: false, category: "success" },
  { type: "server.init.succeeded", description: "Server initialisation completed", defaultEnabled: false, category: "success" },
  { type: "healthcheck.recovered", description: "App health recovered", defaultEnabled: false, category: "success" },
  { type: "caddy.recovered", description: "Caddy recovered", defaultEnabled: false, category: "success" },

  // Operational — defaults ON
  { type: "cert.expiring", description: "TLS cert expiring soon", defaultEnabled: true, category: "operational" },
];

// Compile-time guarantee: every entry has a defaultEnabled declared.
// Test event-catalogue.test.ts also verifies `type` uniqueness +
// `Set(types).size === EVENT_CATALOGUE.length`.
```

**FR-030 enforcement**: A new event added without `defaultEnabled` fails
TypeScript (interface field non-optional). A duplicate `type` fails the
companion test. A code-level pre-commit script (optional, v2) could verify
no `type` is referenced from `notification-gate.ts:dispatch` calls without
appearing in `EVENT_CATALOGUE`.

---

## In-memory state shapes (notification-gate.ts)

Not DB; documented here because tests assert on them.

```ts
interface CooldownEntry {
  pairKey: string;                    // `${eventType}::${resourceId}`
  firstSendAt: number;                // Date.now() of last delivered message in window
  suppressedSinceLastSend: number;    // counter, exposed in next message body
}

interface TokenBucketState {
  tokens: number;                     // current token count (0..MAX)
  lastRefillAt: number;               // Date.now() of last refill calculation
}

const COOLDOWN_WINDOW_MS = 5 * 60 * 1000;   // 5 minutes per FR-038
const BUCKET_MAX = 20;                       // 20 messages global per FR-038
const BUCKET_REFILL_PER_MIN = 20;            // refilled to MAX over 60s
```

**Reset on dashboard restart**: maps cleared, tokens = MAX. Per R-007 +
A-007.

---

## Cross-feature interactions

### Feature 002 — github_connection

The PAT-storage envelope pattern (feature 002) is the precedent for our
envelope-cipher.ts. Both use the same master key
(`DASHBOARD_MASTER_KEY`). v2 master-key rotation must re-seal both
storages atomically.

### Feature 004 — deploy_locks

`ssh-key-rotation.ts` calls `deployLock.acquire(serverId, "ssh-rotate")`
before Step 2. Concurrent deploys on the same server queue until rotation
releases the lock.

### Feature 005 — scripts_runner

`server-bootstrap.ts` invokes `scriptsRunner.runScript("server-ops/initialise",
serverId, { deployUser, swapSize, ufwPorts, useNoPty }, userId, opts)`.
The new manifest entry wraps `scripts/server/setup-vps.sh`.

### Feature 008 — app_settings

The singleton-row pattern (`app_settings.acme_email`) is the precedent
for `notification_settings`. Same `CHECK (id = ...)` enforcement.

### Feature 009 — file-tail modal

InitialiseWizard's "Live progress" step subscribes to the same WS
event channel feature 009 introduced (`script.run.tail`). No new WS
event types needed.

---

## Index strategy

- `notification_preferences` — PK on `event_type` is the only access path
  needed (lookup at dispatch). No additional indexes.
- `notification_settings` — singleton, no indexes.
- `servers.setup_state` — added to existing index
  `idx_servers_status_setup_state` (composite with `status`) so
  ServerListPage can filter `WHERE setup_state = 'needs_initialisation'`
  cheaply.

```sql
CREATE INDEX "idx_servers_status_setup_state"
  ON "servers" ("status", "setup_state");
```

---

## Validation rules summary

| FR | Rule | Enforced by |
|---|---|---|
| FR-002 | Generated private key never returned via API after initial save | `serializeServer()` whitelist excludes `ssh_private_key_encrypted`, `ssh_private_key`, `ssh_password` |
| FR-004 | Decryption only inside `sshPool` / `EnvVarsStore.decryptForDispatch` / `TelegramChannel.send` | Code review; Pino redact catches accidental leaks |
| FR-008 | Deploy user name regex `^[a-z][a-z0-9_-]{0,31}$` | Zod schema in route + client validation |
| FR-014 | Decrypted env values never in audit logs / API responses | `env-vars-store.ts:load` returns plaintext only via dispatch path; serialiser whitelist excludes |
| FR-022 | Save blocked when any compatibility row is `fail` | Server-side route check on POST /servers; client-side button disabled |
| FR-029 | Toggle flip persists immediately, no Save button | `useNotificationSettings.ts` mutates on switch onChange |
| FR-031 | Disabled events MUST NOT count against rate limit | gate checks preferences BEFORE bucket consumption |
| FR-032 | `audit_entries` writes unconditional | gate writes audit before preferences check |
| FR-035 | TG bot token persisted envelope-encrypted | `notification-settings-store.ts` calls `seal()` on every PUT |
| FR-038 | Cooldown 5 min + bucket 20/min hardcoded | constants in `notification-gate.ts`, no UI exposure |

---

## Migration test fixtures (referenced by tests)

`tests/fixtures/server-rows.ts` — pre/post-migration row shapes for
upgrade testing:

```ts
export const SERVER_ROW_PRE = {
  id: "srv_legacy",
  // ... existing columns ...
  ssh_private_key: "-----BEGIN OPENSSH PRIVATE KEY-----\n...\n-----END...",
  // (no ssh_private_key_encrypted yet)
};

export const SERVER_ROW_POST_MIGRATE = {
  // After ALTER TABLE 0010, new columns present:
  ssh_private_key_encrypted: null,    // not yet edited
  ssh_key_fingerprint: null,
  ssh_key_rotated_at: null,
  cloud_provider: null,
  setup_state: "unknown",             // DEFAULT applied
  ssh_private_key: "-----BEGIN...",   // legacy column UNCHANGED
};

export const SERVER_ROW_POST_FIRST_EDIT = {
  // After first PATCH /servers/:id that touches auth:
  ssh_private_key_encrypted: '{"ct":"...","iv":"...","tag":"..."}',
  ssh_key_fingerprint: "SHA256:abcd...",
  ssh_private_key: null,              // moved to encrypted, plaintext NULLed
};
```

Same pattern for `applications` plaintext → encrypted backfill assertions.
