# Tasks: Zero-Touch VPS Onboarding & Secrets Management

**Feature**: 011-zero-touch-onboarding
**Inputs**: `spec.md`, `plan.md`, `research.md`, `data-model.md`, `contracts/api.md`, `contracts/notification-channel.md`, `quickstart.md`
**Prerequisites**: features 001/002/004/005/006/008/009 merged; `DASHBOARD_MASTER_KEY` env var provisioned (A-002); operator-side TG bot registered out-of-band (A-006).
**Format reminder**: every task line is `- [ ] [TaskID] [AGENT] [Story?] Description with file path`. No `[P]` markers, no chained arrows. Story tag `[USx]` only inside Phase 3..9.

## Agent tags

| Tag | Domain |
|---|---|
| `[SETUP]` | Cross-cutting shared-file writes — single owner per file |
| `[DB]` | Migration `.sql`, `schema.ts`, parameterized Drizzle queries |
| `[BE]` | Server services / routes / lib / manifest |
| `[FE]` | React components / hooks / pages |
| `[OPS]` | Bash scripts, package.json, env-config |
| `[E2E]` | Cross-domain integration tests |
| `[SEC]` | Security audit / vulnerability review |

## Status legend

`[ ]` not started · `[~]` in progress · `[x]` done · `[!]` blocked

## Path conventions

- Server: `devops-app/server/`
- Client: `devops-app/client/`
- Migration: `devops-app/server/db/migrations/0010_zero_touch.sql`
- Existing scripts (no new ones): `scripts/server/setup-vps.sh`, `scripts/deploy/env-setup.sh`
- Tests: `devops-app/tests/{unit,integration}/`

---

## Phase 1: Setup

- [ ] T001 [SETUP] [BE] Verify no new npm deps required for this feature in `devops-app/package.json` — Ed25519 via Node `crypto`, AES-GCM via Node `crypto`, TG via existing `fetch`. Confirm `ssh2` already supports password + Ed25519 PEM auth (typecheck a probe `import { Client } from "ssh2"`). Per Standing Order #2, no `npm install` runs in this feature.
- [ ] T002 [SETUP] [BE] AGCG compliance audit for the planned files: scan plan.md's Project Structure list — every new `.ts` MUST land typed (no `as any`), pino-only logging (no `console.log`), Zod on every route body, `AppError.*` factories on every throw. Document deviations as inline TODO comments only; no behaviour change.
- [ ] T003 [SETUP] [BE] Append exactly one manifest entry `server-ops/initialise` to `devops-app/server/scripts-manifest.ts` per `contracts/api.md` § Manifest entry — typed Zod schema, `requiresLock: true`, `timeout: 1_200_000`, `dangerLevel: "medium"`, `pubkey: z.string()` param marked secret-adjacent (its presence implies key install on target). Cross-check no other agent will modify this file in Phase 2..9 — single-owner rule.
- [ ] T004 [SETUP] [DB] Extend `devops-app/server/db/schema.ts` with Drizzle definitions for: 5 new `servers` columns (`sshPrivateKeyEncrypted`, `sshKeyFingerprint`, `sshKeyRotatedAt`, `cloudProvider`, `setupState`), 1 new `applications` column (`envVarsEncrypted: jsonb`), and 2 new `pgTable`s (`notificationPreferences`, `notificationSettings`). Add composite index `idx_servers_status_setup_state`. Drizzle typed columns only, no raw SQL strings, single atomic edit. Match data-model.md exactly.
- [ ] T005 [SETUP] [OPS] Audit `scripts/server/setup-vps.sh` for parameter-input contract — confirm it accepts (or add parsing for) `INITIALISE_DEPLOY_USER`, `INITIALISE_SWAP_SIZE`, `INITIALISE_UFW_PORTS`, `INITIALISE_USE_NO_PTY`, `INITIALISE_PUBKEY` env vars per `contracts/api.md` § Manifest entry. If absent, add an env-driven param-block at script top under `set -euo pipefail`. No logic refactor — env-input layer only.

**Sync barrier — Phase 1 complete before Phase 2 starts.**

---

## Phase 2: Foundational

