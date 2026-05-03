## Implementation Plan: Zero-Touch VPS Onboarding & Secrets Management

**Branch**: `011-zero-touch-onboarding` | **Date**: 2026-05-03 | **Spec**: [spec.md](spec.md)

## Summary

Wire seven existing-but-disconnected capabilities into one operator-facing flow:
**Add Server → Initialise → Per-app env vars → SSH key rotation → Pre-flight
compatibility → Cloud-provider hints → Configurable Telegram notifications.**
No new shell logic — existing `setup-vps.sh` / `env-setup.sh` /
`install-caddy.sh` / `health-check.sh` are reused via feature 005's
`scriptsRunner`. The work is UI glue + a small set of new server services
(SSH keypair generation, envelope-encryption wrapper, cloud-init probe,
notification-gate, env-vars store) + one additive migration (`0010_zero_touch.sql`)
+ one notifier rewire (env-var config → DB-backed config + per-event toggle +
generic throttling + retry).

Architectural shape:

- **DB row = source of truth** for server lifecycle state (`servers.setup_state`)
  and per-event notification preferences (`notification_preferences`).
- **Singleton settings rows** for shared TG channel config (`notification_settings`),
  matching the `app_settings` precedent (feature 008).
- **Envelope encryption** wraps three secret materials with the same master
  key from env: SSH private keys (replaces existing plaintext `ssh_private_key`),
  per-app env vars (`applications.env_vars_encrypted`), TG bot token
  (`notification_settings.telegram_bot_token_encrypted`).
- **Notification gate** sits between event emitters and `notifier.ts`'s send
  path: per-event preferences check → per-pair cooldown → global token bucket →
  retry classification. Existing `notifier.notifyAppHealthChange` etc. become
  thin leaf-callers that hand a payload + event-type string to the gate.
- **Initialise wizard** reuses feature 005's runner (`scripts-runner.ts`) for
  `setup-vps.sh` dispatch and feature 009's file-tail modal for live progress
  streaming. New manifest entry `server-ops/initialise` wraps the existing
  shell script.
- **SSH onboarding** uses Node's built-in `crypto.generateKeyPairSync('ed25519', ...)`
  — no `ssh-keygen` shellout, no new npm dep — and `ssh2`'s existing password
  auth path for one-time root setup.
- **Cloud-init probes** are HTTP fetches over the SSH session (curl 169.254.169.254
  with provider headers), parsed against a code-defined provider table.
  No new endpoint listeners on the dashboard.

