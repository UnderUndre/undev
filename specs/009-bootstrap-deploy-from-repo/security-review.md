# Feature 009 — Security Review

**Date**: 2026-05-06 | **Reviewer**: Valera (T053–T055)

## T053 — PAT handling (FR-015..FR-017, FR-029)

Three-layer defence verified.

### Layer 1 — DB write-time masking

- `applications.repo_url` stores `https://github.com/{owner}/{repo}.git` — no
  token. Confirmed at `server/routes/bootstrap.ts:101` (`repoUrl =`).
- PAT is fetched fresh from `github_connection.token` at orchestrator
  dispatch time (`server/services/bootstrap-orchestrator.ts` `fetchPat`),
  never persisted on the row.

### Layer 2 — Manifest secret schema

- `bootstrap/clone` declares `pat: z.string().describe("secret")`
  (`server/scripts-manifest.ts`). Feature 005's `serialiseParams`
  routes `secret`-marked fields via env-var transport and `maskSecrets`
  replaces them with `"***"` before insert into `script_runs.params`.
  Verified by `tests/unit/serialise-params.test.ts` and existing
  `mask-secrets.test.ts`.

### Layer 3 — Heredoc on the target shell

- `scripts/bootstrap/clone.sh` reconstructs the URL via
  `https://oauth2:${SECRET_PAT}@…` inside the script body — argv stays
  PAT-free; `ps`/auditd see only `bash -s` and `git clone <auth-url>`,
  the auth URL exists in libcurl process memory only for the duration
  of the connect.

### Grep gates

```sh
# no PAT-shape strings allowed in DB params or audit details
psql -c "SELECT params FROM script_runs WHERE script_id LIKE 'bootstrap/%'" \
  | grep -E '(ghp|gho|ghu|ghs|ghr|github_pat)_'    # must return nothing
psql -c "SELECT details FROM audit_entries"        | grep -E ...
```

`server/lib/pat-redact.ts` exports `containsPatPattern` so an integration
test (T060) can assert the gate against a captured pino log stream.

### Findings

- ✅ No PAT in `applications` row.
- ✅ `script_runs.params.pat` masked to `"***"`.
- ✅ Pino redact paths cover `req.body.pat`, `params.pat`,
  `scriptRun.params.pat`, `auditEntry.details.pat`.
- ✅ Stderr scrubbed via `scrubPatFromText` before being written to event
  metadata in `bootstrap-orchestrator.runClone`.
- ⚠ Old `git` binaries (<2.32) may echo the auth URL on stderr. Mitigation:
  `scrubPatFromText` covers the URL pattern; orchestrator runs scrub
  before transition.

## T054 — Path-jail (FR-028)

Escape-attempt test suite landed at `tests/unit/path-jail.test.ts`:

| Attack | Test | Result |
|---|---|---|
| `apps/../../../etc` | "rejects parent traversal escape" | ✅ rejected |
| `apps/foo → /` symlink | "rejects symlink to /" | ✅ rejected |
| `/home/deploy/apps2` (suffix sneak) | "trailing-slash sneak" | ✅ rejected |
| readlink failure | "rejects when readlink returns nothing" | ✅ rejected |
| Empty path | "rejects empty remotePath" | ✅ rejected |
| Relative jailRoot | "rejects relative jail root" | ✅ rejected |
| BusyBox parity | `readlink -f || realpath` fallback | ✅ both probed |

`assertJailed` raises `PathJailEscapeError` on any escape; route layer
maps to 422 `JAIL_ESCAPE`. The `rm -rf` only fires inside
`scripts/bootstrap/hard-delete.sh` AFTER the script's own `realpath`
check (defence-in-depth on the target side).

## T055 — Injection vectors

| Vector | Defence |
|---|---|
| Slug regex (FR-027) | `validateSlug` enforces `^[a-z0-9]+(-[a-z0-9]+)*$`; forbidden chars list bans `\s/\\.;|&$()`<>"'?*`. Server-side validation in `routes/bootstrap.ts` POST + PATCH. |
| `composePath` shell metachars | `validate-compose-path.ts` enforces `^[\x20-\x7E]+$`, no `..`, no `\\`, no leading `/`, must end `.yml`/`.yaml`. Layered: Zod refine on POST (T014), Zod refine on PATCH (T031), runner-side TOCTOU re-check in orchestrator (T020). |
| `branch` regex | `^[a-zA-Z0-9._\-/]+$` consistent with feature 005 BRANCH_REGEX (manifest entry shares the constant). |
| GitHub `owner/repo` path-param | `^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$` on POST; `^[A-Za-z0-9._-]+$` per segment on the compose endpoint. |
| Raw SQL interpolation | All app queries via Drizzle; `0009_bootstrap.sql` is reviewable static SQL. The reconciler's recent-retry count uses `sql` template with parametrised binding for `app_id`; the `INTERVAL '1 hour'` literal uses `sql.raw` only on the constant `RETRY_WINDOW_HOURS`. |
| WS broadcast payload tampering | All WS payloads constructed from server-side state; client never echoes back into the broadcast. |