- [ ] T006 [DB] Create `devops-app/server/db/migrations/0010_zero_touch.sql` — additive only per data-model.md: ALTER `servers` add 5 cols + 2 CHECK constraints (setup_state enum, cloud_provider enum), ALTER `applications` add `env_vars_encrypted JSONB NULL`, CREATE `notification_preferences` (PK event_type), CREATE `notification_settings` (PK with `CHECK (id = 1)`) + INSERT singleton row, CREATE INDEX `idx_servers_status_setup_state`, DOWN migration in commented block. Reviewable static SQL, no string interpolation. Per Standing Order #1, do NOT execute — file only.
- [ ] T007 [BE] Implement `devops-app/server/lib/envelope-cipher.ts` per research.md R-003: AES-256-GCM, per-row 12-byte random IV, master key from `DASHBOARD_MASTER_KEY` env (base64-decoded 32 bytes, fail-fast at module load with `AppError.internal("DASHBOARD_MASTER_KEY required")`). Export typed `EnvelopeBlob = { ct: string; iv: string; tag: string }`, `seal(plaintext: string): EnvelopeBlob`, `open(blob: EnvelopeBlob): string`. Throw on tampered/truncated blob (GCM auth-tag check). No `as any`, no `console.log`, structured error handling.
- [ ] T008 [BE] Add unit tests `devops-app/tests/unit/envelope-cipher.test.ts` — round-trip seal/open identity, IV uniqueness over 1000 seals (no collisions), tamper-detection (mutate one byte of ct → open throws), wrong-key rejection (re-seed key → open throws), boot fail-fast when env var missing/wrong-length. Vitest, mock `process.env` via `vi.stubEnv`.
- [ ] T009 [BE] Implement `devops-app/server/lib/ssh-keygen.ts` per research.md R-001/R-002: typed `generateEd25519Keypair(): { privateKeyPem: string; publicKeyOpenSsh: string; fingerprint: string }`. Use `crypto.generateKeyPairSync("ed25519", { publicKeyEncoding: { type: "spki", format: "der" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } })`, hand-coded `toOpenSshPubKey(der: Buffer): string` per R-002 (length-prefixed wire format), `computeFingerprint(opensshWire: Buffer): string` returning `SHA256:<base64-no-padding>`. Typed inputs/outputs only, no `as any`.
- [ ] T010 [BE] Add unit tests `devops-app/tests/unit/ssh-keygen.test.ts` — generated key pair round-trips through `ssh2`'s parser without error; OpenSSH pubkey string starts with `ssh-ed25519 ` and base64-decodes to length-prefixed wire format with `algo === "ssh-ed25519"`; fingerprint matches `ssh-keygen -lf <pubfile>` output for 5 fixture pairs (committed under `tests/fixtures/ssh-keys/`); 100 generated keys all distinct (sanity for randomness).
- [ ] T011 [BE] Implement `devops-app/server/lib/event-catalogue.ts` per data-model.md § Code-side catalogue — exported readonly array `EVENT_CATALOGUE` of 15 entries with typed `EventCatalogueEntry { type, description, defaultEnabled, category }`. Types: failure (6), security (4), success (4), operational (1) — total 15 events. TypeScript interface enforces `defaultEnabled: boolean` non-optional (FR-030 typecheck enforcement). Export helpers `catalogueHas(type: string): boolean` and `catalogueGet(type: string): EventCatalogueEntry | undefined` for gate-side lookups.
- [ ] T012 [BE] Add unit tests `devops-app/tests/unit/event-catalogue.test.ts` — every entry has `defaultEnabled` declared (compile-time, but assert runtime presence for safety), `Set(types).size === EVENT_CATALOGUE.length` (uniqueness), every type matches regex `^[a-z]+(\.[a-z_]+)+$` (canonical lowercase dot-separated), categories restricted to `failure | security | success | operational`.
- [ ] T013 [BE] Extend `devops-app/server/lib/serializer.ts` (or wherever existing server/app row serialisation lives — verify path during implementation) with explicit whitelist excludes for `ssh_private_key`, `ssh_private_key_encrypted`, `ssh_password`, `env_vars_encrypted` (full blob), `telegram_bot_token_encrypted`. Returns sanitised `ServerSerialised` and `ApplicationSerialised` matching contracts/api.md § Shared types. Typed return shape, no `as any`.
- [ ] T014 [BE] Extend pino redact paths in `devops-app/server/lib/logger.ts` to cover: `req.body.botToken`, `req.body.privateKey`, `req.body.password`, `req.body.vars.*`, `auditEntry.payload.botToken`, `scriptRun.params.pubkey` (pubkey not secret but conservative). Add explicit test `devops-app/tests/unit/logger-redact.test.ts` — log a fixture with each secret key, capture stream, assert `[Redacted]` substituted.
- [ ] T015 [BE] Implement boot-time seeder `devops-app/server/services/notification-preferences-seeder.ts` — on dashboard boot, walk `EVENT_CATALOGUE`; for any entry whose `event_type` lacks a row in `notification_preferences`, INSERT with `enabled = entry.defaultEnabled`. Idempotent (uses `INSERT ... ON CONFLICT (event_type) DO NOTHING`). Called from `server/index.ts` during initialisation, after migrations apply. Parameterized via Drizzle.

**Sync barrier — Phase 2 complete before any user-story phase starts.**

---

## Phase 3: User Story 1 — Add a new VPS with auto-generated SSH credentials (P1)

**Goal**: operator opens "Add Server" form, picks one of three auth modes, runs Test connection (which also runs cloud-init probe and compatibility probe), saves with the row created in `setup_state` matching what the probe found.

**Independent test criteria**: a fresh Ubuntu 22.04 VPS with valid root password lets the operator complete the form in mode (b), see compatibility report with all rows pass/warn, save, and end up with a `servers` row whose `cloud_provider` matches the cloud and `setup_state = needs_initialisation` (because docker is missing on bare image).

- [ ] T016 [BE] [US1] Implement `devops-app/server/services/cloud-init-probe.ts` per research.md R-005 — typed `probeCloudProvider(serverId: string): Promise<CloudProvider>`. Issues a single composite SSH command via existing `sshPool.execStream` with parallel `curl` attempts to GCP/AWS-IMDSv1+v2/DO/Hetzner endpoints, 2s per-probe timeout, `PROVIDER=<id>` last line wins. Returns `"vanilla"` when all fail. Typed `CloudProvider = "gcp" | "aws" | "do" | "hetzner" | "vanilla"`. No `console.log`, structured error when SSH session itself errors.
- [ ] T017 [BE] [US1] Implement `devops-app/server/services/compatibility-probe.ts` per research.md R-010 — typed `probeCompatibility(serverId: string): Promise<CompatibilityReport>`. Single composite SSH command (heredoc inline) collecting key=value lines for SSH_OK/SUDO_NOPASSWD/USE_PTY/DOCKER/DISK_FREE_GB/SWAP/OS_FAMILY/OS_VERSION/ARCH; parser maps to per-check `pass/warn/fail` with plain-language summary and remediation hints per `contracts/api.md` § CompatibilityReport. Typed inputs/outputs, no `as any`.
- [ ] T018 [BE] [US1] Implement `devops-app/server/services/server-onboarding.ts` — typed `addServer(input: AddServerInput): Promise<AddServerOutput>` orchestrating: (1) discriminated-union auth mode handling (paste-key validates via `ssh2.utils.parseKey`, paste-password sets transient column, generate-key calls `ssh-keygen.ts`), (2) connection test `whoami && id && uname -a` via `sshPool`, (3) parallel `cloud-init-probe` + `compatibility-probe`, (4) blocked save when any compatibility row is `fail` AND not in `acknowledgedWarnings`, (5) envelope-encrypt private key before persistence (mode generate-key + paste-key), (6) audit `server.added` with metadata. Parameterized Drizzle for INSERT. Returns `{ server, generatedPublicKey, compatibility, cloudProvider }` per contracts/api.md.
- [ ] T019 [BE] [US1] Extend `devops-app/server/routes/servers.ts` POST handler with new Zod schema from `contracts/api.md` § POST /api/servers — discriminated union `auth` field, `acknowledgedWarnings: string[]`, parameterized Drizzle, structured 400 (validation), 401 (`ssh_auth_failed`), 422 (compatibility-fail). Delegates to `server-onboarding.addServer`. No `as any`, response uses serializer whitelist (T013).
- [ ] T020 [BE] [US1] Implement `POST /api/servers/:id/compatibility` in `devops-app/server/routes/servers.ts` per contracts/api.md — re-runs `cloud-init-probe` + `compatibility-probe`, updates `cloud_provider` + `setup_state`, returns fresh `{ report, cloudProvider, setupState }`. Zod-validated empty body schema (defensive against drift), parameterized UPDATE via Drizzle.
- [ ] T021 [FE] [US1] Build `devops-app/client/components/servers/CompatibilityReport.tsx` — typed props `{ report: CompatibilityReport, onAcknowledgeWarning: (checkId: string) => void }`. Renders rows with status icon (`✓`/`⚠`/`✗`), summary text, optional one-click remediation button (mapping `action: "initialise" | "edit-server" | "manual"` to UI handler). `warn` rows show per-row checkbox for explicit acknowledgement. Controlled inputs only, no `dangerouslySetInnerHTML`.
- [ ] T022 [FE] [US1] Build `devops-app/client/hooks/useCompatibilityReport.ts` — typed `useCompatibilityReport(serverId: string | null)`, returns `{ report, cloudProvider, isLoading, error, refetch }`. Triggered explicitly by Test connection button (no auto-debounce per OQ-004 resolution). Uses shared fetch wrapper, maps `{ code }` to typed error union.
- [ ] T023 [FE] [US1] Modify `devops-app/client/components/servers/AddServerForm.tsx` — add discriminated-union auth mode selector (paste-key / paste-password / generate-key), call `POST /api/servers/:id/compatibility` on Test connection click, render `<CompatibilityReport>`, surface generated pubkey in copyable code-block when `mode === "generate-key"`, disable Save button while compatibility has unacknowledged warnings or fail rows. Controlled inputs, no `as any`. Standards: Zod parse before submit, structured error display.
- [ ] T024 [BE] [US1] Add unit tests `devops-app/tests/unit/cloud-init-probe.test.ts` — fixture-driven SSH stream parsing for each provider (5 fixtures including AWS IMDSv2 token-fetch flow), vanilla fallback when all probes timeout, fail-fast on SSH session error.
- [ ] T025 [BE] [US1] Add unit tests `devops-app/tests/unit/compatibility-probe.test.ts` — fixture-driven probe-output parsing → expected CompatibilityReport JSON for: (a) fully ready Ubuntu 22.04 host (all pass), (b) bare GCP image (use_pty set warn, docker missing fail), (c) low-disk warn at 8GB, (d) ARM64 architecture warn, (e) malformed probe output → unknown checks marked warn.
- [ ] T026 [E2E] [US1] Add `devops-app/tests/integration/add-server-happy-path.test.ts` — mock SSH pool with cloud-init + compatibility fixture responses, POST /api/servers paste-key mode → assert response includes `compatibility.overall === "warn"` (docker missing flagged), `cloudProvider === "gcp"`, server row inserted with `setup_state = "needs_initialisation"`, audit `server.added` row with `authMethod: "key"` and `cloudProvider: "gcp"` payload.
- [ ] T027 [E2E] [US1] Add `devops-app/tests/integration/add-server-genkey-path.test.ts` — POST /api/servers generate-key mode, mock SSH conn-test failing first (key not yet on target), assert 401 `ssh_auth_failed` returned with generated pubkey embedded in response detail; second POST after pubkey installation succeeds; assert generated private key sealed in DB and `generatedPublicKey` returned exactly once (subsequent GETs do NOT include it).