Backward compatibility: existing `servers.ssh_private_key` and
`applications.env_vars` plaintext columns stay NULLable, lazy-migrated to their
`*_encrypted` siblings on first edit. Existing TG env-var fallbacks
(`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`) are removed in v1 — operators
configure via UI only (per [Q3 clarification](spec.md#clarifications)).

## Technical Context

**Existing stack** (inherited 001–009):

- Express 5 + React 19 / Vite 8 / Tailwind 4
- drizzle-orm 0.45 + `postgres` 3.4
- `ssh2` 1.17 via `sshPool` (`server/services/ssh-pool.ts`) — `execStream`
  remote-exec, `executeWithStdin` for stdin pipe (feature 005), password +
  pubkey auth supported
- `scriptsRunner.runScript(scriptId, serverId, params, userId, opts)` (feature
  005) + `scripts-manifest.ts` Zod-validated entries
- `deployLock` (feature 004) — per-server advisory lock; SSH key rotation
  acquires (FR-018)
- `notifier` singleton (`server/services/notifier.ts`) — env-var TG config,
  `notifyAppHealthChange/notifyCertExpiring/notifyCaddyUnreachable/notifyCaddyRecovered/notifyCertIssuanceFailed`,
  60s leading-edge + trailing-summary coalesce for health events
- `auditMiddleware` (feature 001) — every action emits `audit_entries`
- File-tail modal (feature 009 incident 2026-05-02 fix) for live script output
- Pino structured logger with redact config

**Existing scripts** (execution layer — not modified):

- `scripts/server/setup-vps.sh` — deploy user, SSH hardening, swap, ufw,
  fail2ban, docker (idempotent)
- `scripts/server/install-caddy.sh` — reverse proxy install
- `scripts/server/health-check.sh` — post-setup health probe
- `scripts/deploy/env-setup.sh` — `.env.example` → `.env` materialisation

**New for this feature**:

- One new migration: `devops-app/server/db/migrations/0010_zero_touch.sql`
  (next sequence after feature 009's `0009_*`).
- Five new columns on `servers`: `ssh_private_key_encrypted`, `ssh_key_fingerprint`,
  `ssh_key_rotated_at`, `cloud_provider`, `setup_state`.
- One new column on `applications`: `env_vars_encrypted JSONB`.
- Two new tables: `notification_preferences`, `notification_settings` (singleton).
- New audit event types: `server.added`, `server.initialised`, `server.key_rotated`,
  `app.env_vars_changed`, `app.env_vars_imported_from_example`,
  `notification.dropped.telegram_unconfigured`,
  `notification.dropped.throttled`, `notification.dropped.delivery_failed`,
  `notification.settings_changed`.
- Nine new server services / libs (see Project Structure).
- One manifest entry: `server-ops/initialise` wrapping `setup-vps.sh`.
- Three new HTTP route files / sub-routes (`servers.ts` extended,
  `notification-settings.ts` new, env-vars sub-routes on `apps.ts`).
- Eight new client components (Settings → SSH Keys, Settings → Notifications,
  Initialise wizard, Compatibility report, Env vars editor, etc).
- No new npm dependencies. Ed25519 generation uses Node's `crypto.generateKeyPairSync`.
  Envelope encryption uses Node's `crypto.createCipheriv('aes-256-gcm', ...)`.
  TG HTTP via existing `fetch`. Cloud-init probes via SSH-side `curl` (already
  on every target).

**Unknowns resolved in [research.md](research.md)**:

- R-001: Ed25519 keypair generation in Node (`crypto.generateKeyPairSync`
  vs `sshpk` vs shellout to `ssh-keygen`)
- R-002: OpenSSH-format public key encoding (Node-native vs library)
- R-003: Envelope encryption scheme (AES-256-GCM with per-row nonce, master
  key from env)
- R-004: SSH password auth for one-time root setup (existing ssh2 capability)
- R-005: Cloud-init metadata probe protocols (per provider — endpoints,
  headers, parse rules)
- R-006: Notification gate vs full NotificationChannel refactor (v1 scope)
- R-007: Throttling state durability — in-memory per A-007 single-instance
- R-008: Per-app env vars at deploy dispatch time (rendering as `SECRET_*`
  exports per feature 005's secret transport)
- R-009: Telegram Bot API error classification (transient vs permanent)
- R-010: Compatibility probe execution (parallel SSH commands vs single
  composite probe script)
- R-011: Lazy backfill semantics for plaintext → encrypted columns
- R-012: SSH key rotation atomicity (rollback on verify-failure)

## Project Structure

```
undev/
├── specs/011-zero-touch-onboarding/
│   ├── spec.md                                  # [EXISTING — clarified through Session 2026-05-03]
│   ├── plan.md                                  # [NEW — this file]
│   ├── research.md                              # [NEW — R-001..R-012]
│   ├── data-model.md                            # [NEW — schema additions, invariants]
│   ├── quickstart.md                            # [NEW — operator walkthrough]
│   ├── contracts/
│   │   ├── api.md                               # [NEW — HTTP endpoints, WS events, manifest entry]
│   │   └── notification-channel.md              # [NEW — gate flow, retry classification, audit shape]
│   └── checklists/
│       └── requirements.md                      # [EXISTING]
└── devops-app/
    ├── server/
    │   ├── db/
    │   │   ├── schema.ts                        # [MOD — 5 new server cols, 1 new app col, 2 new tables]
    │   │   └── migrations/
    │   │       └── 0010_zero_touch.sql          # [NEW — ALTER + CREATE, no destructive ops]
    │   ├── lib/
    │   │   ├── envelope-cipher.ts               # [NEW — AES-256-GCM wrap/unwrap, master key from env]
    │   │   ├── ssh-keygen.ts                    # [NEW — Node crypto Ed25519 + OpenSSH pub-key encoding]
    │   │   ├── cloud-init-probe.ts              # [NEW — provider detection over SSH curl]
    │   │   └── event-catalogue.ts               # [NEW — code-defined event-type enum + defaults]
    │   ├── services/
    │   │   ├── notifier.ts                      # [MOD — drop env-var defaults, route through gate]
    │   │   ├── notification-gate.ts             # [NEW — preferences check + cooldown + bucket + retry]
    │   │   ├── notification-settings-store.ts   # [NEW — singleton CRUD + Test connection probe]
    │   │   ├── server-onboarding.ts             # [NEW — Add Server flow: SSH gen + conn test + cloud probe]
    │   │   ├── server-bootstrap.ts              # [NEW — Initialise wizard step orchestrator]
    │   │   ├── ssh-key-rotation.ts              # [NEW — atomic rotation with rollback]
    │   │   ├── env-vars-store.ts                # [NEW — encrypt/decrypt, .env.example parse, CHANGE_ME flag]
    │   │   ├── env-vars-migrator.ts             # [NEW — lazy plaintext → encrypted backfill helper]
    │   │   └── compatibility-probe.ts           # [NEW — sudo -n / docker / disk / swap / OS probes]
    │   ├── scripts-manifest.ts                  # [MOD — add `server-ops/initialise`]
    │   └── routes/
    │       ├── servers.ts                       # [MOD — POST/PATCH extended, /initialise, /compatibility, /rotate-key]
    │       ├── apps.ts                          # [MOD — PATCH /apps/:id/env-vars, POST /apps/:id/env-vars/import]
    │       └── notification-settings.ts         # [NEW — Telegram CRUD + Test, per-event preferences CRUD]
    ├── client/
    │   ├── components/
    │   │   ├── servers/
    │   │   │   ├── AddServerForm.tsx            # [MOD — three auth modes + cloud detect + compatibility panel]
    │   │   │   ├── InitialiseWizard.tsx         # [NEW — 4-step: Summary → Options → Confirm → Live progress]
    │   │   │   └── CompatibilityReport.tsx      # [NEW — pass/warn/fail rows + remediation actions]
    │   │   ├── apps/
    │   │   │   └── EnvVarsEditor.tsx            # [NEW — table editor, reveal/hide, gen-secret, .env.example import]
    │   │   └── settings/
    │   │       ├── SshKeysTab.tsx               # [NEW — list keys + rotate]
    │   │       ├── NotificationsTab.tsx         # [NEW — wraps Telegram + Events sections]
    │   │       ├── TelegramConfigForm.tsx       # [NEW — token/chat input + Test connection]
    │   │       └── EventToggleList.tsx          # [NEW — per-event ON/OFF list driven by event-catalogue]
    │   ├── hooks/
    │   │   ├── useNotificationSettings.ts       # [NEW — fetch/mutate TG config + preferences]
    │   │   └── useCompatibilityReport.ts        # [NEW — debounced probe trigger]
    │   └── pages/
    │       ├── ServerDetailPage.tsx             # [MOD — Initialise button, Compatibility panel hooks]
    │       └── SettingsPage.tsx                 # [MOD — register SSH Keys + Notifications tabs]
    └── tests/
        ├── unit/
        │   ├── envelope-cipher.test.ts          # [NEW — round-trip, IV uniqueness, tampering detection]
        │   ├── ssh-keygen.test.ts               # [NEW — fingerprint matches `ssh-keygen -lf`, OpenSSH parser accepts]
        │   ├── event-catalogue.test.ts          # [NEW — every event has default declared, types match]
        │   ├── notification-gate-cooldown.test.ts        # [NEW — per-pair cooldown + suppressed counter]
        │   ├── notification-gate-bucket.test.ts          # [NEW — global token-bucket exhaust + recover]
        │   ├── notification-gate-retry.test.ts           # [NEW — transient retry + permanent mark broken]
        │   ├── env-vars-store.test.ts           # [NEW — encrypt/decrypt, CHANGE_ME detect, .env.example parse]
        │   ├── env-vars-migrator.test.ts        # [NEW — lazy backfill semantics, idempotent on re-edit]
        │   ├── compatibility-probe.test.ts      # [NEW — fixture-driven probe outputs → pass/warn/fail]
        │   ├── cloud-init-probe.test.ts         # [NEW — per-provider fixture parsing + vanilla fallback]
        │   ├── ssh-key-rotation.test.ts         # [NEW — rollback on verify-fail, lock acquisition]
        │   └── notification-settings-store.test.ts       # [NEW — singleton CHECK constraint, Test connection paths]
        └── integration/
            ├── add-server-happy-path.test.ts    # [NEW — paste key → conn test → cloud detect → compatibility ✓ → save]
            ├── add-server-genkey-path.test.ts   # [NEW — gen Ed25519 → surface pubkey → conn test fails until installed]
            ├── initialise-wizard.test.ts        # [NEW — multi-step → setup-vps.sh dispatch via runner → setup_state=ready]
            ├── env-vars-editor-deploy.test.ts   # [NEW — edit env vars → deploy → SECRET_* exports rendered correctly]
            ├── ssh-rotation-rollback.test.ts    # [NEW — verify-step fail → DB unchanged, target authorized_keys cleaned]
            ├── notification-gate-e2e.test.ts    # [NEW — flapping event → 1 leading + 1 summary, suppressed=N]
            └── telegram-test-connection.test.ts # [NEW — mock TG API: 200 ok, 401 permanent, 429 retry then ok]
```

## Migration plan

`devops-app/server/db/migrations/0010_zero_touch.sql` — additive only, no
destructive operations. Existing rows get safe defaults; lazy backfill
handled in code path (FR-011, R-011).

### Servers — 5 new columns

```sql
ALTER TABLE "servers" ADD COLUMN "ssh_private_key_encrypted" TEXT NULL;
ALTER TABLE "servers" ADD COLUMN "ssh_key_fingerprint" TEXT NULL;
ALTER TABLE "servers" ADD COLUMN "ssh_key_rotated_at" TEXT NULL;
ALTER TABLE "servers" ADD COLUMN "cloud_provider" TEXT NULL;
ALTER TABLE "servers" ADD COLUMN "setup_state" TEXT NOT NULL DEFAULT 'unknown';

ALTER TABLE "servers" ADD CONSTRAINT "servers_setup_state_enum"
  CHECK ("setup_state" IN ('unknown', 'needs_initialisation', 'initialising', 'ready'));

ALTER TABLE "servers" ADD CONSTRAINT "servers_cloud_provider_enum"
  CHECK ("cloud_provider" IS NULL OR "cloud_provider" IN
    ('gcp', 'aws', 'do', 'hetzner', 'vanilla'));
```

`ssh_private_key` (plaintext) stays — lazy-deprecated. `env-vars-migrator.ts`
pattern (R-011) applies: any UPDATE that touches the auth method moves the
key into `ssh_private_key_encrypted` and NULLs the plaintext column. v2
migration drops `ssh_private_key`.

### Applications — 1 new column

```sql
ALTER TABLE "applications" ADD COLUMN "env_vars_encrypted" JSONB NULL;
```

Existing `env_vars` plaintext stays. First save through `EnvVarsEditor`
encrypts every key into `env_vars_encrypted` and replaces `env_vars` with
`'{}'::jsonb`. Reads merge: encrypted values take precedence; legacy plaintext
values returned unchanged until first edit (FR-011 backward-compat).

### Notification preferences — new table

```sql
CREATE TABLE "notification_preferences" (
  "event_type" TEXT PRIMARY KEY,
  "enabled" BOOLEAN NOT NULL,
  "updated_at" TEXT NOT NULL DEFAULT (
    to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  )
);
```

No FK to a code enum — application-layer enforces via `event-catalogue.ts`
membership check (FR-030). Orphaned rows (event removed in code) are
ignored at dispatch time per US7 edge case.

### Notification settings — new singleton table

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

Singleton enforcement via `CHECK (id = 1)` (precedent: `github_connection`
table, feature 002). The seed INSERT runs unconditionally — first migration
creates the row in unconfigured state.

### Defaults seed for notification_preferences

Defaults are NOT seeded by SQL — populated at dashboard boot from
`event-catalogue.ts` if the row is absent. This keeps the source of truth in
code (FR-030 typecheck-enforced) instead of split between SQL + code.

### DOWN migration (manual, operator-gated)

```sql
-- DROP TABLE "notification_settings";
-- DROP TABLE "notification_preferences";
-- ALTER TABLE "applications" DROP COLUMN "env_vars_encrypted";
-- ALTER TABLE "servers" DROP CONSTRAINT "servers_cloud_provider_enum";
-- ALTER TABLE "servers" DROP CONSTRAINT "servers_setup_state_enum";
-- ALTER TABLE "servers" DROP COLUMN "setup_state";
-- ALTER TABLE "servers" DROP COLUMN "cloud_provider";
-- ALTER TABLE "servers" DROP COLUMN "ssh_key_rotated_at";
-- ALTER TABLE "servers" DROP COLUMN "ssh_key_fingerprint";
-- ALTER TABLE "servers" DROP COLUMN "ssh_private_key_encrypted";
```

## Constitution Check

There is no `.specify/memory/constitution.md` in the repo. CLAUDE.md
Standing Orders + AI-Generated Code Guardrails serve as the proxy
constitution for this gate. Each rule below is checked against the plan;
violations require explicit waiver above the gate.

| Rule (CLAUDE.md) | Status | Notes |
|---|---|---|
| #1 Never commit/push without request | ✓ | Plan deliverables are files only. |
| #2 Never install packages without approval | ✓ | **Zero new npm deps.** Ed25519 + AES-GCM via Node `crypto`. |
| #3 Never use `--force / --yes / -y` flags | ✓ | All wizards include typed-confirmation per FR-007 (Initialise) + FR-022 (Compatibility warn click-through). |
| #4 Never put secrets in code/commits/logs | ✓ | Envelope encryption for SSH keys + env vars + TG token. Pino redact extends to `{ telegram_bot_token, env_vars_encrypted }`. Decrypted values never logged (FR-014). |
| #5 Never run migrations directly | ✓ | `0010_zero_touch.sql` ships as reviewable SQL — operator runs via existing migration pipeline. |
| #6 No destructive commands without 3x consent | ✓ | SSH key rotation removes old pubkey from target only after verify-step succeeds (FR-017). Initialise wizard requires typed acknowledgement (FR-007). No `rm -rf` paths in this feature. |
| #7 Never read .env / secrets unless asked | ✓ | env vars source is DB. `.env.example` parsing reads only the *example* file (committed convention), never `.env`. |
| AGCG: no `process.env.X \|\| "fallback"` | ✓ | TG config no longer falls back to env vars (Q3 clarification). Master key (`DASHBOARD_MASTER_KEY`) read at boot via fail-fast `if (!env.X) throw`. |
| AGCG: no `as any` | ✓ | All new modules typed end-to-end. SSH-side stdout parsing uses Zod or hand-typed parsers. |
| AGCG: no `throw new Error()` raw | ✓ | Use existing `AppError` factory pattern (precedent: `server/lib/app-error.ts`). |
| AGCG: no `console.log` | ✓ | Pino `logger` everywhere, with `ctx` field. |
| AGCG: no swallowed `catch (e) { }` | ✓ | All catches log + re-throw OR convert to typed result (e.g. `{ ok: false, reason }`). |
| AGCG: no `req.body.field` without Zod | ✓ | Every new route validates body with Zod schema (precedent: feature 008 routes). |

**Gate status: PASS.** No waivers needed.

## Phase 0: Outline & Research

Output: [research.md](research.md). Resolves R-001..R-012 listed in
Technical Context. Each entry documents Decision / Rationale / Alternatives
considered.

Key resolutions:

- **R-001** Ed25519 keypair: Node `crypto.generateKeyPairSync('ed25519',
  { publicKeyEncoding, privateKeyEncoding })` with PEM export. No new dep.
- **R-002** OpenSSH public-key encoding: hand-coded encoder
  (`length-prefixed string concat → base64`) since Node returns SPKI/PKCS8
  not OpenSSH wire format. ~30 lines, zero deps.
- **R-003** Envelope encryption: per-row IV (12 bytes random), AES-256-GCM,
  ciphertext + IV + auth tag persisted as `{ ct, iv, tag }` jsonb. Master
  key from `DASHBOARD_MASTER_KEY` env (32 raw bytes after base64 decode).
- **R-005** Cloud-init endpoints (per provider, fetched over SSH session):
  - GCP: `curl -H 'Metadata-Flavor: Google' http://metadata.google.internal/computeMetadata/v1/instance/`
  - AWS: `curl http://169.254.169.254/latest/meta-data/` (IMDSv1) or with
    token (IMDSv2)
  - DO: `curl http://169.254.169.254/metadata/v1/`
  - Hetzner: `curl http://169.254.169.254/hetzner/v1/metadata/`
  - Each probed in parallel with 2s timeout; first 200 OK wins; all fail → vanilla.
- **R-006** Notification gate scope: extract `preferences-gate +
  cooldown + bucket + retry` into `notification-gate.ts` ONLY. Keep
  `notifier.notifyAppHealthChange/notifyCertExpiring/...` as leaf-callers
  that pass `(eventType, resourceId, payloadFormatter)` to the gate. Full
  `NotificationChannel` interface deferred to v2 (single `TelegramChannel`
  in v1 lives inline in notifier.ts).
- **R-007** Throttling state durability: in-memory `Map<pairKey, CooldownEntry>`
  + token-bucket counter, reset to empty on dashboard restart. Acceptable per
  A-007 (single-instance assumption). Multi-instance migration tracked as v2.
- **R-009** TG API error classification:
  - 200, 200+`{ok:true}` → success
  - 400 (validation), 401 (token bad), 403 (chat blocked), 404 (chat not
    found) → permanent → flip `telegram_last_test_ok = false`
  - 429 (rate limit) → respect `parameters.retry_after` (TG API field)
  - 5xx, network timeout → transient retry up to 3x with backoff
- **R-011** Lazy backfill: on every UPDATE that touches `ssh_private_key`
  or `env_vars`, the service first writes to the encrypted column, then
  NULLs the plaintext. Reads consult encrypted first; fall back to plaintext.
  Migration to drop plaintext columns deferred to v2 once 100% of rows
  flipped.

## Phase 1: Design & Contracts

Outputs:

- [data-model.md](data-model.md) — entity diagrams, invariants, state
  transitions for `servers.setup_state`, lazy-migration semantics for
  encrypted columns, defaults seeding flow.
- [contracts/api.md](contracts/api.md) — all new HTTP endpoints with
  request/response Zod-derived schemas, WS event shapes for Initialise
  live progress, manifest entry schema for `server-ops/initialise`.
- [contracts/notification-channel.md](contracts/notification-channel.md)
  — gate flow diagram, retry classification table, audit-event shape per
  drop reason, suppression-counter semantics.
- [quickstart.md](quickstart.md) — operator walkthrough: "I just rented
  a fresh VPS" → working app deploy in 10 minutes.

### Agent context update

The repo has no `.specify/scripts/powershell/update-agent-context.ps1`.
Per user direction, CLAUDE.md is **not** modified by this plan (manual
update if/when desired).

## Re-evaluate Constitution Check post-design

After draft of data-model.md + contracts/api.md + contracts/notification-channel.md:

| Rule | Status |
|---|---|
| All Standing Orders + AGCG | ✓ (no design choice introduces a violation) |
| Migration is additive | ✓ (only ALTER ADD + CREATE; legacy columns preserved) |
| Secrets boundary respected | ✓ (envelope encryption applied uniformly; no decrypted values surfaced via API except inside `TelegramChannel.send` and runner's `SECRET_*` exports) |
| API contracts match spec FR | ✓ (every FR-001..FR-043 traces to either a route, a service method, or a UI component listed above) |

**Gate status: PASS post-design.** No re-design required.

## Open dependencies

- **Feature 010** (`operational-maturity`) is referenced in spec.md
  Dependencies but `specs/010-*` does not exist in the repo. Treat as
  forward-reference / stub; no blocking work in feature 011 depends on
  010 artefacts.
- **Master encryption key provisioning** (`DASHBOARD_MASTER_KEY`) — A-002
  declares it operator-managed. Plan assumes operator sets the env var
  before the migration runs; first boot fails fast if unset.

## Stop point

Plan ends at Phase 2. Implementation tasks (Phase 3) are produced by
`/speckit.tasks` from this plan + the spec.

## Generated artifacts

- [plan.md](plan.md) (this file)
- [research.md](research.md)
- [data-model.md](data-model.md)
- [contracts/api.md](contracts/api.md)
- [contracts/notification-channel.md](contracts/notification-channel.md)
- [quickstart.md](quickstart.md)

Suggested next command: `/speckit.tasks`.
