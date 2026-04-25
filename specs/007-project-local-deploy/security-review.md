# Security Review: Project-Local Deploy Script Dispatch (Feature 007)

**Date**: 2026-04-25
**Reviewer**: security-auditor (T035)
**Scope**: three-layer defence (form → API → runtime), wrapper lifecycle, log/audit invariants, DB CHECK constraint.

---

## Checks

### 1. `validateScriptPath` is the single source of truth

**PASS.** Three call sites import from `server/lib/validate-script-path.ts`:

- `server/routes/apps.ts` — both POST and PUT route handlers, before insert/update.
- `server/scripts-manifest.ts` — Zod `.refine` on `deploy/project-local-deploy.params.scriptPath`.
- `client/lib/validate-script-path.ts` — byte-for-byte mirror; parity test (`tests/unit/validate-script-path-parity.test.ts`) enforces drift detection on the shared `FIXTURES` array.

`grep -r 'scriptPath' devops-app/server/` shows no other intake-side code path that mutates / persists `scriptPath` outside these layers.

### 2. Zod refine in manifest imports the same validator

**PASS.** `scripts-manifest.ts` line 25 imports `validateScriptPath` from `./lib/validate-script-path.js`; the refine reuses it directly. Re-validation on dispatch fires automatically because `scriptsRunner.runScript` calls `entry.params.parse(params)` before any side effect.

### 3. DB CHECK constraint present in deployed schema

**PASS.** Migration `0006_project_local_deploy.sql` adds:
`CHECK ("script_path" IS NULL OR LENGTH(TRIM("script_path")) > 0)`. Verified by static test `tests/integration/migration-0006-verification.test.ts`.

### 4. `shQuote` is the only argv-composition path

**PASS.** `buildProjectLocalCommand` is the only producer of the project-local command string; it routes every interpolation through `shQuote` (appDir, scriptPath, branch, commit). No string interpolation, no template literal that bypasses quoting.

### 5. No log/audit log-injection via failed-validation values

**PASS.** `dispatchProjectLocalDeploy` constructs `errorMessage` from `err.issues[0].message` (Zod's static error string — does not echo the input value) for ZodError, and from `err.message` for other errors (which are constructed without echoing user input). No raw `scriptPath` echoed into logs.

### 6. Rollback dialog cannot be bypassed via direct API call

**ACCEPTED LIMITATION (v1).** The dialog is a UX guardrail; the server's `POST /apps/:id/rollback` does not check `scriptPath`. Per spec § Out of Scope (rollback override field) and clarification Q1 Option B — operator agency is preserved. Future work could add a header opt-out or a server-side warning surface.

### 7. Pre-insert wrapper params field carries raw input

**PASS.** `script_runs.params` stores the raw pre-parse input (FR-014 — scriptPath is non-secret). The `mask-secrets` pipeline runs on the masked copy that the runner persists on its own update; the wrapper's pre-insert row carries the un-masked params, which is acceptable because (a) project-local has no secret fields, (b) the row is never read into a log/audit destination without going through the standard read paths that also mask.

### 8. Non-string input rejection at the route layer

**PASS.** Route schema uses `z.union([z.string(), z.null()]).optional()`. Tests `apps-script-path-normalisation.test.ts` cover `123`, `false`, `{}`, `[]` — all return 400.

---

## Findings

None blocking. Two follow-ups to consider for v2:

1. Server-side `scriptPath` echo in rollback API response, so an alternative UI (CLI, Telegram) can present an equivalent confirmation surface.
2. `shQuote` audit: enforce via lint rule that any `sshPool.execStream` call site uses `shQuote` for every interpolated value.
