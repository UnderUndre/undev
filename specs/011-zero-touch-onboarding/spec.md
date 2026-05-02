# Feature Specification: Zero-Touch VPS Onboarding & Secrets Management

**Version**: 1.0 | **Status**: Draft | **Date**: 2026-05-02

## Clarifications

### Session 2026-05-02 (initial)

- Q: Scope — full guided onboarding (operator clicks "Add server" → dashboard
  generates SSH keys → installs tooling → ready to deploy) OR incremental UI
  layers on top of existing scripts? → A: **Incremental UI layers**. The
  shell scripts (`setup-vps.sh`, `env-setup.sh`, `install-caddy.sh`,
  `health-check.sh`) already implement the heavy lifting end-to-end. This
  spec wires them into wizards + adds the missing UX glue (SSH key generation,
  env-vars editor, health pre-check). No script logic re-implementation —
  the goal is "make existing capability discoverable and safe".
- Q: SSH key generation — operator pastes existing key OR dashboard
  generates a fresh keypair on demand? → A: **Both, operator chooses per
  server**. Existing key paste preserves "I already have a managed key
  fleet" workflow (CI/CD shops with PKI). Generate-new-keypair lets the
  operator who just rented a fresh VPS get going without local
  `ssh-keygen` ceremony — dashboard creates Ed25519 pair, stores private
  encrypted, surfaces public for one-time copy into the VPS's
  `authorized_keys` and (optionally) GitHub deploy keys.
- Q: Env-vars storage — encrypted at rest in DB, OR plaintext relying on
  DB backup hygiene? → A: **Encrypted at rest** with per-row envelope
  encryption. Existing `applications.env_vars` jsonb column is loosely
  typed; add a new `applications.env_vars_encrypted` jsonb keyed by
  variable name with `{ ciphertext, iv }` per value. Plaintext on the wire
  only at deploy dispatch time (rendered into `SECRET_*` env exports per
  feature 005). Dashboard never logs decrypted values.
- Q: VPS pre-flight health check scope — minimal (ping + SSH banner) OR
  comprehensive (OS detect + arch + sudo capability + docker presence +
  use_pty status + disk free + swap status)? → A: **Comprehensive,
  surfaced as a "compatibility report"**. Each check labelled `pass` /
  `warn` / `fail` with actionable text. `fail` blocks save; `warn` lets
  operator proceed with full-disclosure click-through. Mirrors the
  pre-issuance DNS pre-check pattern from feature 008 FR-014.