---

## Phase 4: User Story 2 — Initialise a blank VPS with one click (P1)

**Goal**: operator clicks Initialise on a `needs_initialisation` server, configures the wizard, types the acknowledgement, watches `setup-vps.sh` execute live in the file-tail modal, ends with `setup_state = ready`.

**Independent test criteria**: from a server in `needs_initialisation` state, calling POST /api/servers/:id/initialise with valid body returns 202 + scriptRunId; the script_runs row drives setup_state through `initialising` → `ready` after the (mocked) `setup-vps.sh` exits 0; failure path reverts to `needs_initialisation` and emits `server.init.failed` notification.

- [ ] T028 [BE] [US2] Implement `devops-app/server/services/server-bootstrap.ts` — typed `initialiseServer(serverId, options, userId): Promise<{ scriptRunId, wsTopic }>`. Sets `setup_state = "initialising"` in a tx, dispatches `scriptsRunner.runScript("server-ops/initialise", serverId, params, userId)`, registers an `onComplete` callback that flips `setup_state` to `"ready"` (exit 0) or `"needs_initialisation"` (non-zero), emits notification via `notification-gate` (T058 builds the gate, T059 wires `notifier.notifyServerInit` through it — until then, inject a `NotificationGate` interface dependency via constructor; the Phase-9 wire-up is a no-op at the call site). Audit `server.initialised` only on success. Parameterized Drizzle for state UPDATE.
- [ ] T029 [BE] [US2] Implement `POST /api/servers/:id/initialise` in `devops-app/server/routes/servers.ts` per contracts/api.md — Zod validation of `deployUser` (POSIX regex), `swapSize` (`/^\d+G$/`), `ufwPorts` (port range), `useNoPty` (boolean, default inferred from `cloud_provider`), `typedAcknowledgement` (literal `"INITIALISE"`). Generates the `pubkey` param by decrypting the server's stored key (or fetching from existing). Returns 202 with `{ scriptRunId, wsTopic: "script.run.tail" }`. 409 if `setup_state` already `"initialising"`.
- [ ] T030 [FE] [US2] Build `devops-app/client/components/servers/InitialiseWizard.tsx` — 4-step controlled wizard (Summary → Options → Confirm → Live progress). Step 4 reuses existing file-tail modal subscribing to `script.run.tail` WS topic (feature 009). Typed props `{ serverId, isOpen, onClose, defaultUseNoPty: boolean }`. Submit calls POST /api/servers/:id/initialise; modal stays open after close-X to keep watching progress (server-side state machine survives client disconnect). No `as any`, no `dangerouslySetInnerHTML`.
- [ ] T031 [FE] [US2] Modify `devops-app/client/pages/ServerDetailPage.tsx` — add "Initialise this server" button visible iff `setup_state === "needs_initialisation"`, opens `InitialiseWizard` modal, server status badge reflects `setup_state` per data-model.md state machine. Inherits cloud-provider hint banner from CompatibilityReport for default `useNoPty` toggle.
- [ ] T032 [BE] [US2] Add unit tests `devops-app/tests/unit/server-bootstrap.test.ts` — state transitions on success exit 0 (initialising → ready), failure exit code (initialising → needs_initialisation), idempotent re-run when already in ready state (no-op + 409 propagated), audit row written exactly once on success.
- [ ] T033 [E2E] [US2] Add `devops-app/tests/integration/initialise-wizard.test.ts` — mock scripts-runner to return success, POST initialise → assert 202, drive script_runs lifecycle to completion, assert final `setup_state === "ready"` AND `audit_entries` row `server.initialised` AND notification dispatched for `server.init.succeeded` (verify via mocked gate spy).

