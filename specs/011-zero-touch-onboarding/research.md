# Research: Zero-Touch VPS Onboarding & Secrets Management

**Date**: 2026-05-03 | **Branch**: `011-zero-touch-onboarding` | **Plan**: [plan.md](plan.md)

Resolves all NEEDS CLARIFICATION items from plan's Technical Context.
Each entry: Decision · Rationale · Alternatives considered.

---

## R-001 — Ed25519 keypair generation in Node

**Decision**: Use Node's built-in `crypto.generateKeyPairSync('ed25519', ...)`
with PEM export for the private side, hand-coded OpenSSH wire-format encoder
for the public side (see R-002).

```ts
import { generateKeyPairSync, createPublicKey } from "node:crypto";

const { publicKey, privateKey } = generateKeyPairSync("ed25519", {
  publicKeyEncoding: { type: "spki", format: "der" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
// privateKey is PEM string ready for ssh2 / DB encryption
// publicKey is DER buffer; convert to OpenSSH wire format per R-002
```

**Rationale**:

- Zero new dependencies. Node `crypto` ships Ed25519 since v12.
- `ssh2` (already in repo) accepts PEM-format Ed25519 private keys directly
  via `privateKey` connection option.
- Synchronous API is fine — Ed25519 keygen is microseconds, not milliseconds.

**Alternatives**:

- `sshpk` (~20 kB, MIT) — produces both PEM and OpenSSH formats out of the
  box. Rejected: extra dep, CLAUDE.md Standing Order #2 friction, when ~30
  lines of encoding logic suffices.
- Shell out to `ssh-keygen` — rejected: requires `ssh-keygen` on the dashboard
  host (not always installed in slim Docker images), and shellouts are
  uncomfortable to test.
- `node-forge` — overkill, ~150 kB, no Ed25519 in stable releases.

---

## R-002 — OpenSSH public-key encoding

**Decision**: Hand-coded encoder — Ed25519 OpenSSH public key is
`"ssh-ed25519 " + base64(string("ssh-ed25519") + string(rawPubKey))` where
`string(s)` is `length(uint32be) || s`.

```ts
function toOpenSshPubKey(derPubKey: Buffer): string {
  // Strip 12-byte SPKI/DER header to get the 32-byte raw Ed25519 pubkey
  const raw = derPubKey.subarray(derPubKey.length - 32);
  const algo = Buffer.from("ssh-ed25519", "ascii");
  const wire = Buffer.concat([
    lenPrefixed(algo),
    lenPrefixed(raw),
  ]);
  return `ssh-ed25519 ${wire.toString("base64")}`;
}
function lenPrefixed(buf: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(buf.length, 0);
  return Buffer.concat([len, buf]);
}
```

**Rationale**: ~15 lines, deterministic, fully tested by comparing
fingerprint against `ssh-keygen -lf` on a known fixture. No deps.

**Alternatives**: `sshpk.parseKey(...).toString("ssh")` — same dep
rejection as R-001.

**SHA256 fingerprint**: standard format `SHA256:<base64-no-padding>` from
hashing the Buffer that follows the `ssh-ed25519 ` prefix (i.e. the wire
buffer above). Computed via `crypto.createHash("sha256").update(wire).digest("base64").replace(/=+$/, "")`.

---

## R-003 — Envelope encryption scheme

**Decision**: AES-256-GCM with per-row 12-byte random IV. Master key from
`DASHBOARD_MASTER_KEY` env var (base64-encoded 32 bytes). Persisted shape:
`{ ct: <base64 ciphertext>, iv: <base64 iv>, tag: <base64 GCM auth tag> }`.

