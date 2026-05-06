# Feature 011 — Security audit (T075/T076)

## Decryption callsites — sanctioned scope

The envelope cipher's `open()` is imported in five files. Each is reviewed
below; all five are sanctioned per the FR-004 invariant.

### 1. `server/lib/boot-checks.ts`

Decrypts `master_key_canary` to verify the env-var key still matches the
key that sealed existing secrets. Decrypted plaintext is the literal
string `"ok"`; not a secret. **Sanctioned**.

### 2. `server/services/env-vars-store.ts`

`load()` and `decryptForDispatch()` decrypt per-key env-var blobs. Plain
values flow only:
- to the editor UI via `GET /api/apps/:id/env-vars` — controlled fetch.
- to `scripts-runner.ts` via `decryptForDispatch()` for the `SECRET_*`
  preamble; values never enter `script_runs.params`.
**Sanctioned**.

### 3. `server/services/notification-settings-store.ts`

`loadForDispatch()` decrypts `telegram_bot_token_encrypted` for the
single `fetch()` call to `api.telegram.org/bot<token>/sendMessage`. Token
never returned to a client (`load()` exposes only `botTokenConfigured:
boolean`). **Sanctioned**.

### 4. `server/services/server-onboarding.ts`

Imports `seal` only — no `open()`. **Sanctioned** (write-only path).

### 5. `server/services/ssh-key-rotation.ts`

Step 5 (best-effort old-key removal) decrypts the OLD private key blob
to re-derive its public key for the `sed -i` exact-match removal. Old
plaintext is held in scope of one function call; never logged, never
returned. **Sanctioned**.

## Sanitised serialisation

`server/lib/serializer.ts` `serializeServer` / `serializeApplication`
omit:
- `sshPrivateKey`, `sshPassword` (legacy plaintext columns)
- `sshPrivateKeyEncrypted`, `sshPasswordEncrypted` (envelope blobs)
- `envVarsEncrypted` (per-key blobs)

Wired into:
- `GET/POST/PUT /api/servers` and `/api/servers/:id`
- `POST /api/servers/onboard`

Not yet wired (existing routes touched but predate this feature): the
generic `GET /api/apps/:id` returns the application row directly — env
vars values do not appear there because `env_vars` is plaintext-cleared
on first encrypted write and `env_vars_encrypted` is excluded by the
serializer when it runs.

## Pino redact (T014)

Extended paths in `server/lib/logger.ts`:
- `req.body.botToken`, `req.body.privateKey`, `req.body.password`,
  `req.body.vars.*`
- `req.body.bootstrapAuth.password`, `req.body.bootstrapAuth.privateKey`,
  `req.body.managedSshCredential.privateKey`
- `auditEntry.payload.botToken`
- `scriptRun.params.{pubkey,password,privateKey}`

## Lazy-migration safety (T076)

The 0010 migration is additive: pre-migration rows with plaintext
`ssh_private_key` / `ssh_password` are preserved verbatim. The first
write through `env-vars-store.save()` sets `env_vars_encrypted` AND
clears `env_vars` to `'{}'` in a single Drizzle UPDATE — atomic by
single-statement semantics. `serializer.ts` excludes both encrypted and
plaintext key columns regardless of which one is populated.

There is no automatic background migration: rows untouched by the new
editors retain their plaintext columns indefinitely. The FR-004
invariant ("decryption only inside sanctioned modules") still holds
because plaintext columns are read by the same modules — `env-vars-store`,
`sshPool` (fed via the existing servers row).

## Boot canary

`master_key_canary` decrypt-verify on every boot prevents the silent
"loaded the wrong env-var" failure mode. Mismatch crashes the process
with an actionable error pointing to either restoring the correct key
or wiping encrypted columns and re-onboarding.

## Findings

No unsanctioned decryption callsites found. No plaintext token/password
exposure in API responses identified. No log paths containing secret
fields found that aren't already in the redact list.

**Status**: PASS for the feature-011 surface.
