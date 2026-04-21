# Research: Universal Script Runner

**Phase 0 output** | **Date**: 2026-04-22

---

## R-001: Docker build context — how to bundle `scripts/` into the image

**Decision**: Move the Docker build context one level up (repo root) and change the Dockerfile path accordingly.

- **Before**: `docker-compose.yml` has `build: .` (implying context = `devops-app/`). `scripts/` lives at the repo root — **outside** the build context — and `COPY . .` in the Dockerfile cannot reach it.
- **After**: `docker-compose.yml` has
  ```yaml
  build:
    context: ..
    dockerfile: devops-app/Dockerfile
  ```
  Dockerfile adjusts its `COPY` paths: `COPY devops-app/package.json devops-app/package-lock.json ./` in stage 1, `COPY devops-app/ .` in stage 2, `COPY scripts ./scripts` in the production stage.
- **`.dockerignore`** (at repo root, NEW file): excludes `node_modules/`, `dist/`, `.git/`, `specs/`, `.claude/`, `.github/`, `.gemini/`, `.remember/`, `tmp/`, `**/*.log`, `data/`, `tests/`, `*.md` at root. Note the existing `devops-app/.dockerignore` becomes redundant-but-harmless; we keep it for now.

**Rationale**: Adding a single 10-file `scripts/` tree is cheap. Trying to keep context inside `devops-app/` would require either a pre-build symlink hack (fragile on Windows), a copy step outside Docker (breaks `docker-compose build` as the single source of truth), or docker buildx `--contextdir` (non-portable). Moving context up is the only change that keeps the `docker-compose up --build` contract intact.

**Alternatives considered**:
- **Symlink `devops-app/scripts -> ../scripts`**: Windows support is painful; `git` tracks the symlink, not the contents; `.dockerignore` may or may not follow it across OSes.
- **Pre-build copy step in `npm run build` or a shell script**: Breaks the one-command build invariant; developers forget to re-run it.
- **Serve scripts from a sidecar volume at runtime**: Violates FR-012 "version lock between dashboard and scripts".

---

## R-002: Transport mechanism — piping bash over SSH with stdin

**Decision**: Use `ssh2`'s `ClientChannel.write(buffer); channel.end()` to pipe the concatenated script into `bash -s` on the remote.

- The existing `ssh-pool.execStream(serverId, command)` calls `client.exec(command, cb)`. ssh2's `ClientChannel` is a `Duplex` stream — we can write to its stdin.
- To extend, add a new `execStreamWithStdin(serverId, command, stdin: string | Buffer)` method (or pass `stdin` as an option) that writes `stdin` to `stream` immediately after `exec` returns, then calls `stream.end()` to close stdin. Stdout/stderr continue to stream as before.
- Command-shape on remote:
  ```text
  env SECRET_X='...' YES=true CI=true bash -s -- --flag1='val1' --flag2='val2'
  ```
  with the concatenated `common.sh + target.sh` written into the channel's stdin.

**Rationale**: ssh2's underlying protocol already supports stdin; `exec` + `stream.write` is a documented usage. Zero new deps, zero new binaries on target, zero target-side state.

**Verification needed in Phase 1**: write a small script in a test to confirm ssh2's ClientChannel behaves as a Writable stream. Confirmed via ssh2 docs (section "Client events → exec"): "Data events on the stream are for stdout; writes to the stream are stdin."

**Alternatives considered**:
- **Here-docs inline in command string** (`bash -c "cat <<'EOF'\n... script ...\nEOF | bash"`): works but quoting nightmare, exceeds sh line-length on large scripts, log-polluting.
- **`scp` then `ssh ... bash /tmp/...`**: two round-trips, server-side state violates FR-012.
- **A new bash binary on target that pulls from an HTTP endpoint**: over-engineering.

---

## R-003: common.sh concatenation — bash function override (revised 2026-04-22)

