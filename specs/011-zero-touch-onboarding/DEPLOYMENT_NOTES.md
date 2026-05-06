# Feature 011 — Deployment notes

## Required env var: `DASHBOARD_MASTER_KEY`

The dashboard envelope-encrypts SSH private keys, target root passwords,
per-app environment variables, and the Telegram bot token using
AES-256-GCM under a single master key. The key is read from the
`DASHBOARD_MASTER_KEY` env var at boot.

**Generate**:

```sh
openssl rand -base64 32
```

The decoded value MUST be exactly 32 random bytes; the cipher module
fails fast at boot if the var is missing, malformed base64, or the wrong
length.

## Operator checklist (one-time, before applying migration 0010)

1. Generate the master key as above and store it in your secrets
   manager (Vault / 1Password / similar).
2. Add `DASHBOARD_MASTER_KEY=<base64>` to the dashboard's environment
   (systemd unit, docker-compose, etc.) **before** the next start.
3. Apply migration `0010_zero_touch.sql` (`./scripts/prod-exec.sh sql
   < devops-app/server/db/migrations/0010_zero_touch.sql`).
4. Restart the dashboard. On first boot the boot-checks layer seals the
   string `"ok"` into `notification_settings.master_key_canary`. On
   every subsequent boot that canary is decrypted to verify the env-var
   key still matches the key used to seal existing secrets.

## Loss / rotation

Losing the master key is **irreversible** for any data sealed under it
(SSH private keys, target passwords, env vars, TG token). There is no
recovery path other than:

- restoring the correct key from your secrets manager, or
- wiping every encrypted column and re-onboarding from scratch.

A v2 master-key rotation flow is out of scope for this feature.

## Backups

Treat `DASHBOARD_MASTER_KEY` exactly like any other production secret:
multiple custodians, offline copy in a safe / sealed envelope, and a
documented break-glass restore procedure. **Never** commit it to git or
log it.