- Q: Cloud-provider awareness — opinionated detection (AWS / GCP / DO /
  Hetzner / vanilla) with provider-specific tuning, OR provider-agnostic? →
  A: **Detection-with-hints**. Detect via cloud-init metadata endpoints
  (`http://169.254.169.254/...` per provider) when reachable from VPS,
  fall back to "vanilla". Hints surface in pre-flight report (e.g. "GCP
  detected — `Defaults use_pty` will block non-TTY sudo; Initialise will
  add `!use_pty` for the deploy user"). Not opinionated installs — operator
  always confirms each step.
- Q: One-shot bootstrap (one button "Add VPS, install everything, ready") OR
  multi-step wizard (each step reviewable + skippable)? → A: **Multi-step
  wizard with progress per step**. Reasoning: setup is high-risk
  (modifying production server). Operator must see each step's diff/
  rationale before confirming. One-shot hides errors, multi-step makes
  failure recoverable from the failed step (mirrors feature 009 bootstrap
  state machine pattern).

## Problem Statement

After incident 2026-05-02 (cliproxyapi-dashboard onboarding marathon — 6
distinct issues from path doesn't exist → sudo no-TTY → compose path
mismatch → missing .env), the gap between "I rented a VPS" and "my app is
running on the dashboard" is measured in hours of operator-side terminal
work. The dashboard already has all primitives (SSH pool, scripts, secret
transport, manifest dispatch), but the **journey from blank VPS to
deployed app requires terminal access at every step**:

1. **Add Server**: operator must run `ssh-keygen` locally, paste private
   key into dashboard's Add Server form, manually copy the generated
   public key into target's `~/.ssh/authorized_keys`. No verification that
   the key actually works until first dispatch fails.

2. **Bootstrap blank VPS**: `scripts/server/setup-vps.sh` exists and does
   the right thing (deploy user, SSH hardening, swap, ufw, fail2ban,
   docker), but operator must `curl | bash` it manually as root over SSH.
   No dashboard-driven flow. No progress indication. No idempotent
   re-runs.

3. **Generate SSH keys for GitHub repo access**: deploy user on the new
   VPS needs an Ed25519 key pair to clone private repos. Operator must
   `ssh deploy@vps && ssh-keygen && cat ~/.ssh/id_ed25519.pub` and paste
   into GitHub. No dashboard helper.

4. **Per-app environment variables**: when the cloned repo has
   `.env.example`, operator must SSH, `cp .env.example .env`, `nano .env`,
   fill secrets, replace `CHANGE_ME_*` placeholders. Dashboard's
   `applications.env_vars` jsonb column exists but has no editor in the UI.
   Secrets sit unencrypted.

5. **Pre-flight compatibility**: operator can add a server with wrong
   credentials, wrong OS, missing docker, or `Defaults use_pty` enabled
   — and discovers the issue only when the first deploy fails 10 minutes
   in. No fast-fail "this VPS is not ready" report.

6. **Cloud-provider quirks**: GCP enforces `use_pty`, AWS has 5-min sudo
   password timeout, Hetzner default Ubuntu image lacks `python3-apt`,
   etc. Operators discover these via failed deploys, not upfront.

This feature closes those six gaps with UI flows, leveraging existing
scripts as the execution layer. No new shell-script writing — just wiring
the existing capability into reachable, safe, recoverable wizards.

## User Scenarios & Testing

### User Story 1 — Add a new VPS with auto-generated SSH credentials (Priority: P1)

As an operator who just rented a VPS from any cloud provider, I want to
add it to the dashboard by entering host + port + initial root credentials
(or my own existing SSH key), have the dashboard generate a fresh deploy
keypair, and verify the connection works — all without opening my local
terminal.

**Acceptance**:

- "Add Server" form has three auth modes: (a) paste existing private key,
  (b) paste root password (one-time, for initial setup only), (c)
  generate new Ed25519 keypair.
- Mode (c) shows the freshly-generated public key in a copyable code block
  with instructions: "Add this line to `~/.ssh/authorized_keys` on your
  VPS as the user you want the dashboard to use".
- After save, dashboard runs a connection test (SSH `whoami` + `id` +
  `uname -a`) and shows result inline before considering the server
  "added".
- Failed connection test blocks save with actionable error (DNS, port,
  auth, host key mismatch).
- The generated private key is stored encrypted in the database; never
  logged, never returned via API after initial save.

### User Story 2 — Initialise a blank VPS with one click (Priority: P1)

As an operator who just added a fresh VPS, I want to click "Initialise
this server" and have the dashboard run the existing `setup-vps.sh`
script with chosen configuration (deploy user name, swap size, firewall
rules, sudo `!use_pty` toggle), watching live progress in the same modal
that powers deploy log tail (incident 2026-05-02 fix).

**Acceptance**:

- Server detail view shows an "Initialise" button when detection finds:
  no `docker`, no deploy user matching dashboard's configured user, OR
  fail2ban absent.
- Clicking opens a wizard: (1) summary of what will be installed,
  (2) configurable options (deploy user name, swap size, ufw rules, add
  `!use_pty` sudoers entry — defaults inferred from cloud-provider
  detection per US6), (3) confirmation with typed acknowledgement, (4)
  live progress.
- Live progress streams via the file-tail modal already implemented
  (incident 2026-05-02 fix); no new live-tail mechanism needed.
- On completion, server status flips from "needs setup" → "ready" and
  the dashboard auto-runs first health probe.
- Re-running Initialise on already-initialised server skips done steps
  (idempotent — script already supports this; UI surfaces "skipping X
  because already configured").

### User Story 3 — Edit per-app environment variables in the UI (Priority: P1)

As an operator deploying any app that needs secrets (DB passwords, API
keys, JWT secrets), I want to manage env vars through a UI editor instead
of SSHing to the host and editing `.env` files. Auto-fill from
`.env.example` when present in the repo.

**Acceptance**:

- Edit Application form has new "Environment variables" section with
  a key-value table editor.
- Each row: key (text), value (password-input with reveal/hide toggle),
  delete button.
- "Add variable" button appends empty row.
- "Import from .env.example" button (visible when repo cloned + file
  detected) parses the file, prefills keys with defaults from comments,
  flags `CHANGE_ME_*` patterns as required.
- Save persists encrypted (per-value envelope encryption); decrypted only
  at deploy-dispatch time as `SECRET_<KEY>` env exports per feature 005's
  secret transport.
- Detected `CHANGE_ME_*` placeholder values warn at save: "These values
  look like placeholders. Continue?" with explicit confirm.
- Generate-secret helper: button next to value field that runs
  `openssl rand -hex 32` style generation client-side and fills the value.

### User Story 4 — Manage SSH keys per server with rotation flow (Priority: P2)

As a security-conscious operator, I want a Settings → SSH Keys page that
shows which key authenticates each server, when it was generated/rotated,
and lets me rotate without losing access mid-rotation.

**Acceptance**:

- Settings → "SSH Keys" tab lists all servers with: server name, auth
  method, key fingerprint (SHA256), generated/rotated timestamp.
- "Rotate" action: (1) generates new keypair, (2) installs new public
  key on target via existing SSH session, (3) verifies new key works
  (parallel SSH test with new key), (4) replaces old key in DB, (5)
  optionally removes old public key from target's `authorized_keys`.
- Atomic rotation: if any step fails, dashboard rolls back (old key
  remains in DB and on target).
- "View public key" button shows the public side for any active key
  (useful for operator manually copying to GitHub deploy keys).
- Key generation never returns the private key over the wire after
  initial save (private stays encrypted in DB).

### User Story 5 — Pre-flight VPS compatibility report before save (Priority: P2)

As an operator about to add a VPS, I want a comprehensive compatibility
check before save commits the row, so I learn upfront if the host has
issues that will bite me later.

**Acceptance**:

- After connection test (US1), Add Server form shows a "Compatibility
  Report" panel with checks:
  - SSH connection ✓/✗
  - Sudo non-interactive (`sudo -n true`) ✓/✗ — flags use_pty if `!`
  - Docker installed + version
  - Disk free (>= 5GB) ✓/⚠ (warn if < 10GB)
  - Swap configured ✓/⚠
  - OS family + version (Ubuntu 22.04+ ✓, others ⚠ or ✗)
  - Architecture (x86_64 ✓, ARM64 ⚠ flagging "some images may not have
    ARM variants")
- Each row: status icon + plain-language summary + (if warn/fail)
  one-click action ("Initialise this server will fix Docker missing").
- Save button enabled only when no `fail` rows. Operator must
  click-through warnings explicitly (per-row checkbox).

### User Story 6 — Cloud-provider awareness with hints (Priority: P3)

As an operator, I want the dashboard to detect which cloud provider hosts
my VPS (GCP, AWS, DigitalOcean, Hetzner, vanilla) and surface
provider-specific hints during onboarding (e.g. GCP needs `!use_pty`,
AWS Lightsail has restricted ports, Hetzner default image lacks
`python3-apt`).

**Acceptance**:

- During SSH connection test (US1), dashboard runs cloud-init metadata
  probes (curl `http://169.254.169.254/` with provider-specific
  headers/paths) and parses provider identity.
- Detection result populates a "Cloud provider: <name>" field in the
  compatibility report (US5).
- If provider has known quirks, hint banner shows: "GCP detected —
  Defaults `use_pty` blocks non-TTY sudo (incident 2026-05-02). The
  Initialise wizard will add `!use_pty` to your deploy user's sudoers."
- Per-provider quirks table maintained in code (not config — code review
  required for new provider entries).
- "Vanilla" (no metadata endpoint reachable) is acceptable — no hints
  shown, default initialise applies.

## Edge Cases

### US1 (Add server)

- **Operator pastes private key with passphrase**: dashboard rejects with
  "Passphrase-protected keys not supported in v1 — use unencrypted key
  or generate a fresh one via this dialog". (Encrypted private keys
  require passphrase prompting at every dispatch — out of scope.)
- **Generated keypair, but operator forgets to install pubkey on VPS**:
  connection test fails with "Public key authentication failed". Dialog
  shows the pubkey again with copy button.
- **Existing SSH known_hosts entry mismatches**: dashboard compares
  fingerprint and warns "host key changed since last connection — possible
  MITM or VPS reinstall. Confirm to update".
- **Wrong port** (firewall closed default 22, custom port): connection
  test times out. Form pre-fills port=22; operator changes if needed.

### US2 (Initialise blank VPS)

- **Re-initialise on already-set-up server**: setup-vps.sh idempotent
  per spec; UI surfaces per-step "skipping (already done)" lines from
  script stdout. No duplicate users, no duplicate firewall rules.
- **Initialise interrupted mid-flow**: server in partial state. Re-run
  Initialise picks up from last incomplete step.
- **Setup-vps.sh fails on apt update** (network, mirror down): script
  exits non-zero, file-tail modal shows error, operator can retry from
  apt step.
- **Operator chooses unusual deploy user name** (e.g. with spaces, special
  chars): wizard validates against `^[a-z][a-z0-9_-]{0,31}$` (POSIX
  username regex), rejects bad input.

### US3 (Env vars editor)

- **Repo has no `.env.example`**: "Import from .env.example" button
  hidden, operator adds vars manually.
- **Repo `.env.example` updated upstream after operator imported**: no
  automatic resync. Operator clicks Import again to see diff (new vars
  added to table, existing untouched).
- **Operator sets value containing `=` or newline**: stored verbatim
  (jsonb supports any string). Render-time escaping ensures `KEY=value`
  in `.env` is correct.
- **`.env.production` vs `.env`**: editor manages ONE env file —
  whichever the deploy script picks up first (stock script: `.env`
  preferred, `.env.production` second). Per-environment overrides are
  v2.
- **Operator hits "Save" with required CHANGE_ME values still set**:
  blocked with explicit "These look like placeholders" confirm dialog.

### US4 (SSH key rotation)

- **Rotation step 2 (install new pubkey) succeeds but step 3 (verify)
  fails**: rollback removes new pubkey from target. Old key still
  authoritative.
- **Operator rotates while a deploy is mid-run on the same server**:
  rotation deferred until deploy lock released (per feature 004).
- **Target's `authorized_keys` is read-only**: rotation step 2 fails
  with permission error. UI surfaces "target's deploy user cannot write
  to `~/.ssh/authorized_keys` — fix permissions or rotate manually".

### US5 (Pre-flight report)

- **Cloud-provider detection times out** (no metadata endpoint reachable):
  fall back to "vanilla", continue with rest of report.
- **Operator's network blocks outbound to VPS** (corporate firewall on
  laptop): connection test fails with "host unreachable". Hint to use
  bastion or VPN.
- **VPS has multiple public IPs**: connection uses operator's chosen
  one; report only checks that one.

### US6 (Cloud-provider hints)

- **Provider has unknown variant** (e.g. AWS Lightsail vs EC2): falls
  back to generic AWS hints. Operator can override detection if known
  inaccurate.
- **Operator on legitimate vanilla setup** (bare-metal, on-prem):
  detection returns "vanilla", no false-positive hints.

## Functional Requirements

### US1 — Add Server with SSH credential generation

- **FR-001**: Add Server form MUST support three auth modes: paste
  private key, paste root password (for initial setup only),
  auto-generate Ed25519 keypair.
- **FR-002**: When auto-generate is selected, dashboard MUST generate a
  fresh keypair on save and surface the public key in a copyable code
  block with installation instructions. Private key MUST be stored
  encrypted in DB and NEVER returned via any API after initial save.
- **FR-003**: After credential entry, dashboard MUST run an SSH
  connection test (`whoami && id && uname -a`) before persisting the
  server row. Failure blocks save.
- **FR-004**: Encrypted private key storage MUST use envelope encryption
  (per-row data encryption key wrapped by a master key from environment
  config). Plaintext only at SSH-dispatch time inside `sshPool`.
- **FR-005**: Connection test results MUST be displayed inline (server
  fingerprint, OS, arch, deploy user identity).

### US2 — Initialise blank VPS

- **FR-006**: Server detail view MUST detect "needs initialisation"
  state (no docker, no deploy user, no fail2ban). When detected, surface
  "Initialise" button prominently; hide for already-initialised
  servers.
- **FR-007**: Initialise wizard MUST be multi-step: (1) summary of
  changes, (2) configurable options, (3) typed-confirmation, (4) live
  progress via file-tail modal (reuse existing).
- **FR-008**: Configurable options MUST include: deploy user name
  (default `deploy`), swap size (default `2G`), ufw allowed ports
  (default `22, 80, 443`), `!use_pty` sudoers entry (default ON if
  cloud-provider detection per US6 indicates need).
- **FR-009**: Initialise MUST dispatch the existing
  `scripts/server/setup-vps.sh` via the runner. No new shell logic.
- **FR-010**: Re-running Initialise on partially-configured server MUST
  be idempotent. UI surfaces per-step "skipping" lines from script
  output.

### US3 — Per-app env vars editor

- **FR-011**: New table column `applications.env_vars_encrypted jsonb`
  MUST hold per-key envelope-encrypted secrets `{ key: { ciphertext, iv } }`.
  Existing `env_vars` column kept for backward-compat (already-stored
  plaintext migrated on first edit).
- **FR-012**: Edit Application form MUST surface env vars as a
  key-value table editor with per-row delete, value reveal/hide, and
  "generate secret" helper.
- **FR-013**: When repo has `.env.example` (detected by deploy
  pipeline), an "Import from .env.example" button MUST appear that
  parses the file and pre-fills the editor.
- **FR-014**: Save MUST encrypt each value individually before persistence.
  Decryption MUST occur only inside the deploy-dispatch path, never in
  audit logs, never in API responses.
- **FR-015**: Save MUST detect `CHANGE_ME_*` placeholder values and
  surface a confirm dialog before persistence.

### US4 — SSH key management UI

- **FR-016**: Settings → "SSH Keys" page MUST list all servers with
  their auth method, key fingerprint, and rotation timestamp.
- **FR-017**: "Rotate" action MUST execute atomically: generate new
  keypair → install on target → verify with new key → swap in DB →
  optionally remove old. Failure at any step rolls back to pre-rotation
  state.
- **FR-018**: Rotation MUST acquire the per-server deploy lock (feature
  004) so it never runs concurrently with a deploy.

### US5 — Pre-flight compatibility report

- **FR-019**: After successful connection test (FR-003), dashboard MUST
  run a comprehensive compatibility probe and render results as a
  labelled report.
- **FR-020**: Probe MUST include at minimum: SSH connection, sudo
  non-interactive capability (use_pty detection), docker presence +
  version, disk free, swap configured, OS family + version, architecture.
- **FR-021**: Each row MUST be labelled `pass` / `warn` / `fail` with
  plain-language summary and (when applicable) one-click remediation
  link (e.g. "Initialise will install docker").
- **FR-022**: Save MUST be blocked when any row is `fail`. `warn` rows
  require explicit per-row click-through.

### US6 — Cloud-provider detection + hints

- **FR-023**: During connection test (FR-003), dashboard MUST attempt
  cloud-init metadata probes for known providers (GCP, AWS, DigitalOcean,
  Hetzner). Detection failure falls back to "vanilla".
- **FR-024**: Provider detection result MUST surface in the compatibility
  report (US5). Per-provider known quirks MUST be displayed as hint
  banners with explicit description and remediation (typically auto-fixed
  by Initialise).
- **FR-025**: Provider quirks table MUST be code-defined (not config),
  requiring code review for additions. Initial entries: GCP (use_pty),
  AWS (sudo timeout), Hetzner (`python3-apt`).

### Cross-cutting

- **FR-026**: All actions MUST emit audit entries via existing
  `auditMiddleware` (feature 001). Specific actions: server.added,
  server.initialised, server.key_rotated, app.env_vars_changed.
- **FR-027**: All forms MUST validate input client-side (immediate
  feedback) AND server-side (defence-in-depth). Reject malformed
  hostnames, invalid SSH keys (not parseable), out-of-range numerics
  (port, swap size).

## Success Criteria

- **SC-001 (US1+US2)**: Operator onboards a fresh VPS from "I just
  rented this" to "I can deploy apps on it" in under 10 minutes,
  measured by time from "Add Server" click to first health probe green.
  Validated on first 5 production VPS additions post-rollout.
- **SC-002 (US3)**: 100% of new app deploys with secret env vars succeed
  on first try (no "missing .env" or "CHANGE_ME placeholder" failures
  in deploy logs over 30 days post-rollout).
- **SC-003 (US4)**: Operator can rotate SSH keys with zero perceived
  downtime — no failed deploys during rotation window in production.
- **SC-004 (US5)**: Pre-flight report catches 100% of compatibility
  issues before Add Server save (no "this server doesn't have docker"
  surprises in subsequent deploy attempts).
- **SC-005 (US6)**: GCP-hosted VPS additions never require operator to
  manually fix `use_pty` after initial setup (auto-applied via
  Initialise per detected provider hint).
- **SC-006**: Operator-survey question "How long did it take to onboard
  your latest VPS?" median response drops from current baseline (hours
  of terminal work) to under 15 minutes (UI-only).