**Decision**: Do NOT strip the target script's `source` line. Instead, inject a shell preamble that overrides the `source` and `.` builtins with a function that no-ops for `common.sh` and delegates everything else via `builtin source "$@"`. Then concatenate the full `common.sh` and the full target script. Whatever syntactic form the target uses to source `common.sh`, bash resolves it through the overridden function and does nothing.

**Why the regex approach was wrong**: the canonical pattern `source "$(dirname "$0")/common.sh"` was assumed, but bash has at least five equivalent forms:
- `source "$(dirname "$0")/common.sh"` (current convention)
- `. "$(dirname "$0")/common.sh"` (POSIX shorthand)
- `source ./common.sh` (relative)
- `SRC="$(dirname "$0")"; source "$SRC/common.sh"` (variable interpolation)
- `. ${BASH_SOURCE%/*}/common.sh` (advanced substitution)

A regex that handles all of them is brittle; a regex that handles only the canonical form silently breaks every variant the moment someone touches a script.

The transported buffer layout (ordered lines):

```bash
# [1] Preamble — injected by the runner
export YES=true
export CI=true
export SECRET_S3_KEY='<shQuoted>'    # per FR-016, one per secret param
export SECRET_WEBHOOK='<shQuoted>'

# Intercept common.sh sourcing regardless of form
source() {
  case "$1" in
    */common.sh|common.sh) return 0 ;;
    *) builtin source "$@" ;;
  esac
}
.() {
  case "$1" in
    */common.sh|common.sh) return 0 ;;
    *) builtin . "$@" ;;
  esac
}

# [2] The real common.sh, inlined once (shebang stripped)
<contents of scripts/common.sh>

# --- end common.sh ---

# [3] The target script (shebang stripped, NOT otherwise modified)
<contents of scripts/<category>/<name>.sh>
```

**Rationale**: The override + full-inline approach has three properties the regex approach did not:
1. **Form-agnostic**: catches every present and future syntactic variant because bash dispatches all of them through the function name `source` / `.`.
2. **No parsing of bash source code**: we never tokenise, line-match, or regex over bash — we just concatenate bytes and let bash itself decide at runtime.
3. **Idempotent**: if a script sources `common.sh` twice, both calls no-op. If it sources something else, it still works (`builtin source "$@"` delegates).

**Alternatives considered**:
- **Regex-strip (original decision)**: fragile as enumerated above. **Rejected 2026-04-22** after Gemini review.
- **Build-time inline (vite plugin)**: couples build pipeline to scripts conventions, harder to debug.
- **Refactor all scripts to not use `common.sh`**: destroys DRY, forbidden by spec.

---

## R-004: Parameter serialisation — `shQuote` extraction

**Decision**: Extract `shQuote` from `deploy-command.ts` into a shared module `server/lib/sh-quote.ts`, re-export from both old site and the new runner. Zero behaviour change for deploy, single source of truth.

- Old call site in `deploy-command.ts:shQuote` → replaced by `import { shQuote } from "../lib/sh-quote.js"`.
- Same-file private helper `script-runner.ts:escape` (the one on line 33) also replaced by the shared import.

**Boolean / number / array / null handling** per FR-011:

```ts
function serialiseParams(schema: z.ZodObject<any>, values: Record<string, unknown>): { args: string[]; env: Record<string, string> } {
  const args: string[] = [];
  const env: Record<string, string> = {};
  for (const [key, val] of Object.entries(values)) {
    if (val === null || val === undefined) continue;
    const field = schema.shape[key];
    const kebab = toKebabCase(key);
    const isSecret = field?._def?.description === "secret";
    if (isSecret) {
      env[`SECRET_${toUpperSnake(key)}`] = String(val);
      continue;
    }
    if (typeof val === "boolean") {
      if (val) args.push(`--${kebab}`);
      continue;
    }
    if (Array.isArray(val)) {
      for (const v of val) args.push(`--${kebab}=${shQuote(String(v))}`);
      continue;
    }
    args.push(`--${kebab}=${shQuote(String(val))}`);
  }
  return { args, env };
}
```

