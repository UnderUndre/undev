# Security Review: Universal Script Runner

**Date**: 2026-04-22 | **Reviewer**: security-auditor (internal)

## Findings

| # | Area | Status | Notes |
|---|------|--------|-------|
| 1 | DB interaction (`scripts-runner.ts`, `routes/scripts.ts`, `routes/runs.ts`) | ✅ PASS | All writes/queries use drizzle-orm query builders — no raw SQL string interpolation. The one raw SQL (prune) is wrapped via `sql\`\`` tagged template with parameterised bindings. |
| 2 | Non-secret param quoting | ✅ PASS | `serialiseParams` funnels every non-secret value through `shQuote` before emitting into the stdin buffer. No second escape layer interprets quoted values. |
| 3 | Secret handling end-to-end (FR-016) | ✅ PASS | Three layers: (a) DB masking via `maskSecrets` before `script_runs` insert, (b) pino redact paths `*.params.*`, `*.body.params.*`, `SECRET_*`, (c) audit middleware applies `maskSecrets` for `/api/scripts/*/run` body capture. Transport via SSH stdin `export SECRET_*` lines — never argv, never env-prefix on the SSH command. |
| 4 | Manifest startup validation | ✅ PASS | Two-tier per R-009: strict validator for CI (throws on any failure), lenient runtime validator (annotates cache, throws only on duplicate id). Duplicate id is fatal — dashboard exits. Per-entry failures flag `valid: false` and surface as `400 INVALID_MANIFEST_ENTRY`. |
| 5 | Archived-script UX vs server gate | ✅ PASS | `archived` is read-side only on `/api/runs/:id`. The `POST /api/scripts/*/run` handler does NOT consult the archived flag — it only refuses based on `ScriptNotFoundError` (not in manifest) and `InvalidManifestEntryError` (flagged invalid at startup). No security regression from the cosmetic gate. |
| 6 | `dangerLevel: high` UX gate | ✅ NOTED | The UI requires the admin to type the script id before enabling the Run button for `dangerLevel: "high"` entries. This is UX, not a security boundary — the server trusts authenticated admin, matching the v1 admin-only auth model. |
| 7 | SSH command invariance | ✅ PASS | `executeWithStdin` always executes `bash -s -- <args>` with args = non-secret argv. Secrets never reach the SSH command string. An auditd `execve` watcher on the target would see the same boring command on every invocation. |
| 8 | AbortController timeout | ✅ PASS | `scripts-runner` wraps `executeWithStdin` in an AbortController with `manifest.timeout ?? 30min`. On abort, the ssh2 stream's `kill()` is called which sends SIGKILL + closes the channel. Combined with `ssh-pool`'s existing `keepaliveInterval: 30_000, keepaliveCountMax: 3`, the layered guard catches zombie streams (dropped TCP without FIN). |
| 9 | Strict request body schema on app create | ✅ PASS | `createAppSchema.strict()` rejects the deprecated `deployScript` field with `400 UNKNOWN_FIELD`. |
| 10 | Log-file ownership on prune | ✅ PASS | `pruneOldRuns()` deletes the script_runs row unconditionally but only `fs.unlink`s when `deployment_id IS NULL`. Deploy logs are owned by the `deployments` row (feature 001). |

## Residual exposure

- **`/proc/$$/environ` readable by same-uid**: documented in R-006. Mitigation is operational — run the dashboard's SSH user as a dedicated low-privilege account per target. Not blocked by code.

## Verdict

**PASS**. Feature 005 closes the argv-leak, DB-leak, log-leak, and audit-leak paths for secret parameters. Remaining risk is the `/proc/environ` same-uid read, which is the irreducible floor of SSH-based script execution and handled operationally.
