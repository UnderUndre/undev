# Implementation Plan: Universal Script Runner

**Branch**: `005-universal-script-runner` | **Date**: 2026-04-22 | **Spec**: [spec.md](spec.md)

## Summary

Turn the DevOps Dashboard into a thin UI over the repo's `scripts/` tree. A typed manifest (`devops-app/server/scripts-manifest.ts`) declares every runnable operation with a Zod param schema; a new `scripts-runner.ts` service looks up an entry, validates params, concatenates `scripts/common.sh` + the target script, and pipes the result into `bash -s` on the chosen server over SSH stdin. Execution history persists to a new `script_runs` table. Deploy and rollback become manifest-driven operations dispatched by a pure function `resolveDeployOperation(app, runParams)` — the free-form `applications.deploy_script` column is dropped in a single atomic migration.

## Technical Context

**Existing stack** (from 001–004):
- Express 5 + React 19 / Vite 8 / Tailwind 4, drizzle-orm + `postgres` (porsager) 3.4.x
- `sshPool` (`ssh2` 1.17) with `execStream(id, cmd) → ClientChannel` — stdin writes work over the channel (confirmed via ssh2 docs; see R-002).
- `jobManager` for in-memory job lifecycle + WS event fan-out.
- Pino logger with redact config.
- Feature 004 `deployLock` service for `requiresLock: true` entries.
- `scripts/*.sh` (10 runtime + ~4 bootstrap/dev) sourcing `scripts/common.sh`.

**New for this feature**:
- `scripts-manifest.ts` — typed list of runnable operations.
- `scripts-runner.ts` — new service, depends on renamed `sshExecutor` (old `script-runner.ts`) + `jobManager` + `deployLock` + manifest + `shQuote`.
- `lib/sh-quote.ts` — extracted helper.
- `resolveDeployOperation` pure function in `deploy-command.ts` (or a new `deploy-dispatch.ts`).
- `script_runs` table + drizzle model + migration 0005.
- New routes: `GET /api/scripts/manifest`, `POST /api/scripts/:id/run`, `GET /api/runs`, `GET /api/runs/:id`.
- Client: new **Scripts** tab on `ServerPage`, new **Runs** page/sidebar entry, Zod-descriptor-driven form component.
- Docker build: context moved to repo root; `.dockerignore` at repo root; Dockerfile adjusted to copy `scripts/` into `/app/scripts`.

**No new npm dependencies.**

**Unknowns resolved in research.md**:
- R-001: Docker build context relocation.
- R-002: ssh2 stdin transport.
- R-003: common.sh concat + source-line strip.
- R-004: `shQuote` extraction.
- R-005: Zod → descriptor → form.
- R-006: secret masking layering.
- R-007: `resolveDeployOperation` + pre-migration audit.
- R-008: runner composition atop renamed SSH executor.
- R-009: manifest startup validation.
- R-010: retention via startup prune.
- R-011: `_def.description` stability in Zod 4.

## Project Structure