**Rationale**: Keeps FR-011 contract testable as a pure function. Unit tests cover: string, number, boolean (true/false), array, null/undefined, embedded single quotes, empty string, secret routing.

---

## R-005: Zod schema → UI form generator

**Decision**: Server exposes the Zod schema of each manifest entry as a JSON descriptor at `GET /api/scripts/manifest`. Client consumes the descriptor and renders the form. No `zod-to-json-schema` dependency (pure in-house descriptor extraction).

Descriptor shape:

```ts
interface FieldDescriptor {
  name: string;                                // kebab-case
  type: "string" | "number" | "boolean" | "enum";
  required: boolean;
  default?: unknown;
  enumValues?: string[];                       // when type=enum
  isSecret: boolean;                           // derived from .describe("secret")
  description?: string;                        // pulled from .describe() if not "secret"
}
interface ManifestDescriptor {
  id: string;
  category: "deploy" | "db" | "docker" | "monitoring" | "server-ops";
  description: string;
  locus: "target" | "local" | "bootstrap";
  requiresLock: boolean;
  timeout?: number;
  dangerLevel?: "low" | "medium" | "high";
  outputArtifact?: { type: string; captureFrom: string };
  fields: FieldDescriptor[];
}
```

Extraction: walk `schema.shape`, inspect each Zod type via the `_def` accessor (`ZodString`, `ZodNumber`, `ZodBoolean`, `ZodEnum`, `ZodOptional`, `ZodDefault`). Zod 4's internal `_def` access is stable enough for this purpose (already used this way by many OSS projects). Validation on submit uses the real Zod schema server-side — the descriptor is a presentation hint, not a security boundary.

**Rationale**: `zod-to-json-schema` would add a dep and emit draft-07 JSON Schema, which we'd then have to map to form controls anyway. An in-house descriptor is ~60 lines and exactly fits our controls.

**Alternatives considered**:
- **`@hookform/resolvers` + JSON Schema**: heavier client-side, still need a server-side emitter.
- **Hand-written form per manifest entry**: defeats the point of FR-031.

---

## R-006: `script_runs.params` storage shape and secret transport/redaction layering (revised 2026-04-22)

**Decision**: Three layers that together close the leak paths:

1. **DB write-time masking**: params are stored after a `maskSecrets` transform, never as the raw request body.

   ```ts
   function maskSecrets(schema: z.ZodObject<any>, values: Record<string, unknown>): Record<string, unknown> {
     const out = { ...values };
     for (const [k, v] of Object.entries(values)) {
       const field = schema.shape[k];
       if (field?._def?.description === "secret") out[k] = "***";
     }
     return out;
   }
   ```

   - `script_runs.params` ← `maskSecrets(schema, values)`
   - `auditMiddleware` body-capture ← `maskSecrets(schema, body)` (via a middleware extension that manifest-looks-up the field list for routes matching `/api/scripts/*/run`).
   - `logger.ts` pino redact paths extended: `scriptRun.params.*`, `req.body.params.*`.

2. **Stdin transport (NOT argv)**: secrets are NEVER passed on the SSH command line. The runner emits `export SECRET_<NAME>='<shQuoted>'` lines INSIDE the bash buffer that is piped into `bash -s` on the remote. The SSH invocation itself is invariant — literally `bash -s` with no envs, no env-prefixing — so an `sshd_config` with `LogLevel VERBOSE` and a Linux `auditd -a always,exit -S execve` rule both see the same boring command on every run and never see secret values. The secret bytes travel INSIDE the encrypted SSH data channel as part of the script text.

3. **Remote process scope**: once executed, `export SECRET_FOO=...` places the value in the bash process's environ, which is readable via `/proc/$$/environ` by the same user but NOT by sshd or auditd. This is the irreducible residual exposure — readable-by-same-uid. Mitigated operationally by running the dashboard's SSH user as a dedicated low-privilege account per target.

