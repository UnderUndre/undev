# Quickstart: Zero-Touch VPS Onboarding

**Date**: 2026-05-03 | **Branch**: `011-zero-touch-onboarding` | **Plan**: [plan.md](plan.md)

This is the operator-facing walkthrough — "I just rented a VPS, get me to
deployed app in under 10 minutes". Each step references the spec FR
that drives it.

**Pre-requisites** (one-time, dashboard-side):

1. `DASHBOARD_MASTER_KEY` env var set to a base64-encoded 32-byte secret.
   Example generation: `openssl rand -base64 32`. Loss of this key =
   loss of all encrypted secrets (A-002).
2. Dashboard upgraded past migration `0010_zero_touch.sql` (`npm run db:migrate`).
3. (Optional) Telegram bot registered via @BotFather and added to a
   channel/group with send permission. The bot token + chat ID will be
   configured through the dashboard UI — not env vars (Q3 clarification).

---

## Step 0 — Configure Telegram notifications (one-time, optional)

**Goal**: be told in TG when something fails.

1. Settings → Notifications → Telegram section.
2. Paste bot token (`12345:AAEi...`).
3. Paste chat ID (`-1002543210987` for a supergroup, or `@channelname`).
4. Click **Test connection** — you should see the test message land in
   your chat within ~2s. Banner "Telegram channel needs reconfiguration"
   disappears.
5. Settings → Notifications → Events: defaults are sensible (failures ON,
   security ON, success OFF). Toggle individual events as you taste.

If you skip Step 0: the dashboard works fully, but every notification is
silently dropped with an audit-log entry
(`notification.dropped.telegram_unconfigured`). You can configure later;
nothing breaks.

**Spec reference**: US7, FR-028..043.

---

## Step 1 — Add the new VPS

**Goal**: dashboard can SSH to your fresh VPS.

1. Servers → **Add Server**.
2. Fill `host`, `port`, `sshUser` (typically `root` for fresh VPS).
3. Choose auth mode:
   - **Paste existing key** if you have a managed SSH key fleet.
   - **Paste root password** if cloud provider gave you password access
     (one-time use — cleared after Initialise).
   - **Generate new keypair** if you want the dashboard to create one
     for you.
4. Click **Test connection**. Dashboard runs SSH `whoami && id && uname -a`,
   plus parallel cloud-provider probe and compatibility report.
5. Review the **Compatibility Report** — check what's pass/warn/fail:
   - `fail` rows block save.
   - `warn` rows require per-row click-through ("I understand").
6. (Generate-key mode only) Copy the surfaced public key and append it
   to the VPS's `~/.ssh/authorized_keys` for the user you specified —
   then re-test connection.
7. Click **Save**.

Dashboard creates the row and shows it in the Servers list with state
**needs initialisation** if Compatibility detected missing tooling, or
**ready** if everything was already in place.

**Spec reference**: US1, US5, US6, FR-001..005, FR-019..025.

---

## Step 2 — Initialise the VPS

**Goal**: deploy user, hardening, swap, ufw, fail2ban, docker — all
installed.

1. Server detail page → **Initialise this server** button (visible when
   `setup_state = needs_initialisation`).
2. Wizard step 1 — review what will be installed.
3. Wizard step 2 — configure options:
   - Deploy user name (default `deploy`)
   - Swap size (default `2G`)
   - UFW allowed ports (default `22, 80, 443`)
   - `!use_pty` toggle — default ON if cloud provider is GCP (incident
     2026-05-02 motivation), OFF otherwise.
4. Wizard step 3 — type `INITIALISE` to confirm.
5. Wizard step 4 — live progress streams from `setup-vps.sh`; same
   modal you've used for deploy logs (feature 009).
6. On completion, server flips to **ready**; first health probe runs
   automatically.

If something fails mid-flow: state reverts to `needs_initialisation`,
modal stays open with the error line highlighted, click **Retry** to
re-run from the failed step (script is idempotent per FR-010).

**Spec reference**: US2, FR-006..010.

---

## Step 3 — Deploy your app's secrets via the env-vars editor

**Goal**: stop SSHing to the host to edit `.env`.

1. Add your app via existing Bootstrap wizard (feature 009) — repo,
   compose path, branch, etc.
2. Once the app is in **active** state with the repo cloned: go to
   Application → **Edit** → **Environment variables**.
3. (Optional) Click **Import from .env.example** if your repo has one
   — populates the table with keys, flagging `CHANGE_ME_*` placeholders.
4. Edit values. Use the eye icon to reveal/hide. Use the dice icon next
   to a value to **generate a 32-byte hex secret** (client-side).
5. Click **Save**. If any `CHANGE_ME` placeholders remain, you'll get a
   confirm dialog — choose to fix or accept-as-is.
6. Trigger a deploy. Your env vars land on the target as `SECRET_*`
   exports per feature 005's secret-transport convention.

Decrypted values never leave the deploy-dispatch path: they're not in
audit logs, not in API responses, not in script_runs.params (FR-014).