```
undev/
├── Dockerfile                              # [NEW at repo root, moved from devops-app/Dockerfile]
├── .dockerignore                           # [NEW at repo root]
├── scripts/
│   ├── common.sh                           # [unchanged]
│   ├── deploy/{deploy,rollback,...}.sh     # [unchanged; optional argv extensions noted in tasks]
│   ├── deploy/deploy-docker.sh             # [NEW — wraps scan-docker inline command]
│   ├── db/{backup,restore}.sh              # [unchanged]
│   ├── docker/cleanup.sh                   # [unchanged]
│   ├── monitoring/security-audit.sh        # [unchanged]
│   └── server/health-check.sh              # [unchanged]
└── devops-app/
    ├── docker-compose.yml                  # [MODIFIED — build.context: ..]
    ├── Dockerfile                          # [DELETED — moved up]
    ├── server/
    │   ├── db/
    │   │   ├── schema.ts                   # [MODIFIED — drop deployScript, add scriptRuns]
    │   │   └── migrations/
    │   │       └── 0005_scripts_runner.sql # [NEW — drop col + create table]
    │   ├── lib/
    │   │   └── sh-quote.ts                 # [NEW — extracted]
    │   ├── services/
    │   │   ├── deploy-command.ts           # [MODIFIED — uses lib/sh-quote; adds resolveDeployOperation]
    │   │   ├── script-runner.ts            # [RENAMED → ssh-executor.ts]
    │   │   └── scripts-runner.ts           # [NEW — the domain runner]
    │   ├── scripts-manifest.ts             # [NEW]
    │   ├── routes/
    │   │   ├── scripts.ts                  # [NEW — manifest + run endpoints]
    │   │   ├── runs.ts                     # [NEW — history endpoints]
    │   │   ├── deployments.ts              # [MODIFIED — delegates to scriptsRunner]
    │   │   └── apps.ts                     # [MODIFIED — remove deployScript field]
    │   ├── middleware/
    │   │   └── audit.ts                    # [MODIFIED — apply secret mask before body capture]
    │   ├── lib/
    │   │   └── logger.ts                   # [MODIFIED — extend redact paths]
    │   └── index.ts                        # [MODIFIED — scriptsRunner.validateManifest() + pruneOldRuns()]
    ├── client/
    │   ├── components/
    │   │   ├── apps/AddAppForm.tsx         # [MODIFIED — remove deployScript field]
    │   │   └── scripts/                    # [NEW dir]
    │   │       ├── ScriptsTab.tsx          # [NEW — per-server catalog]
    │   │       ├── RunDialog.tsx           # [NEW — Zod-descriptor-driven form]
    │   │       └── RunDetail.tsx           # [NEW — live + post-mortem log view]
    │   ├── pages/
    │   │   ├── ServerPage.tsx              # [MODIFIED — add Scripts tab]
    │   │   └── RunsPage.tsx                # [NEW — sidebar + history list]
    │   └── components/layout/Sidebar.tsx   # [MODIFIED — add Runs link]
    └── tests/
        ├── unit/
        │   ├── sh-quote.test.ts            # [NEW — extracted helper round-trip]
        │   ├── scripts-manifest.test.ts    # [NEW — validation]
        │   ├── resolve-deploy-operation.test.ts # [NEW — dispatch function]
        │   ├── common-sh-concat.test.ts    # [NEW — regex strip + layout]
        │   └── zod-descriptor.test.ts      # [NEW — shape extraction]
        └── integration/
            ├── scripts-runner.test.ts      # [NEW — acquire → exec → record → release]
            ├── scripts-runner-secret.test.ts # [NEW — secret-param redaction end-to-end]
            ├── scripts-runner-lock.test.ts # [NEW — requiresLock: true → 409 path]
            ├── scripts-runner-timeout.test.ts # [NEW — timeout → status=timeout]
            ├── runs-api.test.ts            # [NEW — GET /api/runs endpoints]
            ├── deploy.test.ts              # [MODIFIED — no behaviour regressions via new path]
            └── deploy-lock.test.ts         # [unchanged — same contract]
```

## Key Implementation Notes

### `scripts-manifest.ts` layout

```ts
import { z } from "zod";

export const manifest = [
  { id: "deploy/deploy", category: "deploy", description: "Deploy an application",
    locus: "target", requiresLock: true, timeout: 1_800_000,
    params: z.object({
      remotePath: z.string(),
      branch: z.string().regex(/^[a-zA-Z0-9._\-/]+$/),
      commit: z.string().regex(/^[0-9a-f]{7,40}$/).optional(),
      skipInitialClone: z.boolean().default(false),
    }),
  },
  // ... other entries per data-model.md
] as const satisfies readonly ScriptManifestEntry[];
```

The `as const satisfies` shape preserves narrow types on the ids for the dispatch function without losing the runtime array shape.

### `scripts-runner.ts` public surface

```ts
class ScriptsRunner {
  validateManifest(): void;          // startup — throws on any issue
  getManifestDescriptor(): ManifestDescriptor[];  // for GET /api/scripts/manifest
  async runScript(
    scriptId: string,
    serverId: string,
    params: Record<string, unknown>,
    userId: string,
    options?: { linkDeploymentId?: string },
  ): Promise<{ runId: string; jobId: string }>;
  async pruneOldRuns(): Promise<{ deletedRows: number; deletedLogFiles: number }>;
}
```

Internal flow of `runScript`:

