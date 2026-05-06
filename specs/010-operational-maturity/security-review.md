# Feature 010 — Security Review

**Date**: 2026-05-06 | **Reviewer**: Valera (T058 + T059)

## T058 — Hook execution paths

### Audit guarantees

- **`audit_entries.details` for `app.hooks_changed`** carries `addedHooks /
  removedHooks / changedHooks` arrays of relative path strings. **No script
  contents.** Verified at `server/routes/apps.ts` PUT handler — paths come
  from `validateHookFields` output only.
- **`script_runs.params`** for `deploy/server-deploy` records the params bundle
  (`appDir`, `branch`, `commit`, `noCache`, `skipCleanup`). The hook columns
  are surfaced as env-var exports (`PRE_DEPLOY_HOOK`, `POST_DEPLOY_HOOK`,
  `ON_FAIL_HOOK`) by the runner, NOT inserted into `script_runs.params`.
  Hook contents never leave the target host.
- **`audit_entries.details` for `app.hard_deleted_force_bypass`** carries
  `skippedHookPath` + `skipReason: "operator_force_bypass"`. No exit codes
  (because the hook never ran).

### Pino redact extension

No new redact paths needed — hooks never carry secrets in argv. The runner
calls `bash <hookPath>` with `APP_DIR` / `BRANCH` / `COMMIT` env exports
already covered by feature 005's serialiseParams. Existing `SECRET_*`
exports continue to redact via `BOOTSTRAP_REDACT_PATHS` from feature 009.

### Boundary

Hooks run on the target host as the deploy user. Their stdout/stderr
streams through the runner into `script_runs` log files — same retention
as deploy logs. If an operator's hook leaks secrets into stdout, that's
operator error, not framework leak. Documented behaviour: hook output
is operator-controlled.

## T059 — Migration toolkit

### Path-jail check

`migration-toolkit.adopt` resolves `remotePath` via SSH `readlink -f ||
realpath` and asserts the resolved path is rooted under one of the
server's `scan_roots`. Out-of-jail paths return 422
`target_path_jail_violation` BEFORE any DB write.

Without this check, adopting `/etc` then Hard Delete would `rm -rf` the
host's config directory. Suite covered by feature 009's
`tests/unit/path-jail.test.ts` (re-uses the same helper).

### SSH command construction

Every `sshPool.exec` call in `migration-toolkit.ts` uses `shQuote()` on
operator-supplied path strings:

- `test -d ${shQuote(remotePath)}` — line in adopt()
- `cd ${shQuote(remotePath)} && git config --get remote.origin.url`
- `readlink -f ${shQuote(remotePath)} || realpath ${shQuote(remotePath)}`
  (via `path-jail.resolveAndJailCheck`)

No raw string interpolation of operator input into SSH commands.

### PATCH-promote escalation guard

The PATCH-promote branch ONLY assigns `healthUrl`, `domain`,
`composePath`. Never `scriptPath`, never any hook column, never
`createdVia`. A scan-row cannot be turned into a hook-having row via
the migration endpoint — operator must use the regular PATCH flow with
its FR-013a mutual-exclusion guard.

### 409 path_already_managed leakage

The 409 response includes `existing.id`, `existing.name`,
`existing.createdVia`. These are not sensitive — they're on-server
resources the calling operator already has list access to (auth
required for the migrate endpoint per global `requireAuth`).

### Domain typed-confirm bypass surface

`validateDomainAttach` re-runs the cross-server check at write time
(GE-5). An operator who races the dialog can't bypass typed-confirm by
flipping a flag client-side — the server enforces the check at the
moment of the write.

## Audit event catalogue (T012, T060)

The existing `auditMiddleware` records `action` strings freely (no strict
allowlist). New event types (`app.hooks_changed`, `app.migrated_from_scan`,
`app.migrated`, `app.cross_server_domain_confirmed`,
`app.hard_deleted_force_bypass`) are emitted by direct `db.insert(auditEntries)`
calls in route handlers / services and round-trip cleanly through
`audit-query.ts`'s SELECT path. No catalogue enforcement to extend.

A future `boot-checks.ts` extension (T060) could enumerate expected event
strings and warn on unknown ones — left as v2 since no enforcement exists.