## Key Entities

### `servers` (modified — new columns)

- `ssh_private_key_encrypted TEXT NULL` — replaces `ssh_private_key`
  (plaintext deprecated, migrated on first edit). Holds envelope-
  encrypted private key material.
- `ssh_key_fingerprint TEXT NULL` — SHA256 fingerprint of the active
  public key, surfaced in Settings → SSH Keys.
- `ssh_key_rotated_at TEXT NULL` — ISO timestamp of last rotation.
- `cloud_provider TEXT NULL` — detected provider identifier (`gcp`,
  `aws`, `do`, `hetzner`, `vanilla`).
- `setup_state TEXT NOT NULL DEFAULT 'unknown'` — one of `unknown`,
  `needs_initialisation`, `initialising`, `ready`. Drives "Initialise"
  button visibility.

### `applications` (modified — new column)

- `env_vars_encrypted JSONB NULL` — per-key envelope-encrypted secrets
  `{ key: { ciphertext, iv } }`. Plaintext `env_vars` column kept for
  backward-compat; migrated on first edit.

### `audit_entries` (existing — new event types)

- `server.added`, `server.initialised`, `server.key_rotated`,
  `app.env_vars_changed`, `app.env_vars_imported_from_example`.

## Assumptions

- A-001: All target VPSes run modern Linux with `systemd`, `apt` or
  `dnf`, and accept SSH on a configured port. Windows / BSD / non-systemd
  Linux distros are out of scope.