---

## Phase 5: User Story 3 — Edit per-app environment variables in the UI (P1)

**Goal**: operator opens Edit Application → Environment variables, edits/imports/saves through the UI; deploys consume the encrypted values via existing `SECRET_*` export convention.

**Independent test criteria**: an app with no env_vars gets a `JWT_SECRET=foo` added via PATCH; subsequent deploy receives `SECRET_JWT_SECRET=foo` env export; the DB row's `env_vars_encrypted` contains a sealed blob and `env_vars` is `{}`; audit shows `app.env_vars_changed` with `addedKeys: ["JWT_SECRET"]` (no values).

- [ ] T034 [BE] [US3] Implement `devops-app/server/services/env-vars-store.ts` — typed `load(appId): Promise<Record<string, string>>` (encrypted-first, plaintext fallback per R-011), `save(appId, vars, userId): Promise<{ added, removed, changed }>` (per-key seal, `env_vars` cleared on first encrypted write), `decryptForDispatch(appId): Promise<Record<string, string>>` (deploy path only). Detects CHANGE_ME placeholders via regex `/^CHANGE_ME(_[A-Z0-9_]+)?$/i` and exposes `detectPlaceholders(vars: Record<string, string>): string[]`. Audit emit `app.env_vars_changed` with key lists only — values NEVER in payload. Parameterized Drizzle.
- [ ] T035 [BE] [US3] Implement `devops-app/server/services/env-vars-migrator.ts` — typed `lazyMigrateOnWrite(appId, newVars): Promise<void>` per R-011 — wraps `env-vars-store.save` to ensure plaintext `env_vars` is cleared atomically with encrypted write. Idempotent on re-edit (already-encrypted rows just re-seal). Helper `parseEnvExample(text: string): Record<string, string>` for import flow — handles `KEY=value` lines, `#` comment stripping, blank-line skip, value-quote normalisation.
- [ ] T036 [BE] [US3] Modify `devops-app/server/services/scripts-runner.ts` (verify exact symbol — the secret-transport flow per feature 005) to consume `env-vars-store.decryptForDispatch(appId)` instead of reading `applications.env_vars` directly. Render decrypted values as `export SECRET_<KEY>=<shQuoted>` lines prepended to the script body (existing `executeWithStdin` path). Decrypted values never enter `script_runs.params`, never logged. Standards: typed Map → string transformation, no `as any`.
- [ ] T037 [BE] [US3] Implement `PATCH /api/applications/:id/env-vars` in `devops-app/server/routes/apps.ts` per contracts/api.md — Zod validation of `vars` record (POSIX env-name regex on keys, no value constraints), `acknowledgePlaceholders` boolean. Calls `env-vars-store.save`. Returns 400 `placeholder_values_detected` with `changeMeKeys` when placeholders present and not acknowledged. Parameterized via Drizzle, structured error mapping.
- [ ] T038 [BE] [US3] Implement `POST /api/applications/:id/env-vars/import` in `devops-app/server/routes/apps.ts` per contracts/api.md — reads `.env.example` over SSH from `application.remotePath` (typed wrapper around `sshPool.execStream("cat <path>")`), parses via `env-vars-migrator.parseEnvExample`, merges into existing vars (new keys append, existing untouched per OQ-002 resolution). Returns 404 `env_example_not_found` when file absent. Audit `app.env_vars_imported_from_example` with key lists.
- [ ] T039 [FE] [US3] Build `devops-app/client/components/apps/EnvVarsEditor.tsx` — typed table editor with per-row delete, value reveal/hide toggle (controlled), generate-secret helper (32-byte hex via `crypto.getRandomValues` client-side), Import-from-example button (visible when repo cloned + `.env.example` present per heuristic). Submit calls `PATCH /api/applications/:id/env-vars` with `acknowledgePlaceholders: false` first; on 400 placeholder error, surface confirm dialog and re-submit with `true`. No `dangerouslySetInnerHTML`, controlled inputs only.
- [ ] T040 [FE] [US3] Modify `devops-app/client/components/apps/EditAppForm.tsx` — embed `<EnvVarsEditor>` as a new section. Verify existing form's submit flow does NOT also write env_vars (avoid double-write race); env vars now live in their own PATCH endpoint, not in the main app PATCH.
- [ ] T041 [BE] [US3] Add unit tests `devops-app/tests/unit/env-vars-store.test.ts` — round-trip seal/load preserves values, save with empty `vars` clears the row to `'{}'`, CHANGE_ME detection covers `CHANGE_ME`/`CHANGE_ME_FOO`/`change_me_foo` (case-insensitive regex), audit emits with key lists only (no value substrings in serialised payload).
- [ ] T042 [BE] [US3] Add unit tests `devops-app/tests/unit/env-vars-migrator.test.ts` — `parseEnvExample` handles `KEY=value`, `KEY="quoted"`, `# comment`, blank lines, lines without `=` (skip), trailing whitespace; lazy migration on first edit clears plaintext column atomically; idempotent on re-edit (no double-encryption).
- [ ] T043 [E2E] [US3] Add `devops-app/tests/integration/env-vars-editor-deploy.test.ts` — PATCH /env-vars with `{ JWT_SECRET: "abc123" }`, assert response shape, assert DB row `env_vars_encrypted` non-null + `env_vars = {}`. Trigger a deploy via existing deploy endpoint; capture script body; assert `export SECRET_JWT_SECRET='abc123'` line present. Assert `script_runs.params` does NOT contain `"abc123"` substring (FR-014 leak check).

---

## Phase 6: User Story 4 — Manage SSH keys per server with rotation flow (P2)

**Goal**: operator opens Settings → SSH Keys, sees per-server fingerprint + rotation timestamp, clicks Rotate, types acknowledgement, the 5-step atomic flow runs end-to-end with rollback on any pre-step-5 failure.

**Independent test criteria**: server with active key K1 → POST /rotate-key → DB key swapped to K2, target's `authorized_keys` contains K2 (and lacks K1 if removeOldKeyFromTarget=true), `audit_entries.server.key_rotated` written with both fingerprints; if step 3 (verify) fails, DB key remains K1 and target's authorized_keys is restored to K1-only.