1. Look up manifest entry by `scriptId`. Not found → throw `ScriptNotFoundError`.
2. Parse `params` with entry's Zod schema. Fails → re-throw ZodError (route converts to 400).
3. If `entry.requiresLock`, call `deployLock.acquireLock(serverId, runId)`. Returns false → throw `DeploymentLockedError(lockedBy = deployLock.checkLock(serverId))`.
4. Split params into `argvParams` and `envParams` per secret-ness (R-004).
5. Mask secrets → insert `script_runs` row (status=pending).
6. Read `scripts/common.sh` from `/app/scripts/common.sh`; read target script from `/app/scripts/<category>/<name>.sh`; strip `source` line; concat.
7. Build SSH command: `env YES=true CI=true ${Object.entries(envParams).map(([k,v]) => `${k}=${shQuote(v)}`).join(" ")} bash -s -- ${argvParams.join(" ")}`.
8. `sshExecutor.executeWithStdin(serverId, sshCmd, concatenatedBuffer, runId)` → returns `{ jobId }`.
9. Transition `script_runs.status` to running; wire `jobManager.onJobEvent(jobId, onStatusChange)` where terminal status updates `script_runs` + optional `deployments` linked row + releases lock.
10. Return `{ runId, jobId }`.

### `sshExecutor` (renamed from old `script-runner.ts`)

New method `executeWithStdin(serverId, command, stdinBuffer, jobLinkId)`:

- Calls `sshPool.execStream(serverId, command)`.
- Immediately `stream.write(stdinBuffer); stream.end()`.
- Existing stdout/stderr/close handlers unchanged.

Other existing method `runScript` is kept for now (it's still called by feature-001 code paths that aren't refactored yet) but SHOULD be progressively replaced by `scriptsRunner.runScript` in later cleanup.

### `resolveDeployOperation`

Lives in `server/services/deploy-command.ts` as a new exported pure function. See R-007. Unit-tested via `tests/unit/resolve-deploy-operation.test.ts` with 4 cases: manual+git, manual+docker, scan+git, scan+docker.

### Migration `0005_scripts_runner.sql`

Two statements per data-model.md:
1. `ALTER TABLE applications DROP COLUMN deploy_script;`
2. `CREATE TABLE script_runs (...)` + three indexes.

Atomic per A-002. No dual-write window.

### UI: `ServerPage` Scripts tab

Add `"Scripts"` between `"Apps"` and `"Health"` in the `TABS` const at `ServerPage.tsx:44`. Mount `<ScriptsTab serverId={...} />` when active. The component:

- Fetches `GET /api/scripts/manifest` once (React Query).
- Groups entries by `category`; renders a card per entry.
- Click Run → opens `<RunDialog entry={entry} serverId={...} />`.

### UI: `RunDialog`

Pure presentational — receives a manifest descriptor, renders a form, calls `POST /api/scripts/:id/run` with the collected params. For `dangerLevel: "high"`, requires the admin to type the script's id exactly before the Run button activates.

Field type mapping (per FR-031):

| Descriptor type | Control |
|---|---|
| `string` (not secret) | `<input type="text">` |
| `string` (secret) | `<input type="password" autoComplete="new-password">` |
| `number` | `<input type="number">` |
| `boolean` | `<input type="checkbox">` |
| `enum` | `<select>` |

Zod errors from server `400 INVALID_PARAMS` → surface under matching `name` field; if no match, surface in a top-of-form banner.

### UI: `RunsPage` + Sidebar

Add `"Runs"` to `Sidebar.tsx` between `"Servers"` and `"Audit Trail"`. New page fetches `GET /api/runs?limit=50&offset=...`, renders a sortable/filterable table. Each row links to `<RunDetail runId={...}>` which reuses the existing live-log component (renamed from `LogViewer` to accept either a `jobId` (live) or a `runId` (post-mortem)).

### Archived run UX (FR-043)

`GET /api/runs/:id` response includes `archived: boolean` and `reRunnable: boolean`. The detail component:

- Shows an "Archived" chip next to the script id when `archived === true`.
- Hides the "Re-run" button when `reRunnable === false`, shows a tooltip explaining why.

### Pre-migration audit (A-005 / R-007)

New script `scripts/db/pre-migration-005-audit.sh` (or a one-shot Node script under `devops-app/scripts/`) queries the prod DB via `psql $DATABASE_URL`:

```sql
SELECT deploy_script, COUNT(*) FROM applications GROUP BY deploy_script;
```

Outputs a report: for each unique value, classify as "maps to deploy/deploy", "maps to deploy/deploy-docker", or "UNKNOWN — needs review". The admin runs this before release; any UNKNOWN blocks the migration until resolved (by updating the application record or extending `resolveDeployOperation`).

### Startup wiring in `server/index.ts`

After the existing deploy-lock pool-check and reconcile:

```ts
// New steps for feature 005:
try {
  scriptsRunner.validateManifest();
} catch (err) {
  logger.fatal({ ctx: "scripts-manifest", err }, "Manifest invalid — refusing to start");
  process.exit(1);
}
await scriptsRunner.pruneOldRuns().catch((err) => {
  logger.warn({ ctx: "scripts-runner-prune", err }, "Retention prune skipped");
});
```

Manifest failure is fatal (FR-003); prune failure is warn-and-continue (low-impact housekeeping).

## Constitution Check

No `.specify/memory/constitution.md` in this repository. Applying CLAUDE.md Standing Orders:

| Principle | Status | Note |
|---|---|---|
| No commits/pushes without request | ✅ | Plan only |
| No new packages without approval | ✅ | Zero new deps |
| No `--force` / bypass flags | ✅ | N/A |
| No secrets in code/logs | ✅ | Secret params routed through env-var + redact + `"***"` persistence |
| No direct DB migrations | ✅ | `0005_scripts_runner.sql` generated for admin review |
| No destructive ops without consent | ⚠️ | `DROP COLUMN deploy_script` is destructive — mitigated by A-005 pre-migration audit + the convention established in features 001–004 that migrations apply atomically with releases under admin oversight |
| Plan-first if >3 files changed | ✅ | Plan lists every file |
| Check context7 before unfamiliar API | ✅ | ssh2 stdin + Zod `_def.description` verified via existing codebase usage + R-011 wrapper for Zod upgrade insulation |

The `DROP COLUMN` risk is surfaced explicitly (rather than suppressed) because the admin-applies-migrations protocol treats migration review as a manual gate.

## Complexity Tracking

| Addition | Why Needed | Simpler Alternative Rejected |
|---|---|---|
| `script_runs` table | FR-040 — ops-wide history visibility; dual-write with `deployments` keeps app-scoped view intact | Reuse `deployments` for all runs → breaks `deployments.applicationId NOT NULL` invariant and bloats the app history with backups/audits |
| Move Docker build context to repo root | R-001 — only portable way to bundle `scripts/` which lives outside `devops-app/` | Symlink (Windows fragile), pre-build copy (breaks `docker-compose build`), buildx contextdir (non-portable) |
| `scripts-manifest.ts` vs filesystem walk | FR-002 — security, plus need for param schemas not derivable from filenames | Filesystem walk + convention over config → no param validation, no danger flags, no secrets routing |
| Rename `script-runner.ts` → `ssh-executor.ts` | R-008 — two concerns in one file (SSH plumbing + domain runner); separate files keep each below 200 lines | Grow the existing class → loses the acquire/release/lock/history boundary |
| Extract `shQuote` to shared lib | R-004 — consistent single source; same helper used by runner and deploy-command | Duplicate in both files → drift |
| Zod-descriptor endpoint vs. full JSON Schema | R-005 — smaller, matches our ~5 field types, no new dep | `zod-to-json-schema` + mapper → extra dep + indirection for zero gain |
| Env-var transport for secrets | FR-016 / R-006 — argv visible in `ps auxwww`, env is not | Argv with `"***"` in stored params only → transport is still leaky on the remote |
| common.sh runtime concat | R-003 — preserves DRY in repo-root `scripts/`, keeps scripts runnable locally unchanged | Build-time inlining (debug pain), refactor scripts (loss of DRY) |

## Out of Plan

Explicit non-goals (mirror spec § Out of Scope):

- Scheduler / cron runs
- RBAC / per-role visibility
- UI-side script editor
- Per-app custom scripts
- Bootstrap / new-server wizard
- Exposure of `scripts/dev/*`
- Cross-run log aggregation
- Generic cancellation mid-run (deploys keep their existing cancel path)
- Multi-server fan-out
- Rollout orchestration (blue-green etc.) built on top of runner

## Post-design Constitution Re-check

| Principle | Re-check | Note |
|---|---|---|
| No commits/pushes without request | ✅ | Still plan-only |
| No new packages | ✅ | Design uses only existing `zod`, `postgres`, `drizzle-orm`, `ssh2`, `pino`, `express` |
| No secrets in code/logs | ✅ | R-006 secret layering explicit; tests in plan cover the end-to-end redaction |
| Plan-first >3 files | ✅ | 20+ files listed |
| No destructive ops without consent | ⚠️ still surfaced, same mitigation |
| No raw `string interpolation` in SQL | ✅ | All queries in data-model §Query catalogue use `$N` bind params or drizzle |
| No `any`, no `console.log` | ✅ | Plan notes enforce these; task list will check |

Proceed to Phase 2 (tasks).