- A-002: A master encryption key is provided to dashboard via env var
  (e.g. `DASHBOARD_MASTER_KEY`) at boot. Loss of this key means loss of
  all encrypted secrets — operator's responsibility to back up.
- A-003: Operator has root or sudo access on the VPS at first add (to
  install deploy user + tooling). After Initialise, dashboard uses the
  deploy user only.
- A-004: GitHub deploy keys are managed by the operator manually (UI
  shows the generated public key, operator pastes into GitHub). Direct
  GitHub API integration for deploy-key install is out of scope (would
  require GitHub App or PAT with admin scope).
- A-005: Cloud-provider metadata probes use well-known endpoints. If a
  cloud provider rotates them, detection breaks gracefully (falls back to
  "vanilla").

## Dependencies

- **Feature 001** (devops-app): `servers` and `applications` schema,
  `auditMiddleware`, base UI shell.
- **Feature 002** (gh-integration): GitHub PAT storage pattern reused
  for env-var encryption envelope (same master-key approach).
- **Feature 004** (db-deploy-lock): SSH key rotation acquires per-server
  deploy lock to serialise vs deploys.
- **Feature 005** (script-runner): dispatch primitive for `setup-vps.sh`,
  secret-transport convention for env-var rendering at deploy time.
- **Feature 008** (domain-and-tls): pre-flight report pattern (DNS
  pre-check from FR-014) reused for compatibility report UX.