**Rationale**: Defence-in-depth with three boundary layers (DB, log, transport). A regression in any one layer doesn't expose the secret in the other two. The critical change from the original decision is that argv transport was never safe — `env VAR='...' bash -s` in the SSH command leaks on auditd/VERBOSE. Stdin transport closes that path.

**Threat model enumeration** (what each layer blocks):

| Exposure path | Blocked by |
|---|---|
| `SELECT * FROM script_runs` dump | Layer 1 (DB masking) |
| Pino log scrape | Layer 1 (pino redact) + Layer 2 (never in argv) |
| `audit_entries` query | Layer 1 (audit middleware masking) |
| `ps auxwww` on target | Layer 2 (never in argv) |
| Target `auth.log` / `auditd execve` | Layer 2 (stdin transport) |
| `/proc/$$/environ` same-user | Not blocked — operational mitigation required (dedicated SSH user) |
| DB-dump leak of a decrypt-at-rest deployment | Layer 1 (masked bytes on disk) |

**Alternatives considered**:
- **Argv with `env VAR='...' bash -s`** (original decision): leaks on VERBOSE sshd and auditd execve. **Rejected 2026-04-22** after Gemini review.
- **DB-level redaction trigger**: over-engineered for a single column.
- **Encryption-at-rest with key rotation**: solves DB-dump leak only, doesn't help with logs or remote audit; deferred.

---

## R-007: `resolveDeployOperation(app)` dispatch logic + migration of existing rows

**Decision**: Pure function keyed off three fields on `applications`:

```ts
export function resolveDeployOperation(app: {
  source: "manual" | "scan";
  repoUrl: string;
  skipInitialClone: boolean;
  remotePath: string;
  branch: string;
}, runParams: { commit?: string }): { scriptId: string; params: Record<string, unknown> } {
  const isDockerOnly = app.repoUrl.startsWith("docker://");
  if (app.skipInitialClone && isDockerOnly) {
    return {
      scriptId: "deploy/deploy-docker",
      params: { remotePath: app.remotePath, branch: app.branch, commit: runParams.commit },
    };
  }
  // classic git OR scan-git (same underlying script; skipInitialClone is a flag)
  return {
    scriptId: "deploy/deploy",
    params: {
      remotePath: app.remotePath,
      branch: app.branch,
      commit: runParams.commit,
      skipInitialClone: app.skipInitialClone,
    },
  };
}
```

The existing `scripts/deploy/deploy.sh` is the classic-git path; we audit it and, if needed, extend its CLI to accept `--skip-initial-clone` (matching the scan-git `buildDeployCommand` behaviour today). A new `scripts/deploy/deploy-docker.sh` wraps the current `scan-docker` inline `cd <remotePath> && <deployScript>` as a standalone script — its logic is `cd $REMOTE_PATH && bash ./deploy.sh` (or whatever convention we settle on during A-005 pre-migration validation).

**Pre-migration validation** (A-005): a one-shot script `scripts/db/pre-migration-005-audit.sh` runs against production and emits the unique set of `applications.deploy_script` values plus a coverage report: "N apps would dispatch to deploy/deploy, M apps would dispatch to deploy/deploy-docker, K apps don't match any known pattern". If K > 0, the admin reviews and either adjusts the source data or adds a new dispatch rule before running the 0005 migration.

**Rationale**: Resolves at runtime from fields already on the `applications` row — no new column, no enum, no code branch for "legacy apps". The mapping is discoverable from the code.

**Alternatives considered**:
- **Add `applications.flavour` enum column**: redundant — flavour is already derivable.
- **Fallback runtime behaviour for unknown patterns**: hides bugs; better to fail pre-migration.

---

## R-008: Job lifecycle integration — runner → jobManager → WS

**Decision**: Extend `jobManager.createJob` with a `script_run_id` link field; write the `script_runs` row first, pass its id into jobManager, and have the existing onJobEvent-driven status updates ALSO update `script_runs.status`. Deploy runs dual-write the existing `deployments` row AND a new `script_runs` row, linked via `script_runs.deployment_id` FK.