```ts
// envelope-cipher.ts
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export interface EnvelopeBlob { ct: string; iv: string; tag: string; }

const KEY = (() => {
  const raw = process.env.DASHBOARD_MASTER_KEY;
  if (!raw) throw new Error("DASHBOARD_MASTER_KEY env var required");
  const buf = Buffer.from(raw, "base64");
  if (buf.length !== 32) throw new Error("DASHBOARD_MASTER_KEY must decode to 32 bytes");
  return buf;
})();

export function seal(plaintext: string): EnvelopeBlob {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", KEY, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    ct: ct.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}

export function open(blob: EnvelopeBlob): string {
  const iv = Buffer.from(blob.iv, "base64");
  const ct = Buffer.from(blob.ct, "base64");
  const tag = Buffer.from(blob.tag, "base64");
  const decipher = createDecipheriv("aes-256-gcm", KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}
```

**Rationale**:

- AES-256-GCM is AEAD: ciphertext tampering is detected at decrypt time.
- Per-row random IV (12 bytes is GCM standard) — collision probability
  negligible for the row counts this dashboard handles (~hundreds).
- Master key from env (per A-002): operator-managed, rotation deferred to
  v2 (would require re-sealing every encrypted blob).
- Fail-fast at boot: if env var missing or malformed length, dashboard
  refuses to start. No silent fallback to "encryption disabled".

**Alternatives**:

- AES-256-CBC + HMAC — requires manual MAC management, error-prone, no AEAD.
- libsodium (`sodium-native`) — heavyweight native dep, build complexity.
- Argon2-derived key — unnecessary complexity; master key is already
  high-entropy.

**Used by**:

- `servers.ssh_private_key_encrypted` (single string blob)
- `servers.ssh_password_encrypted` (single string blob — added per gemini
  review #3; transient root password gets the same envelope treatment)
- `applications.env_vars_encrypted` (jsonb keyed by var name, each value
  is an EnvelopeBlob)
- `notification_settings.telegram_bot_token_encrypted` (single string blob)
- `notification_settings.master_key_canary` (single string blob — added
  per gemini review #1; boot-time decrypt of literal `"ok"` validates
  that the master key still matches the data sealed in the DB)

**Master key canary (gemini #1)**: at first boot after migration, if
`master_key_canary` is NULL, seal `"ok"` with the current key and
persist. On every subsequent boot, attempt to decrypt; success ⇒ key
valid, proceed. Failure (GCM auth-tag mismatch or NULL plaintext mismatch)
⇒ fail-fast crash with: `AppError.internal("DASHBOARD_MASTER_KEY does
not match the key used to seal existing secrets. Either restore the
correct key or wipe the encrypted columns and re-onboard.")`. Without
this, a key swap silently corrupts every read attempt at runtime —
deploys mysteriously fail with `auth tag mismatch` errors hours later.
Implemented in `boot-checks.ts` (T073), validated by
`envelope-cipher.test.ts` (T008).

---

## R-004 — SSH credential lifecycle: bootstrapAuth vs managedSshCredential

**Revised per github P0 #2 + gemini #3.**

The Add Server flow has TWO conceptually distinct credential roles, and
the original draft conflated them into a single `auth` field. Split them:

- **bootstrapAuth** — "how the dashboard gets onto a fresh VPS RIGHT
  NOW". Disposable. Possible modes: paste-root-password, paste-existing-
  key (operator's existing fleet key). Used once during initial connect
  + Initialise dispatch.
- **managedSshCredential** — "the dashboard's permanent deploy credential
  going forward". Always a key. Possible sources: generate-new (default
  for password-mode + generate-key bootstrap), reuse-bootstrap-key (if
  operator's pasted key IS what they want the dashboard to use long-term).

**Persistence**:

| Column | Holds | Lifecycle |
|---|---|---|
| `ssh_password_encrypted` | bootstrapAuth password (envelope-sealed per gemini #3) | NULL by default; populated when mode=password; cleared atomically on Initialise success per US1/US2 password-mutation edge case |
| `ssh_private_key_encrypted` | managedSshCredential private key | populated at save time (generated or copied from bootstrap key); never cleared |
| `ssh_user` | bootstrap mode: `root` (or whatever operator typed); after Initialise: `deployUser` | mutated atomically on Initialise success |
| `ssh_auth_method` | `password` initially when password-mode; `key` after Initialise | flipped on Initialise success |

**Why encrypt the bootstrap password (gemini #3)**: original draft kept
it plaintext on the assumption it'd live for ~5 minutes. Reality: operator
adds server, gets distracted, forgets to click Initialise. Plaintext root
password sits in DB indefinitely. Envelope encryption is a 3-line change
that closes the window.

**Edge cases**:

- If Initialise fails mid-flow, bootstrapAuth columns stay populated so
  retry works. Auth method does not flip.
- Re-running Add Server with mode=password + new password overwrites
  `ssh_password_encrypted` — no archival of prior passwords.
- Generate-key flow: `ssh_private_key_encrypted` populated at save;
  Initialise installs the matching public key into `deployUser`'s
  `authorized_keys`. Same key used across deploys. If operator changes
  `deployUser` mid-wizard, key is reused (not regenerated) per US1
  edge case.

**Alternatives**:

- Single `auth` field with discriminated union (original draft) —
  rejected: two roles, two lifecycles, conflating them invites bugs.
- Encrypt the password column with a separate, shorter-TTL key —
  rejected: complexity (key rotation lifecycle) outweighs the marginal
  benefit; envelope-cipher already exists and works.

---

## R-005 — Cloud-init metadata probes

**Decision**: Run all four provider probes in parallel over the SSH
session using a single shell pipeline. First successful response wins;
all four fail → "vanilla". Per-probe timeout 2s.

| Provider | Endpoint | Required header | Identifier in response |
|---|---|---|---|
| GCP | `http://metadata.google.internal/computeMetadata/v1/instance/id` | `Metadata-Flavor: Google` | numeric instance ID |
| AWS | `http://169.254.169.254/latest/meta-data/instance-id` | none (IMDSv1); `X-aws-ec2-metadata-token: $TOK` (IMDSv2 — fetch token first via PUT to `/latest/api/token` with `X-aws-ec2-metadata-token-ttl-seconds: 60`) | `i-...` ID |
| DO | `http://169.254.169.254/metadata/v1/id` | none | numeric droplet ID |
| Hetzner | `http://169.254.169.254/hetzner/v1/metadata/instance-id` | none | numeric server ID |

```bash
# Run on target via execStream (with 2s per-curl timeout)
( curl -sf --max-time 2 -H 'Metadata-Flavor: Google' \
    http://metadata.google.internal/computeMetadata/v1/instance/id 2>/dev/null \
    && echo "PROVIDER=gcp" ) || \
( ... AWS variant ... ) || \
( ... DO variant ... ) || \
( ... Hetzner variant ... ) || \
echo "PROVIDER=vanilla"
```

**Rationale**: Single SSH round-trip (vs four), all probes run on the
target (only the target can reach 169.254.169.254 — the dashboard host
typically cannot). Result line `PROVIDER=<id>` is grepped from output.

**AWS IMDSv2 wrinkle**: AWS instances can be configured to require IMDSv2
(token-based). The probe does a PUT first to fetch the token; if PUT
fails with 405, fall back to IMDSv1. Both modes are widespread in
production.

**Alternatives**:

- Run probes from the dashboard host directly — fails: 169.254.169.254
  is link-local from the *target's* network, unreachable from the
  dashboard.
- Use `cloud-init query` — requires cloud-init installed (true on most
  cloud images, but not universal); curl is universal.

---

## R-006 — Notification gate vs full NotificationChannel refactor

**Decision**: Extract gating logic only. New `notification-gate.ts`
exposes `gate.dispatch({ eventType, resourceId, payloadFormatter })`.
The existing `notifier.notifyAppHealthChange` etc. become callers:

```ts
// Before
async notifyAppHealthChange(payload: AppHealthChangePayload) {
  // ...build text, call this.send(token, chatId, text)
}

// After
async notifyAppHealthChange(payload: AppHealthChangePayload) {
  return gate.dispatch({
    eventType: "app.health.changed",
    resourceId: payload.appId,
    payloadFormatter: () => this.formatAppHealthChange(payload, 1),
  });
}
```

The `dispatch` method handles preferences check → cooldown → bucket →
retry → audit. The TG-specific transport (the existing `this.send`) is
called from inside the gate as the single concrete sink.

**Rationale**: 60-line refactor vs 600-line unification. The
`NotificationChannel` interface (FR-033) is satisfied **at the boundary**
— callers don't know whether the leaf is TG, email, or webhook. The
interface lives as a TypeScript type, but v1 ships exactly one
implementation, inlined in `notifier.ts`. v2 adds a second implementation
without touching callers.

**Tradeoff accepted**: spec FR-033 implies a more formal interface; v1
satisfies the spirit (callers depend on event-type + payload shape, not
on TG specifics) without the Day-1 cost of full polymorphism.

---

## R-007 — Throttling state durability

**Decision**: In-memory only. `Map<string, CooldownEntry>` for per-pair
state, plus a counter + last-refill timestamp for the global token bucket.
Reset on dashboard restart.

```ts
interface CooldownEntry {
  firstSendAt: number;        // wall-clock ms of last delivered message
  suppressedSinceLastSend: number;
  lastPayloadSnapshot: unknown;
}
```

**Rationale**: A-007 declares dashboard single-instance for v1. In-memory
Map is O(1), zero deps, zero migration. Persistent state would add a
table (`notification_throttle_state`) with no v1 benefit — restart
clears the state anyway, and a restart is a much rarer event than a
notification dispatch.

**Behaviour on restart**: Suppression counters reset to 0; cooldown
windows reset (the next event of every pair fires immediately, even if
sent <5 min before crash). Acceptable: a dashboard restart is operator
attention, not normal flow.

**Alternatives**:

- Persistent `notification_throttle_state` — overkill for v1; deferred to
  v2 alongside multi-instance support.
- Redis — introduces external infra dep; this project doesn't use Redis.

---

## R-008 — Per-app env vars at deploy dispatch time

**Decision**: Reuse feature 005's secret-transport convention — `SECRET_<KEY>`
exports rendered into the deploy script's environment via `executeWithStdin`.
The `EnvVarsStore.decryptForDispatch(appId)` returns `Record<string, string>`
that gets transformed by the runner into `export SECRET_KEY='...'` lines
prepended to the script body (single-quoted heredoc, FR-014).

```ts
// scripts-runner.ts (existing flow, conceptually)
const secrets = await envVarsStore.decryptForDispatch(application.id);
const exports = Object.entries(secrets)
  .map(([k, v]) => `export SECRET_${k}=${shQuote(v)}`)
  .join("\n");
const body = `${exports}\n${scriptText}`;
return sshPool.executeWithStdin(serverId, "bash -s", Buffer.from(body));
```

`shQuote` (from feature 005) wraps single quotes correctly. Decrypted
values never appear in `script_runs.params`, never logged, never returned
via API.

**Rationale**: Established convention from feature 005; this feature only
adds the *source* (encrypted DB column instead of `applications.env_vars`
plaintext). Pino redact already covers secret leakage paths.

---

## R-009 — Telegram Bot API error classification

**Decision**: Status-code mapping baked into `notification-gate.ts`.

| HTTP status | TG `error_code` | Class | Action |
|---|---|---|---|
| 200 + `{ok: true}` | — | success | record success, reset cooldown counter |
| 400 | usually 400 (Bad Request) | permanent | mark settings broken, audit, drop |
| 401 | 401 (Unauthorized — token revoked) | permanent | same |
| 403 | 403 (bot blocked / kicked) | permanent | same |
| 404 | 404 (chat not found) | permanent | same |
| 429 | 429 (rate limit) | transient | honour `parameters.retry_after`, retry |
| 5xx | — | transient | exponential backoff retry |
| network/timeout | — | transient | exponential backoff retry |

Backoff schedule (per FR-041): attempts at 0s, ~1s, ~4s, ~16s. Total
worst-case latency ~21s before final transient give-up.

**Rationale**: Matches official TG Bot API semantics. Permanent errors
indicate operator action required; retrying just hammers the API. 429 is
transient *and* TG provides the wait time — respect it instead of
guessing.

**Alternatives considered**:

- Treat all non-200 as permanent — too aggressive; transient TG outages
  would lose entire bursts of notifications.
- Retry everything — wastes resources on 401/403/404 which won't recover
  without operator action.

---

## R-010 — Compatibility probe execution

**Decision**: Single composite SSH command — one round-trip, structured
output (key=value lines). Parsed by `compatibility-probe.ts` into
per-check `pass / warn / fail` with summary.

```bash
echo "SSH=ok"
sudo -n true 2>&1 && echo "SUDO_NOPASSWD=ok" || echo "SUDO_NOPASSWD=fail"
grep -q '^Defaults.*use_pty' /etc/sudoers /etc/sudoers.d/* 2>/dev/null \
  && echo "USE_PTY=set" || echo "USE_PTY=unset"
docker --version 2>/dev/null && echo "DOCKER=ok" || echo "DOCKER=missing"
# POSIX format `-P` forces single-line output regardless of long mount-source
# names (LVM / overlayfs etc.) per gemini review #6 — without `-P`, df may
# wrap and awk picks the wrong column.
df -PBG / | tail -1 | awk '{print "DISK_FREE_GB="$4}' | tr -d 'G'
swapon --show=NAME --noheadings | head -1 | awk '{print "SWAP="($1?"yes":"no")}'
. /etc/os-release && echo "OS_FAMILY=$ID" && echo "OS_VERSION=$VERSION_ID"
uname -m | awk '{print "ARCH="$1}'
```

**Warn/fail matrix** (revised per github P0 #3 to remove conflicting
guidance between quickstart.md and tasks.md):

| Check | `pass` | `warn` | `fail` |
|---|---|---|---|
| SSH connection | reachable + auth ok | n/a | unreachable / auth failed |
| Sudo non-interactive | works | works but `use_pty` set (auto-fixable by Initialise) | absent / requires password |
| Docker installed | present, version ≥ 20 | n/a | absent (auto-fixable by Initialise) |
| Disk free | ≥ 10 GB | 5–10 GB | < 5 GB |
| Swap | present | absent (Initialise will create) | n/a |
| OS family | Ubuntu 22.04+ / Debian 12+ | other Linux + systemd | non-Linux / no systemd |
| Architecture | x86_64 | ARM64 | other |

**Save gating**: `fail` rows BLOCK save unconditionally (operator must
fix externally OR pick a different VPS). `warn` rows allow save with
explicit per-row click-through. Rows that have an "auto-fixable by
Initialise" marker (Docker missing, swap absent, use_pty set) downgrade
from `fail` to `warn` — the post-Initialise state will be `pass`, so
blocking save is wrong; surface as `warn` with one-click "Initialise
will fix this" remediation.

Parser splits on `=`, validates against an allowlist of expected keys,
maps missing keys to `unknown` (treated as `warn`). Output rendered as
the Compatibility Report (FR-019..022).

**Rationale**: Single round-trip vs ~8 (latency matters on slow links).
Structured key=value beats free-form parsing. Composite probe lives as a
*bash heredoc inside the compatibility-probe.ts module*, not a separate
script — small, self-contained, version-controlled with the parser.

**Alternatives**:

- Parallel curl-style checks via separate SSH commands — wasted round-trips.
- Ship as a bash file in `scripts/server/compatibility-probe.sh` — adds
  filesystem dispatch overhead via the runner; the probe is dashboard-side
  logic, not target-side operational concern.

---

## R-011 — Lazy backfill semantics for plaintext → encrypted columns

**Decision**: Code-side, on-write migration. No SQL backfill in `0010_zero_touch.sql`.

```ts
// env-vars-migrator.ts
async function migrateOnWrite(appId: string, newPlaintextVars: Record<string, string>) {
  const sealed: Record<string, EnvelopeBlob> = {};
  for (const [k, v] of Object.entries(newPlaintextVars)) {
    sealed[k] = seal(v);
  }
  await db.update(applications)
    .set({ envVarsEncrypted: sealed, envVars: {} })  // legacy column cleared
    .where(eq(applications.id, appId));
}

// On read (env-vars-store.ts)
function load(row: ApplicationRow): Record<string, string> {
  // Encrypted takes precedence
  if (row.envVarsEncrypted) {
    return mapValues(row.envVarsEncrypted, blob => open(blob));
  }
  // Fall back to legacy plaintext (read-only path until first edit)
  return row.envVars as Record<string, string>;
}
```

**Rationale**:

- SQL-side backfill would require the master key inside the migration
  process. Keeping crypto in the application layer keeps the migration
  independent of secrets.
- "First write wins" is forgiving — operator can take their time
  migrating; nothing breaks until they edit an app's env vars.
- Same pattern applies to `servers.ssh_private_key` → `ssh_private_key_encrypted`:
  any UPDATE that touches auth method moves the key encrypted-side,
  NULLs the plaintext column.

**Alternatives**:

- Eager full backfill on dashboard boot — risky: if master key is wrong
  on first boot post-deploy, every plaintext column is corrupted with
  garbage encrypted blobs. Lazy avoids this.
- Single batch backfill behind a Settings button "Migrate all secrets" —
  v2 polish if operators want; not required for v1 correctness.

---

## R-012 — SSH key rotation atomicity

**Decision**: Five steps under per-server deploy lock; rollback on any
post-step-1 failure.

```
Step 1: generate new keypair                           [in-memory only]
Step 2: install new pubkey on target via current SSH   [target side-effect]
Step 3: open NEW SSH session with new private key      [verify]
Step 4: swap rows in DB (encrypted_old → encrypted_new) [DB write]
Step 5: remove old pubkey from target's authorized_keys [optional, target side-effect]

Failure handling:
  Step 1 fail: nothing to undo
  Step 2 fail: nothing on target yet (atomic line append failed) — abort
  Step 3 fail: remove the line we appended in Step 2 → restore prior state
  Step 4 fail: same as Step 3 cleanup (DB rolled back via tx)
  Step 5 fail: log warning, leave DB at new key, leave both keys on target
               (operator can clean up via raw SSH later)
```

Lock acquisition (feature 004 `deployLock.acquire(serverId, "ssh-rotate")`)
prevents concurrent deploys from interrupting the swap. Deploy attempts
during rotation queue normally.

**Rationale**: Step 5 is "best effort" because the new key is already
proven working in Step 3. Failing to remove the old key is a hygiene
issue, not an availability issue. Steps 2-4 are wrapped in a try/catch
with explicit rollback because they could leave the target in a broken
state (target has new key but DB still points to old).

**Alternatives**:

- Single atomic "replace authorized_keys" — would lose other keys
  operator added manually. Strict append + targeted line-removal
  preserves them.
- Skip Step 5 entirely (always leave both keys) — clutters
  `authorized_keys` over many rotations; explicit removal is cleaner.

---

## Open items deferred to plan (Open Questions in spec.md)

OQ-001..OQ-005 from spec.md are restated with current resolution intent:

- **OQ-001** (private key auth method mismatch): No special handling.
  SSH connection test fails generically with "auth rejected" → operator
  investigates. Documented in US1 Edge Cases.
- **OQ-002** (`.env.example` re-import diff vs merge): **Merge only in
  v1**. New keys append; existing keys keep their values. Diff UI is v2
  polish.
- **OQ-003** (rotation while reconciler holds SSH session): Deploy lock
  serialises rotations vs deploys, but the reconciler (feature 008's
  caddy-reconciler) is not deploy-class. Mitigation: rotation closes all
  pooled SSH sessions for that server before swap; reconciler opens a
  new session next tick (transparent reconnect with new key).
- **OQ-004** (Pre-flight report timing): Triggered explicitly by
  "Test connection" button (form blur is too aggressive — a typo in the
  hostname would fire 8 SSH attempts). No debounce; one click = one
  probe.
- **OQ-005** (Provider quirks table maintenance): v1 first-party only.
  Code review required for additions. v2 may open up after first
  community PR demand.