- **Feature 009** (bootstrap-deploy): wizard component pattern (state
  machine, multi-step, recovery) reused for Initialise wizard.
- **Existing scripts**: `setup-vps.sh`, `env-setup.sh`, `install-caddy.sh`,
  `health-check.sh` — execution layer; this feature wires them into UI.

## Out of Scope

- Cloud-provider API integration (creating VPSes via AWS/GCP API). Out
  of scope; operator provisions VPS externally.
- Kubernetes / non-Docker container hosts. Docker compose only.
- Multi-tenancy (operator A scoping resources from operator B). Out of
  scope; v1 is single-team dashboard.
- Backup / disaster recovery automation for the dashboard itself. Out
  of scope; operator-owned ops concern.
- Encrypted-at-rest secret rotation (changing master key). v2 — would
  require re-encrypting all rows.
- Per-environment env var overrides (e.g. `.env.staging` vs
  `.env.production`). v2 — current scope is single env file per app.
- GitHub App-based deploy-key auto-install. Out of scope; operator
  pastes pubkey manually.
- Hardware-key (YubiKey, etc) authentication for SSH. Out of scope.

## Related

- Spec 002 `/specs/002-gh-integration/spec.md`: PAT storage pattern.
- Spec 005 `/specs/005-universal-script-runner/spec.md`: dispatch +
  secret transport.