- `scriptsRunner.runScript` is the new public entrypoint.
- `/api/apps/:id/deploy` and `/api/apps/:id/rollback` become thin wrappers that:
  1. Compute `{ scriptId, params } = resolveDeployOperation(app, runParams)`.
  2. Insert a `deployments` row (as today).
  3. Call `scriptsRunner.runScript(scriptId, serverId, params, userId, { linkDeploymentId })`.
  4. Return `{ deploymentId, jobId }` as today.
- `runScript` internally inserts the `script_runs` row, then delegates SSH exec to the existing `scriptRunner.runScript` (OR a new `executeOnServer` helper — decision below).

**Decision on the internal `scriptRunner`**: rename the existing `server/services/script-runner.ts` class → `sshExecutor` (it's really an SSH-stream-with-JSON-parser, not a domain "runner"), and build the new `scripts-runner.ts` on top of it. The existing import sites (`routes/deployments.ts` line ~139) migrate to the new scriptsRunner as the single entry point.

**Rationale**: `script-runner.ts` today does SSH+stdout parsing; `scripts-runner.ts` (new) does manifest + transport assembly + history + lock. Two files with clear separation; minimal reshape of the mature SSH plumbing.

**Alternatives considered**:
- **Keep one file, add methods**: grows a 200-line class to 500+ lines; losses in readability.
- **Full replacement of the old runner**: risk to deploy correctness; incremental is safer.

---

## R-009: Manifest startup validation (revised 2026-04-22)

**Decision**: Two-tier validation — strict at CI, lenient at runtime. The dashboard MUST boot even with a broken manifest so the operator has UI access to roll back.

- **CI / unit test** (T022): enforces strict validation. `id` uniqueness, file existence, Zod schema compiles, `locus === "target"` entries have a ZodObject `params`. Any failure = red test = PR blocked. This is where 99% of manifest bugs get caught.
- **Runtime startup** (`server/index.ts`): runs the same checks but does NOT `process.exit(1)` on per-entry errors. Instead each entry is annotated with `{ valid: boolean; validationError: string | null }` and kept in the manifest cache. The annotated cache is what `GET /api/scripts/manifest` serves and what `POST /api/scripts/*/run` consults.

Behaviour on specific failures:

| Failure | CI | Runtime |
|---|---|---|
| Duplicate `id` | red test | **FATAL** — ambiguous dispatch, cannot be resolved |
| Script file missing on disk | red test | entry flagged invalid, UI shows disabled with tooltip |
| Zod schema throws on descriptor extraction | red test | entry flagged invalid, UI disabled |
| `locus: "target"` but params is not a ZodObject | red test | entry flagged invalid, UI disabled |

`POST /api/scripts/:id/run` on an invalid entry → `400 INVALID_MANIFEST_ENTRY` with the `validationError` in details.

**Rationale**: The original fail-fast decision was sound for catching bugs but created a failure mode where a typo in a PR could brick the dashboard UI needed to roll back said PR. CI enforcement is the right gate — CI blocks the merge; runtime only has to survive the case where CI somehow let it through (bypassed checks, emergency hotfix, etc.). The `id`-uniqueness exception stays fatal because dispatch is genuinely ambiguous — we can't serve either entry without guessing.

**Alternatives considered**:
- **Full fail-fast at runtime (original decision)**: lockout risk. **Rejected 2026-04-22** after Gemini review.
- **Full lenient at runtime including duplicate ids**: picks first, logs warn. Rejected — silent data-dependent behaviour is worse than loud failure for a genuinely ambiguous config.
- **Feature flag `DEPLOY_LOCK_SKIP_POOL_CHECK`-style bypass**: over-engineering for a rare case; the two-tier model is simpler.

---

## R-010: Retention cleanup — startup + periodic, with log-ownership scoping (revised 2026-04-22)

**Decision**: Two-pronged — startup prune runs always, PLUS a background `setInterval(24h).unref()` keeps long-running dashboards honest. Log-file deletion is gated on the row actually owning the file (see below).

### Prune schedule

- **Startup**: always runs, right after migrate, before HTTP listen. Blocking per the existing start-up pattern.
- **Background**: `setInterval(process.env.SCRIPT_RUNS_PRUNE_INTERVAL_MS ?? 24 * 3600 * 1000, prune).unref()`. The `.unref()` prevents the interval from blocking process exit. Setting the env var to `0` disables the background timer (startup-only mode, matches the original decision for operators who prefer fewer timers).

### Log-file ownership rule

Deploy operations produce BOTH a `deployments` row AND a linked `script_runs` row (FR-041 dual-write). Both rows store the same `log_file_path`. The `deployments` row is the authoritative owner — it's surfaced in the app-centric deploy history view, which existed before this feature and has its own retention rhythm governed by feature 001.

So the prune deletes:

- The `script_runs` row older than the retention window — ALWAYS.
- The log file on disk — ONLY when the row being deleted has `deployment_id IS NULL` (i.e. it's a standalone ops run, not a deploy). When `deployment_id IS NOT NULL`, the deploy row is the file owner; we leave the file alone and let feature-001 retention govern it.

Prune SQL (revised):

```sql
-- Delete the rows; capture log_file_path ONLY for rows that own their log
DELETE FROM script_runs
  WHERE started_at::timestamptz < NOW() - INTERVAL '90 days'
  RETURNING
    CASE WHEN deployment_id IS NULL THEN log_file_path ELSE NULL END AS owned_log_path;
-- Runner iterates returned rows; fs.unlink only non-null owned_log_path values.
```

**Rationale**: The original startup-only decision assumed "dashboards restart weekly" — a fragile assumption for a long-lived internal tool. Periodic prune is one interval + ~10 lines of code; it closes the failure mode entirely. The log-ownership gating prevents a Gemini-identified bug where the Runs page's retention would have silently broken the Deployments page's log-tail feature.

**Alternatives considered**:
- **Startup-only (original decision)**: relies on the restart assumption. **Revised 2026-04-22.**
- **Ref-count column on logs**: over-engineering for a two-table case; the deployment_id nullability already encodes ownership.
- **Separate log paths per table (different naming convention)**: requires dual-writes to copy the log, which is wasteful and out of character for this feature's "thin runner" design.

---

## R-011: Zod `.describe("secret")` — is `_def.description` stable in Zod 4?

**Decision**: Yes, stable for our purposes. Zod 4's public `.describe(str)` sets `_def.description: string`. It's accessed by zod itself for error formatting and is part of the stable-for-downstream-tooling surface (countless libs read it). Our consumption is trivial equality check `field._def.description === "secret"`.

**Risk**: Zod 5 might rename `_def` → `def` or move description to a different key. Mitigation: wrap the access in a tiny helper `isSecretField(field): boolean` (single source of change when we upgrade). Covered by unit test against the Zod version in `package.json`.

---

## Summary of Unknowns Resolved

| Topic | Decision |
|---|---|
| Docker bundling | Move build context to repo root, copy `scripts/` in production stage (R-001) |
| Transport | ssh2 ClientChannel stdin write, `env VAR='...' bash -s -- <args>` (R-002) |
| common.sh integration | Runtime concat + regex-strip `source` line (R-003) |
| Param serialisation | Extract `shQuote` to shared helper; secret params via env-var, not argv (R-004) |
| UI form generation | Server emits typed descriptor; client renders; server re-validates on submit (R-005) |
| Secret persistence | Mask before DB insert; defence-in-depth via pino redact (R-006) |
| Deploy dispatch | Pure function `resolveDeployOperation(app, runParams)` on existing fields (R-007) |
| Runner composition | New `scripts-runner.ts` on top of renamed `sshExecutor`; dual-write deployments + script_runs (R-008) |
| Manifest validation | Fail-loud at startup per FR-003 (R-009) |
| Retention cleanup | Startup-time prune with log-file cleanup (R-010) |
| Zod `.describe()` stability | Stable in Zod 4; wrapped for future upgrade (R-011) |
