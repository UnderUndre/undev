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

## R-003: common.sh concatenation — regex to strip the source line

**Decision**: Strip the `source` line via a compiled regex; the canonical pattern in every existing script is:

```bash
source "$(dirname "$0")/common.sh"
```

- Regex: `/^\s*source\s+"\$\(dirname\s+"\$0"\)\/common\.sh"\s*$/m`
- Also match a tolerant variant with single-quotes instead of doubles (future-proof): `/^\s*source\s+["']?\$\(dirname\s+["']?\$0["']?\)\/common\.sh["']?\s*$/m`
- If the regex matches zero lines in a target script, the runner logs a warn (`"script does not source common.sh — running as-is"`) and transports the script unchanged. This keeps third-party-shaped scripts runnable without forcing the convention.
- If the regex matches more than one line, the runner logs a warn and strips all matches (safest behaviour).

The transported buffer layout:

```text
#!/bin/bash
# Auto-injected by devops-app scripts-runner
<contents of scripts/common.sh with shebang stripped>
# --- end common.sh ---
<contents of target script with shebang stripped + source-line removed>
```

**Rationale**: `common.sh` has its own shebang; bash-via-stdin ignores shebangs anyway (stdin is interpreted), but we strip them for cleanliness and to avoid `set -e` interactions. The "end common.sh" comment is a debug breadcrumb in log output when a script fails at a known boundary.

**Alternatives considered**:
- **Build-time inline (vite plugin)**: couples the build pipeline to scripts conventions, harder to debug.
- **Refactor all scripts to not use `common.sh`**: destroys DRY, forbidden by spec.
- **Wrap the target in `bash -c "source /dev/stdin <<'SHIM'\n<common.sh>\nSHIM\n<target>"`**: nested heredoc nightmare.

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

## R-006: `script_runs.params` storage shape and secret redaction layering

**Decision**: Params are stored **after Zod-parse + secret-mask transform**, not as the raw request body. The transform runs server-side before the DB insert and before any log emission:

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
- `auditMiddleware` receives a pre-masked body via a small extension to the middleware (pass-through on non-runner routes).
- `logger.ts` pino redact paths extended: `scriptRun.params.*` always runs through a projection function, but the authoritative redaction is at the DB-write boundary.

**Rationale**: Defence-in-depth. Even if someone later forgets to redact in a log call, the DB already holds `"***"`. The real value lives only inside `scriptsRunner.runScript`'s local stack for the duration of the SSH exec.

**Alternatives considered**:
- **DB-level redaction trigger**: over-engineered for a single column in one table.
- **Encryption-at-rest with key rotation**: solves a different threat model (DB dump leak), doesn't help with logs; deferred to a separate security-only spec if ever needed.

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

## R-009: Manifest startup validation

**Decision**: Validate at app startup in `server/index.ts`, after the migration step and before HTTP listen. For each manifest entry:

1. `id` uniqueness across all entries.
2. Parse `id` into `<category>/<script-name>`, confirm file exists at `/app/scripts/<category>/<script-name>.sh`.
3. The Zod schema compiles (accessed via `.shape` and descriptor extraction — any runtime error aborts).
4. `locus === "target"` entries have a non-empty `params` schema (can be `z.object({})` — just must be a ZodObject).

Any failure → `logger.fatal({ ctx: "scripts-manifest", id, err }, "Invalid manifest entry")` → `process.exit(1)`. No soft-fail, per FR-003.

**Rationale**: Manifest is first-class config; a broken manifest IS a deployment bug and should fail-loud, not limp.

---

## R-010: Retention cleanup — background timer vs startup prune

**Decision**: Startup prune. Adds `scriptsRunner.pruneOldRuns()` called once at startup (after migrate, before HTTP listen). Deletes `script_runs` rows older than `SCRIPT_RUNS_RETENTION_DAYS` (default 90), **and** deletes the corresponding log files on disk in the same pass.

**Rationale**: A background `setInterval` is one more moving part. Since dashboards are restarted at least once a week on average (redeploys, config changes), startup-only prune is sufficient granularity. If retention needs to be tighter in future, add the timer then — not now.

**Alternatives considered**:
- **Background `setInterval(86_400_000)`**: defers cleanup behind process lifetime; log-file deletion is the hard part anyway.
- **DB-triggered on every write**: wastes work per insert.

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