- [ ] T044 [BE] [US4] Implement `devops-app/server/services/ssh-key-rotation.ts` — typed `rotateKey(serverId, options, userId): Promise<RotationResult>` implementing the 5-step flow per research.md R-012. Acquires `deployLock.acquire(serverId, "ssh-rotate")` before Step 2; releases in `finally`. Step 2 appends new pubkey via `ssh "echo ${shQuote(pubkey)} >> ~/.ssh/authorized_keys"`. Step 3 opens fresh `ssh2.Client` with new private key for verify probe. Step 4 swaps encrypted column in a DB tx. Step 5 best-effort `sed -i` to remove old pubkey line by exact-match. Discriminated-union return per contracts/api.md (rotation_failed with `failedAtStep` + `rolledBack`).
- [ ] T045 [BE] [US4] Implement `POST /api/servers/:id/rotate-key` in `devops-app/server/routes/servers.ts` per contracts/api.md — Zod validation, `typedAcknowledgement: z.literal("ROTATE")`. 409 with `retryAfterMs` when deploy lock is held. 500 with `failedAtStep` on partial failure (rolled back). Audit `server.key_rotated` only on success path.
- [ ] T046 [FE] [US4] Build `devops-app/client/components/settings/SshKeysTab.tsx` — typed list of all servers with: label, host, auth method, key fingerprint (mono font), rotated-at timestamp (or "never" if NULL), Rotate button. Rotate opens confirm dialog with typed-text input (`ROTATE`), removeOldKeyFromTarget checkbox (default ON). Surfaces structured error from response (failedAtStep + detail). Controlled inputs.
- [ ] T047 [FE] [US4] Modify `devops-app/client/pages/SettingsPage.tsx` — register new "SSH Keys" tab, route at `/settings/ssh-keys`. Reuses existing tab-router pattern (verify pattern during implementation).
- [ ] T048 [BE] [US4] Add unit tests `devops-app/tests/unit/ssh-key-rotation.test.ts` — happy path 5 steps complete, success result; Step 2 fails → no DB change, no target side-effect; Step 3 verify fails → target's authorized_keys cleaned via Step-2-undo, DB unchanged; Step 4 DB write fails → tx rollback, target cleaned; Step 5 fails → DB has new key, target has BOTH keys (warning logged, not error).
- [ ] T049 [E2E] [US4] Add `devops-app/tests/integration/ssh-rotation-rollback.test.ts` — mock SSH executor: Step 2 succeeds, Step 3 (verify with new key) returns auth-rejected → assert response 500 with `failedAtStep: "verify_new_key"` + `rolledBack: true`, assert DB key fingerprint unchanged, assert target's `authorized_keys` lines exclude the candidate pubkey (cleanup via Step-2-undo verified).

---

## Phase 7: User Story 5 — Pre-flight VPS compatibility report before save (P2)

**Goal**: implementation already lives in US1 (T017/T021/T024/T025). This phase verifies the Save-button gating behaviour and warn-acknowledgement flow under hostile conditions.

**Independent test criteria**: a fixture compatibility report with one `fail` row blocks Save unconditionally; a report with one `warn` and one `pass` row enables Save only when the warn checkbox is acknowledged via `acknowledgedWarnings: [checkId]` in the request.

- [ ] T050 [BE] [US5] Add unit tests `devops-app/tests/unit/server-onboarding-gating.test.ts` — fixture report with `fail` rows → `addServer` throws `AppError.badRequest("compatibility_fail_blocks_save")` regardless of `acknowledgedWarnings`; `warn` rows in report but missing from `acknowledgedWarnings` → same error with `compatibility_warn_unacknowledged`; all warns acknowledged → save succeeds.
- [ ] T051 [E2E] [US5] Add `devops-app/tests/integration/add-server-compat-fail.test.ts` — POST /api/servers with fixture forcing `compatibility.checks` to include one `fail` row → assert 422 response, assert no `servers` row created, assert no audit `server.added` written. Reverse: same fixture but with `acknowledgedWarnings` matching all warn checkIds → 201 created.

---

## Phase 8: User Story 6 — Cloud-provider awareness with hints (P3)

**Goal**: detection table is code-defined; per-provider quirks surface as banners in the Compatibility Report; Initialise wizard's `useNoPty` defaults to ON for GCP.

**Independent test criteria**: cloud_provider="gcp" → CompatibilityReport.hints contains a string mentioning `use_pty`; cloud_provider="vanilla" → hints is empty array; adding a new provider entry to the code table requires touching exactly one file (no SQL).

- [ ] T052 [BE] [US6] Implement `devops-app/server/lib/cloud-provider-quirks.ts` — exported readonly `PROVIDER_QUIRKS: Record<CloudProvider, ProviderQuirk[]>` table per FR-025. Initial entries: GCP (`use_pty` blocks non-TTY sudo → Initialise sets `!use_pty`), AWS (5-min sudo password timeout — informational), Hetzner (`python3-apt` missing on default image — Initialise installs). Typed `ProviderQuirk { id: string; banner: string; remediation: "auto" | "manual"; appliedBy?: string }`. Code-only table — adding entries requires PR (FR-025).
- [ ] T053 [BE] [US6] Modify `devops-app/server/services/compatibility-probe.ts` (T017 site) to merge `PROVIDER_QUIRKS[cloudProvider]` banners into `CompatibilityReport.hints` array. Wire `useNoPty` default in T029 Initialise route handler to derive from `cloudProvider === "gcp"`.
- [ ] T054 [FE] [US6] Modify `devops-app/client/components/servers/CompatibilityReport.tsx` (T021 site) to render `report.hints` as banner row(s) above the checks table, iconified with `ℹ`. Hints are read-only — no actions; remediation is conveyed via wizard defaults, not click-throughs.
- [ ] T055 [BE] [US6] Add unit tests `devops-app/tests/unit/cloud-provider-quirks.test.ts` — every entry in `PROVIDER_QUIRKS` has typed shape, `vanilla` is empty list, GCP entry mentions `use_pty` substring (regression guard against future renames).
- [ ] T056 [E2E] [US6] Add `devops-app/tests/integration/initialise-uses-noptyDefault.test.ts` — POST /api/servers with mock cloud-init returning GCP → POST /api/servers/:id/initialise without `useNoPty` in body → assert dispatched script_runs params include `useNoPty: true`. Reverse: AWS-detected server → `useNoPty: false`.

---

## Phase 9: User Story 7 — Configurable Telegram notifications per event type (P2)

**Goal**: Settings → Notifications page configures TG channel + per-event toggles; gate routes every notification through preferences + cooldown + bucket + retry; existing `notifier.ts` callers become thin wrappers.