**Spec reference**: US3, FR-011..015.

---

## Step 4 — Rotate SSH keys without losing access (occasional)

**Goal**: replace the dashboard's SSH key on a server without breaking
mid-deploy.

1. Settings → SSH Keys tab — see all servers + their key fingerprints +
   when last rotated.
2. Click **Rotate** on a row.
3. Type `ROTATE` to confirm.
4. Dashboard runs the 5-step atomic flow:
   1. Generate new keypair.
   2. Append new pubkey to target's `authorized_keys`.
   3. Open a fresh SSH session with the new key (verify).
   4. Swap encrypted key in DB.
   5. Remove old pubkey from target's `authorized_keys` (toggleable).
5. If any step 2-4 fails: rollback. Old key remains authoritative on
   target and in DB. Step 5 best-effort — failure logged but not rolled
   back (new key already proven working).

If a deploy is mid-run on the server: rotation queues until the deploy
lock releases (feature 004). No interleaving.

**Spec reference**: US4, FR-016..018.

---

## Verification — was the spec actually delivered?

Smoke checks that map to Success Criteria:

| SC | Check |
|---|---|
| SC-001 | Time `Add Server` click → first health probe green. Should be < 10 min on a fresh GCP/AWS/DO/Hetzner VPS. |
| SC-002 | Deploy an app with `.env.example` containing `JWT_SECRET=CHANGE_ME`. With placeholders unfixed, save dialog warns. With fixed values, deploy succeeds first try (no "missing .env" failure). |
| SC-003 | Trigger a deploy on server X. While it's running, click Rotate on the same server. Rotation queues; completes after deploy. No deploy failure observed. |
| SC-004 | Try to add a server with docker missing. Compatibility row shows fail; Save button disabled. |
| SC-005 | Add a GCP-hosted VPS. Compatibility shows "GCP detected — `use_pty` quirk". Initialise wizard's `useNoPty` defaults to ON. After Initialise, run a deploy that uses sudo non-interactively — succeeds. |
| SC-007 | From a fresh dashboard install with no env vars: configure Telegram from Settings UI, click Test connection — succeeds in < 2 min total. |
| SC-008 | After 30 days production usage: tail `audit_entries` for `notification.dropped.throttled` (proves cooldown fires) AND zero `notification.dropped.delivery_failed` for `*.failed` events older than 1h (proves critical signal isn't lost). |

---

## Troubleshooting

### "Generate new keypair" succeeds but connection test fails

Public key was generated but not yet installed on target.
The dialog should re-show the pubkey with a copy button — paste it into
the target's `~/.ssh/authorized_keys` for the user specified, then click
Test connection again.

### Compatibility report shows "use_pty: set" warning on GCP

Default GCP image enforces `Defaults use_pty` in sudoers — this blocks
non-TTY sudo (incident 2026-05-02). Initialise wizard's `useNoPty: true`
(default for GCP) adds `!use_pty` for the deploy user. After Initialise,
the warn row clears.

### `.env.example` import button is missing

Visible only after the repo is cloned to the target (post-Bootstrap, app
in `active` state). Pre-clone, the dashboard can't read the file.

### Test connection returns "Forbidden: bot was kicked from the chat"

403 permanent error. Either re-add the bot to your chat, or paste a
different chat ID and re-test. Banner persists until a Test connection
returns OK.

### Audit log shows `notification.dropped.throttled` for healthcheck.degraded

Per-pair cooldown fired (5 min). Either: (a) the next healthcheck.degraded
event will include "(N similar events suppressed)" suffix and deliver, or
(b) if you want every event delivered, this requires v2 (cooldown is
hardcoded). Workaround: investigate *why* the app is flapping; the
notification system is doing its job by not paging you 100x.

### Initialise wizard hangs on "apt-get update"

Usually a slow apt mirror. Wait — script timeout is 20 minutes. If it
genuinely hangs past timeout, retry from the failed step (script is
idempotent).

### Master key missing — dashboard refuses to start

Set `DASHBOARD_MASTER_KEY` env var to base64-encoded 32 bytes:
`openssl rand -base64 32`. **Save this key somewhere safe** — losing it
means losing all encrypted secrets in the DB.

---

## What's NOT covered by this feature

Per spec Out of Scope:

- Provisioning VPSes via cloud-provider APIs (you bring your own VPS).
- Kubernetes / non-Docker hosts.
- Multi-tenancy (single-team dashboard).
- Master encryption key rotation (would require re-sealing every blob).
- `.env.staging` vs `.env.production` per-environment overrides.
- GitHub deploy-key auto-install via GitHub App.
- YubiKey / hardware-key SSH auth.
- Multi-channel notifications (email, Slack, webhook). v1 is TG only.
- Per-user TG DM routing. v1 is shared channel only.
- User-tunable throttling parameters (cooldown, bucket size). Hardcoded
  in v1.
- Persistent retry queue for failed TG deliveries. Audit log is the
  forensic trail.

These are deliberate v1 boundaries. Most have spec'd v2 paths.