- Spec 008 `/specs/008-application-domain-and-tls/spec.md`: pre-flight
  report UX pattern (DNS pre-check).
- Spec 009 `/specs/009-bootstrap-deploy-from-repo/spec.md`: multi-step
  wizard pattern; clone-on-first-deploy that this feature complements.
- Spec 010 `/specs/010-operational-maturity/spec.md`: complementary
  spec for already-onboarded apps.
- Incident 2026-05-02: motivation document for this entire feature.
- Existing scripts in `scripts/server/` and `scripts/deploy/` — execution
  layer this feature wires into UI.
- CLAUDE.md rule 5 (no direct migrations): schema additions ship as
  reviewable SQL.

## Open Questions

- OQ-001 (US1): if operator pastes a private key that doesn't match any
  known auth method (SSH config has DSA disabled, etc), how does
  dashboard signal? Probably: SSH connection test fails with "auth
  rejected" — no special handling needed. Decide before plan.
- OQ-002 (US3): when `.env.example` updates upstream and operator clicks
  "Import" again, should the editor show a diff (new vars highlighted) or
  just merge? Diff better for review but more UI work. Defer to design.
- OQ-003 (US4): rotating a key while the dashboard's reconciler holds
  an SSH session — does new connection inherit new key automatically, or
  is there a window of dual-key validity? Implementation detail; defer
  to plan.
- OQ-004 (US5): "Pre-flight report" timing — run on every form change
  (debounced) or only on explicit "Test connection" button? UX vs cost
  trade-off; defer to design.
- OQ-005 (US6): provider-quirks table maintenance — first-party
  maintained or community-contributed? v1 first-party; v2 may open up.
