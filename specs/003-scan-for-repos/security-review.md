# Security Review: Scan Server for Existing Repositories and Docker Apps

**Reviewer**: Valera (internal audit) | **Date**: 2026-04-20 | **Scope**: feature 003 implementation.

## Files audited

- `server/services/scanner-command.ts` — shell pipeline builder
- `server/services/scanner-parser.ts` — output parser
- `server/services/scanner-dedup.ts` — path normalisation
- `server/services/scanner.ts` — orchestrator + lock
- `server/services/deploy-command.ts` — deploy dispatch
- `server/routes/scan.ts` — HTTP route
- `server/routes/servers.ts` — `scanRoots` write validation
- `server/routes/apps.ts` — `source=scan` + `skipInitialClone` write-side

## Findings

### ✅ A1 — Shell injection in scan pipeline (FR-063)

- All user-supplied roots pass through `validateRoots()` in `scanner-command.ts:25-46`:
  - Absolute path check (`^/`)
  - ≤ 512 chars length cap
  - `/["'`;&|<>()\\\n]/` metacharacter rejection — includes single-quote
  - ≤ 20 entries cap
- Roots that pass are single-quoted via `shellQuote()` with POSIX `'` → `'\''` escape.
- Because single-quotes are rejected at validation time, the escape function is effectively only defence-in-depth.

**Verdict**: No injection path from `scanRoots` to remote shell.

### ✅ A2 — Shell injection in per-candidate `git -C` paths

- `find` emits worktree paths on stdout which are then read into `$path`/`$worktree` bash variables inside the pipeline.
- `$worktree` is always passed to `git -C` with **double-quoted** expansion (`git -C "$worktree"`), which preserves all characters and does not trigger re-interpretation.
- Filenames with embedded newlines would split into multiple iterations of the `while read` loop (per standard shell behaviour). The candidate with an embedded newline would produce malformed tagged output, which the parser discards as "unknown tag / truncated". **Not exploitable** — attacker-controlled `.git` path names can't escape into shell execution.

**Verdict**: Safe.

### ✅ A3 — Deploy-command shell injection (FR-041, FR-052)

- `deploy-command.ts:buildDeployCommand()` single-quotes `remotePath`, `branch`, and `commit` via `shQuote()`.
- Upstream constraints:
  - `remotePath` canonicalised via `normalisePath()` on write (no quote chars possible through the API path; `/` and alphanumerics + `._-` are common).
  - `branch` validated in `deployments.ts:20` with regex `^[a-zA-Z0-9._\-/]+$` — no shell metacharacters.
  - `commit` validated with regex `^[0-9a-f]{7,40}$`.
- `deployScript` is the one free-form field. It IS executed as a shell snippet in `scan-git` / `scan-docker` modes. **This is by design** — FR-053 explicitly treats `deployScript` as a shell command for Docker-only imports (e.g. `docker compose up -d`). The admin is the only writer of this field; the UI offers it as a plain input, and it is surfaced for review before save.

**Verdict**: Safe for all fields backend controls. `deployScript` is admin-trusted (same threat model as `scriptsPath` in v0.1).

### ✅ A4 — `scanRoots` Unicode / normalisation bypass

- `z.string().regex(/^\//)` operates on the exact UTF-16 code units of the input; RFC 3987 Unicode look-alikes (fullwidth solidus `／` U+FF0F) do NOT match.
- `.max(512)` counts UTF-16 code units (JavaScript string length), not bytes — an attacker cannot sneak through a 511-char string that serialises to 1024+ bytes and then get truncated server-side (Postgres jsonb preserves UTF-8 faithfully).
- The metacharacter regex is applied to the raw string post-regex narrowing — no code-point aliasing concern in the matched set (all metacharacters are ASCII).

**Verdict**: Safe.

### ✅ A5 — `skipInitialClone` forgery

- Client can send `{ "source": "scan", "skipInitialClone": false }` or `{ "source": "manual", "skipInitialClone": true }` — both are ignored.
- Backend at `routes/apps.ts:56` derives the flag solely from `source === "scan"`. Payload field is destructured into an unused variable pattern.

**Verdict**: Client cannot forge. Only scan imports set the flag.

### ✅ A6 — `docker://` prefix spoofing

- A malicious actor could in principle add an application manually with `repoUrl = "docker://../../../etc/passwd"` to trigger `scan-docker` deploy mode, which skips git ops.
- However, `scan-docker` mode only runs `cd '<remotePath>' && <deployScript>`. There is no git operation to subvert. The only effect is that an admin-owned `deployScript` is executed at an admin-owned `remotePath` — the admin already controls both fields through the same UI. **No escalation.**

**Verdict**: No privilege escalation.

### ⚠️ A7 — Audit log gap for scan imports (FR-051 details)

- `auditMiddleware` captures method + path + status + duration but not the request body. A scan-imported app is audited as `post.servers.:id.apps` with no visible `source: "scan"` marker in the `details` column.
- The effect (`skipInitialClone = true`) is queryable from the `applications` table itself, so forensic investigation works.
- **Recommendation**: None blocking. If richer audit is wanted later, extend middleware to whitelist the `source` field into details.

**Verdict**: Low. Documented as acceptable risk in tasks.md.

### ⚠️ A8 — NFS-guard (FR-073) deferred

- Task T009 specs a `stat -f -c %T` probe for scanRoots on write. Implementation elided in this pass because server route CREATE flow doesn't yet have an active SSH connection at the validation point — the probe would require opening an SSH session just for FS-type check.
- Current mitigation: server-side `timeout --kill-after=5s 60 bash -c` (FR-062 primary defence) still bounds the scan. A dead NFS mount causes partial results + timeout, not a permanent hang of the dashboard process.
- **Recommendation**: Follow-up ticket to wire the probe once connection upgrade happens during CREATE (e.g. hook into the existing `POST /api/servers/:id/verify` flow).

**Verdict**: Medium. `timeout` wrapper covers the worst case (runtime hang); NFS reject is UX hardening.

### ✅ A9a — Client-abort propagation (SC-003 fix)

- Initial cut only set a `clientAborted` flag on `req.on("close")` — the scan kept running on the server for up to 60s (caught by @gemini-code-assist on PR #6).
- Fixed in `server/routes/scan.ts`: on socket close the route now calls `getActiveScan(serverId)?.abort()`, which invokes `kill()` on the SSH stream handle stored by `scanner.ts`. The remote `timeout --kill-after=5s 60 bash -c` wrapper exits within the SSH channel teardown budget (~2s, per SC-003).

**Verdict**: Safe.

### ✅ A9 — Concurrency lock (FR-074) soundness

- `locks` is a module-scoped `Map`; entry is set synchronously before any `await`, so no TOCTOU between check and set within one Node event loop tick.
- Entry is deleted in `finally`, guaranteed to run on success/error/throw.
- `__resetScanLocks()` exposed for tests — **must not** be exported from the server index or wired to any HTTP route. Verified: no references outside tests.

**Verdict**: Safe.

### ✅ A10 — Unbounded stdout buffer in scanner

- Pipeline output is accumulated into an in-memory `stdout` string (`scanner.ts:201`) with no size cap.
- Worst case on a legitimate host: ~200 candidates × ~8 lines × 150 chars = ~240 KB. Well bounded.
- Malicious server (compromised host) could emit GB of data to exhaust dashboard RAM. Out of scope — threat model assumes the server is under the same admin's control.

**Verdict**: Low. Future hardening: streaming parse + cap at e.g. 10 MB.

### ✅ A11 — PATH trap in scan-{git,docker} deploy invocation

- **Original bug (caught on PR #6 by @gemini-code-assist)**: `cd <remotePath> && deploy.sh` fails with `command not found` because the cwd is not on `$PATH`. Classic mode doesn't hit this because it uses `bash <remotePath>/<script>` (absolute path).
- **Fix**: `normaliseScriptInvocation()` in `deploy-command.ts` prefixes bare filenames (`deploy.sh` → `./deploy.sh`) while leaving absolute paths, explicit relative paths (`./foo`), and command pipelines (`docker compose up -d`, `make deploy`, etc.) untouched. Well-known binary names (`docker`, `npm`, `pm2`, `make`, …) are recognised even without arguments.
- Covered by 7 new unit tests in `deploy-command.test.ts`.

**Verdict**: Safe.

### ⚠️ A12 — Dirty working tree + `reset --hard FETCH_HEAD` wipe (UX)

- First deploy after a scan import runs `git reset --hard FETCH_HEAD` on an already-populated working tree. If the tree was dirty (admin edited files directly on the server) or status couldn't be determined (`dirty: "unknown"`), those local edits are silently discarded.
- **Mitigation**: Import button in `GitCandidateRow` now shows a `window.confirm()` when `dirty === "dirty"` or `"unknown"`, spelling out that tracked-file modifications will be discarded on first deploy. Untracked files (including the `SCAN_IMPORT_SENTINEL` in the quickstart verification recipe) survive.
- Out of scope for v1: three-way merge, stash-on-deploy, or `--merge` instead of `--hard`. Those change the FR-052 "nuke-and-sync" contract the feature is built around.

**Verdict**: Accepted with UI guard.

### ⚠️ A13 — Multiple independent compose stacks in one directory (FR-031 edge case)

- Scanner groups all compose files in a directory into a single candidate (primary + extras as additional `-f` flags). Correctly handles the common "prod + override" layout.
- **Edge case**: Two *independent* stacks in the same directory (very rare) collapse into one candidate. The second is not separately importable.
- Mitigation: admins move one stack into a subdirectory, or skip the scan flow and add manually.

**Verdict**: Decision log — accepted for v1.

### ⚠️ A14 — Docker < 20.10 → `dockerAvailable: false`

- `docker ps --format '{{json .}}'` and `docker compose config --format json` both require Docker Engine 20.10+ (GA Dec 2020).
- Older hosts: scanner reports `dockerAvailable: false` rather than crashing. Admins see the "docker not available on host" hint.
- Legacy-binary (`docker-compose` hyphenated) support is out of scope.

**Verdict**: Decision log — documented in `quickstart.md`.

## Summary

| ID | Severity | Status |
|---|---|---|
| A1 | — | ✅ Safe |
| A2 | — | ✅ Safe |
| A3 | — | ✅ Safe |
| A4 | — | ✅ Safe |
| A5 | — | ✅ Safe |
| A6 | — | ✅ Safe |
| A7 | LOW | ⚠️ Accept |
| A8 | MEDIUM | ⚠️ Follow-up |
| A9a | — | ✅ Fixed on PR #6 |
| A9 | — | ✅ Safe |
| A10 | LOW | ⚠️ Accept |
| A11 | — | ✅ Fixed on PR #6 |
| A12 | LOW | ⚠️ UI guard |
| A13 | LOW | ⚠️ Decision log |
| A14 | LOW | ⚠️ Docs |

No blockers. One open follow-up (A8: NFS-guard wiring).