**Independent test criteria**: Test connection succeeds against mocked TG API on first attempt; toggling `deploy.failed` OFF via PUT causes a subsequent dispatch to drop with audit `notification.dropped.preferences_disabled`; flapping `healthcheck.degraded` produces 1 leading-edge message + cooldown drops with suppressed counter, next message after window includes "(N similar events suppressed)" suffix.

- [ ] T057 [BE] [US7] Implement `devops-app/server/services/notification-settings-store.ts` per contracts/api.md — typed CRUD over `notification_settings` singleton (`load()`, `updateTelegram(token, chatId, userId)`, `recordTestOutcome(ok, classification)`), `testConnection()` bypasses gate and calls `TelegramChannel.sendOnce` directly per contracts/notification-channel.md § Test connection bypass. Token sealed via `envelope-cipher.seal()` on UPDATE; never returned in load(). Audit `notification.settings_changed` on every UPDATE.
- [ ] T058 [BE] [US7] Implement `devops-app/server/services/notification-gate.ts` per contracts/notification-channel.md — singleton instance `gate` with `dispatch({ eventType, resourceId, payloadFormatter }): Promise<DispatchResult>`. Internal flow: catalogue check → preferences check → TG-configured check → per-pair cooldown (in-memory `Map<pairKey, CooldownEntry>`) → global token bucket (in-memory state per R-007) → format payload → `TelegramChannel.send` with retry classification (`classifyTelegramResponse` per contracts/notification-channel.md). Retry schedule `[1000, 4000, 16000]` ms transient. Permanent → flip `notification_settings.telegram_last_test_ok = false`. Constants exported as module-level for test override.
- [ ] T059 [BE] [US7] Modify `devops-app/server/services/notifier.ts` — drop env-var defaults (`process.env.TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID`), token now sourced from `notification-settings-store`. Refactor each `notifyXxx` method into a thin wrapper that calls `gate.dispatch({ eventType: <canonical>, resourceId, payloadFormatter: (suppressed) => this.formatXxx(payload, suppressed) })`. Remove the existing 60s coalesce code (gate's per-pair cooldown supersedes per contracts/notification-channel.md). Update existing `formatAppHealthChange` to take `suppressedCount: number` instead of `occurrences: number` (same shape, different label).
- [ ] T060 [BE] [US7] Implement routes file `devops-app/server/routes/notification-settings.ts` per contracts/api.md — `GET /api/settings/notifications` (combined TG state + events list with merged catalogue/prefs), `PUT /api/settings/notifications/telegram`, `POST /api/settings/notifications/telegram/test`, `PUT /api/settings/notifications/events/:eventType`. Zod schemas matching contracts. Token NEVER in any GET response; chat_id present. 404 `unknown_event_type` when path-param not in catalogue.
- [ ] T061 [FE] [US7] Build `devops-app/client/components/settings/TelegramConfigForm.tsx` — typed inputs for bot token (password-style with reveal/hide), chat ID, Test connection button. Token field shows `••••••••` placeholder when `botTokenConfigured: true`. Submit triggers PUT then auto-runs Test connection. Banner "needs reconfiguration" when `lastTestOk === false`. Surfaces structured error from 502 response (httpStatus + tgErrorDescription).
- [ ] T062 [FE] [US7] Build `devops-app/client/components/settings/EventToggleList.tsx` — typed list of events from `GET /api/settings/notifications` response, grouped visually by `category`, each row a switch with description. Toggle onChange immediately calls `PUT /api/settings/notifications/events/:eventType` (no Save button per FR-029). Optimistic UI with rollback on error.
- [ ] T063 [FE] [US7] Build `devops-app/client/components/settings/NotificationsTab.tsx` — wrapper component that renders `<TelegramConfigForm>` then `<EventToggleList>`. Surfaces persistent banner "Telegram channel not configured — notifications are dropped" iff `botTokenConfigured === false || chatId === null || lastTestOk === false`.
- [ ] T064 [FE] [US7] Build `devops-app/client/hooks/useNotificationSettings.ts` — typed hook returning current settings + mutation helpers (`updateTelegram`, `testConnection`, `toggleEvent`). Uses shared fetch wrapper, maps errors to typed union, optimistic updates with rollback.
- [ ] T065 [FE] [US7] Modify `devops-app/client/pages/SettingsPage.tsx` — register new "Notifications" tab next to SSH Keys (T047), route at `/settings/notifications`.
- [ ] T066 [BE] [US7] Add unit tests `devops-app/tests/unit/notification-gate-cooldown.test.ts` — fire 5 events of same `(eventType, resourceId)` within 5 min: 1 delivered, 4 dropped with `reason: "cooldown"` + suppressed counter increments to 4; advance virtual time past window; next event's `payloadFormatter` invoked with `suppressedCount = 4`; counter resets to 0 after delivery.
- [ ] T067 [BE] [US7] Add unit tests `devops-app/tests/unit/notification-gate-bucket.test.ts` — fire 25 events of 25 distinct `(eventType, resourceId)` pairs within 1 minute: first 20 delivered, last 5 dropped with `reason: "token_bucket"`; advance virtual time 60s; bucket fully refilled to 20.
- [ ] T068 [BE] [US7] Add unit tests `devops-app/tests/unit/notification-gate-retry.test.ts` — mock TG fetch returning 500 → 500 → 200: assert 3 attempts, success classification, no audit drop. Mock 401 single attempt → audit `delivery_failed_permanent`, `telegram_last_test_ok` flipped to false. Mock 429 with `parameters.retry_after = 5` → assert backoff respects 5s wait. Mock network timeout → 3 transient retries → final transient drop.
- [ ] T069 [BE] [US7] Add unit tests `devops-app/tests/unit/notification-settings-store.test.ts` — singleton CHECK constraint enforced (any second INSERT fails), token sealed on PUT (decrypts to original), `testConnection` returns `unconfigured` classification when token/chatId NULL, `recordTestOutcome` updates `last_test_at` + `last_test_ok` atomically.
- [ ] T070 [E2E] [US7] Add `devops-app/tests/integration/notification-gate-e2e.test.ts` — boot dashboard, configure TG via PUT + test connection (mocked TG returns 200), trigger 10 healthcheck.degraded events for same app within 5 min: assert exactly 1 TG `sendMessage` call, exactly 9 `notification.dropped.throttled` audit rows, `suppressed_count` in latest row = 9. Toggle `healthcheck.degraded` OFF via PUT; trigger another event; assert NO TG call, audit row reason `preferences_disabled`.
- [ ] T071 [E2E] [US7] Add `devops-app/tests/integration/telegram-test-connection.test.ts` — PUT TG settings then POST test → mocked TG returns 200, assert response `ok: true`, DB `telegram_last_test_ok = true`. Reset, mock 401 → assert response 502 + `classification: "permanent"` + `tgErrorCode: 401`, DB `last_test_ok = false`. Mock 429 then 200 → since test bypass is single-attempt (no retry on Test per contracts), assert 502 with `classification: "transient"`.

---

## Phase 10: Polish & Cross-Cutting Concerns

- [ ] T072 [DB] Add the seeder integration check `devops-app/tests/integration/event-preferences-seeded.test.ts` — boot a fresh dashboard against a freshly-migrated DB (no `notification_preferences` rows), assert post-boot every `EVENT_CATALOGUE` entry has a row whose `enabled` matches `defaultEnabled`. Verify idempotency: re-run seeder, assert no duplicate rows (PK collision swallowed by `ON CONFLICT DO NOTHING`).
- [ ] T073 [BE] Wire boot-time validation `devops-app/server/lib/boot-checks.ts` — fail-fast on dashboard start if `DASHBOARD_MASTER_KEY` missing/wrong-length OR if `notification_settings` singleton row absent (corrupted DB). Logs actionable remediation. Called from `server/index.ts` before any route registration.
- [ ] T074 [BE] Verify all new audit event types are registered in `devops-app/server/lib/audit-middleware.ts` (or wherever the existing `auditMiddleware` enumerates allowed actions per feature 001). Add: `server.added`, `server.initialised`, `server.key_rotated`, `app.env_vars_changed`, `app.env_vars_imported_from_example`, `notification.dropped.telegram_unconfigured`, `notification.dropped.throttled`, `notification.dropped.delivery_failed`, `notification.settings_changed`. Every type has a typed payload schema (Zod).
- [ ] T075 [SEC] Security audit pass: confirm no decrypted secret materialisation outside the three sanctioned paths — `sshPool` for SSH private keys, `env-vars-store.decryptForDispatch` for env vars, `notification-gate.dispatch` (via `TelegramChannel.send`) for TG bot token. Grep the codebase for `envelope-cipher.open(` callsites; assert each one is in a sanctioned module. Verify pino redact catches all probable leakage paths from T014. Document findings inline (`docs/SECURITY_CHECKLIST.md` if existing pattern, otherwise new section).
- [ ] T076 [SEC] Verify lazy-migration safety: integration test `devops-app/tests/integration/lazy-migration-safety.test.ts` — pre-migration row with plaintext `ssh_private_key`, post-0010 migration runs (no data loss), first edit through PATCH /api/servers moves key to encrypted column AND NULLs plaintext column atomically (DB tx). Reading via `serializer` returns no key material in either case.
- [ ] T077 [BE] Quickstart smoke check `devops-app/tests/integration/quickstart.test.ts` — drives the operator-facing flow from quickstart.md Steps 0..4 against mocked SSH + mocked TG: configure TG → add server (gen-key) → install pubkey → re-test → save → initialise → edit env vars → rotate key. Asserts each step's audit row appears in expected order. Equivalent to SC-001 + SC-007 + SC-002 + SC-003 smoke combined.
- [ ] T078 [OPS] Manual deployment-side checklist update — document in `docs/deployment.md` (or equivalent) that operators MUST set `DASHBOARD_MASTER_KEY` env var (base64 32 bytes, generated via `openssl rand -base64 32`) BEFORE running the 0010 migration. Loss = irreversible secret loss. No code changes — documentation only.
- [ ] T079 [BE] Final lint+typecheck+test pass per `npm run validate` per CLAUDE.md — every new file passes Biome/ESLint with no warnings, every Zod schema typecheck-clean, full test suite green. Failure here blocks merge.

---

## Dependency Graph

Following STRICT syntax (one rule per line, `→` single-unlock, `,` fan-out, `+` fan-in):

```
# Phase 1 → Phase 2 (sync barrier)
T001, T002, T003, T004, T005 → T006
T001, T002, T003, T004, T005 → T007
T001, T002, T003, T004, T005 → T009
T001, T002, T003, T004, T005 → T011
T001, T002, T003, T004, T005 → T013
T001, T002, T003, T004, T005 → T014

# Phase 2 internal
T006 → T015
T007 → T008
T009 → T010
T011 → T012
T011 → T015

# Phase 2 → Phase 3 (US1)
T006 + T007 + T009 + T011 + T013 + T014 + T015 → T016
T016 → T017
T016 → T018
T017 + T018 → T019
T019 → T020
T019 → T021
T021 → T022
T022 → T023
T017 → T024
T018 → T025
T019 → T026
T019 → T027

# Phase 3 → Phase 4 (US2)
T019 + T026 + T027 → T028
T028 → T029
T029 → T030
T030 → T031
T028 → T032
T029 → T033

# Phase 2 → Phase 5 (US3) — independent of US1/US2
T006 + T007 + T013 + T014 → T034
T034 → T035
T034 → T036
T034 → T037
T034 → T038
T037 + T038 → T039
T039 → T040
T034 → T041
T035 → T042
T037 + T038 → T043

# Phase 3 → Phase 6 (US4) — needs server with key
T007 + T009 + T019 → T044
T044 → T045
T045 → T046
T046 → T047
T044 → T048
T045 → T049

# Phase 5 (US5) — verifies US1 gating
T026 + T027 → T050
T026 + T050 → T051

# Phase 6 (US6) — extends US1
T017 + T021 → T052
T052 → T053
T052 → T054
T052 → T055
T029 + T053 → T056

# Phase 9 (US7) — independent of all server US, depends only on Phase 2
T006 + T007 + T011 + T013 + T014 + T015 → T057
T057 → T058
T058 → T059
T057 + T058 → T060
T060 → T061
T060 → T062
T061 + T062 → T063
T060 → T064
T063 + T064 → T065
T058 → T066
T058 → T067
T058 → T069
T057 + T058 → T070
T057 + T060 → T068
T057 + T060 → T071

# US2 notification wiring catches up after US7 — tracked inline in T028
# description; no separate task / no separate dependency edge required.

# Phase 10 (Polish) — sync barrier on all US phases
T015 + T070 → T072
T007 + T015 → T073
T029 + T037 + T045 + T060 → T074
T034 + T044 + T058 → T075
T034 → T076
T029 + T037 + T045 + T057 + T058 → T077
T006 → T078
T026 + T033 + T043 + T049 + T051 + T056 + T070 + T071 + T072 + T076 + T077 → T079
```

### Self-validation

- [x] Every task ID in Dependencies exists in T001..T079 list — re-verified after `/speckit.analyze` G1+G2 fixes (orphan refs `T044prereq`, `T028wire` removed).
- [x] No circular dependencies (DAG topology: Phase N → Phase N+ only; lateral within phase via fan-in).
- [x] Fan-in uses `+` only, fan-out uses `,` only — re-verified after G3 fix (invalid `←` line removed).
- [x] No chained arrows on a single line (every `→` separates exactly one source-set from one target-set).
- [x] Phase boundaries enforced as multi-source fan-ins (Phase 1 closes before any Phase 2 task; Phase 2 fully closes before Phase 3 starts via the 7-way fan-in into T016).

---

## Parallel Lanes

After Phase 2 sync barrier (T015 done), three user-story lanes fork in parallel:

| Lane | Agent flow | Tasks | Start condition |
|---|---|---|---|
| **Lane A — Server US1** | DB→BE→FE→E2E | T016..T027 | Phase 2 complete |
| **Lane B — App env-vars US3** | BE→FE→E2E | T034..T043 | Phase 2 complete (no US1 dependency) |
| **Lane C — Notifications US7** | BE→FE→E2E | T057..T071 | Phase 2 complete (no US1/US3 dependency) |

After Lane A completes:

| Lane | Tasks | Start condition |
|---|---|---|
| **Lane A2 — Initialise US2** | T028..T033 | Lane A complete (US2 needs server in DB) |
| **Lane A3 — SSH rotation US4** | T044..T049 | Lane A complete + foundational keygen (US4 needs server with key) |
| **Lane A4 — Compat gating US5** | T050..T051 | Lane A complete (verifies US1's Save-button logic) |
| **Lane A5 — Cloud hints US6** | T052..T056 | Lane A complete + Initialise route (T029 for `useNoPty` default wiring) |

Polish phase (T072..T079) runs after every US lane closes — pure sync barrier.

### Agent Summary

Some Phase-1 tasks carry two tags (e.g. `[SETUP] [BE]` for shared-file
writes that need backend judgement) — this is why tag occurrences (84)
exceed unique task count (79).

| Agent | Tag occurrences | Notable phases |
|---|---|---|
| `[SETUP]` | 5 | All in Phase 1 (T001..T005), each cross-tagged with the implementing-agent flavour |
| `[DB]` | 3 | T006 (migration), T015 (seeder), T072 (seeder test) |
| `[BE]` | 48 | Bulk of work — Phase 2..9 services + routes + unit tests |
| `[FE]` | 15 | UI components in US1, US2, US3, US4, US7 |
| `[OPS]` | 2 | T005 (script param audit), T078 (deployment doc) |
| `[E2E]` | 9 | Integration tests across every US + quickstart smoke |
| `[SEC]` | 2 | T075 (decryption-callsite audit), T076 (lazy-migration safety) |
| **Unique tasks** | **79** | sum of tags is 84 due to 5 cross-tagged Phase-1 tasks |

### Critical Path

Longest dependency chain (8 nodes):

```
T006 → T015 → T016 → T017 → T019 → T026 → T028 → T044 → T079
DB → seeder → onboarding → cloud-init → POST /servers → US1 E2E → US2 service → US4 service → final validate
```

Wall-clock estimate: ~8 working sessions of focused implementation (each node is ~1-3 hours with tests).

---

## Implementation Strategy

### MVP scope

**Smallest demoable slice: US1 + US7** (P1 + P2) end-to-end.

- US1 alone proves the secret-handling foundation (envelope encryption, SSH key gen, cloud probe, compatibility report) and gives operator value: "I can add a fresh VPS without touching local terminal".
- US7 alone proves the notification subsystem rewire and gives operator value: "I get TG-pinged when shit breaks, configurable from UI".

Both are independent (Lane A + Lane C run in parallel). Skip US2/US3/US4/US5/US6 for MVP — they extend the same foundations but aren't blocking the demo.

**Recommended demo path**: Phase 1 → Phase 2 → Lane A (T016..T027) + Lane C (T057..T071) in parallel → smoke via T077 quickstart-test. Operator demos: configure TG, add a fresh VPS, get notified that it's added.

### Incremental delivery

After MVP:

1. **Lane B (US3 env vars, P1)** — unblocks app-secret onboarding for new deploys. No prereqs beyond Phase 2.
2. **Lane A2 (US2 Initialise)** — completes the "fresh VPS to deployed app" loop. Needs MVP US1.
3. **Lane A3 (US4 rotation)** — security hygiene; less urgent. Needs MVP US1.
4. **Lane A4/A5 (US5/US6)** — small phases, mostly tests + polish. Needs MVP US1.
5. **Phase 10 (Polish)** — runs after every US lane closes.

### Parallel agent strategy

Three concurrent agents post-Phase 2:

- **Agent BE-A** (Lane A): server-onboarding + cloud-init + compatibility + POST /servers + US1 E2E
- **Agent BE-B** (Lane B): env-vars-store + migrator + scripts-runner integration + PATCH /env-vars
- **Agent BE-C** (Lane C): notification-gate + settings-store + routes + retry tests

Frontend agents fork accordingly:

- **Agent FE-A** (Lane A): AddServerForm + CompatibilityReport + useCompatibilityReport
- **Agent FE-B** (Lane B): EnvVarsEditor + EditAppForm integration
- **Agent FE-C** (Lane C): NotificationsTab + TelegramConfigForm + EventToggleList + useNotificationSettings + SettingsPage tab

No file overlap between lanes (verified during shared-file extraction in Phase 1). `SettingsPage.tsx` is the only frontend file with two writers (T047 SSH Keys tab + T065 Notifications tab) — sequenced in Lane A3 → Lane C with T047 → T065 dependency baked into the graph above.

---

## Independent test criteria summary (per US)

| US | Test gate | Tasks |
|---|---|---|
| US1 | Add VPS, see compatibility, save, audit row | T026, T027 |
| US2 | Initialise wizard drives setup_state to ready | T033 |
| US3 | PATCH env-vars → deploy gets SECRET_* exports | T043 |
| US4 | Rotation: success swaps, verify-fail rolls back | T049 |
| US5 | Compatibility fail blocks save, warn requires ack | T051 |
| US6 | GCP detected → useNoPty default ON | T056 |
| US7 | Per-event toggle gates, cooldown suppresses, retry classifies | T070, T071 |
| Polish | Quickstart end-to-end smoke | T077 |

---

## Generated by `/speckit.tasks`

Suggested next: `/speckit.implement` (or `/speckit.analyze` for cross-artifact consistency check first).
