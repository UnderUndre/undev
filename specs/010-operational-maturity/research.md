# Research: Operational Maturity

**Date**: 2026-05-05 | **Branch**: `010-operational-maturity` | **Plan**: [plan.md](plan.md)

Resolves all NEEDS CLARIFICATION items from plan's Technical Context.
Each entry: Decision · Rationale · Alternatives considered.

---

## R-001 — Hook dispatch order + env propagation

**Decision**: Linear inline sequence inside `scripts-runner.ts` deploy
flow. Each hook is an independent `bash <appDir>/<hookPath>` invocation
that receives the same fresh env exports — no carryover between hooks.

```
1. git fetch + reset                         (existing)
2. if pre_deploy_script_path: bash $hook  ← new dispatch point
   non-zero exit → mark deploy 'failed' + jump to step 5
3. docker compose up -d                      (existing)
   non-zero → jump to step 5
4. if post_deploy_script_path: bash $hook ← new dispatch point
   non-zero exit → mark deploy 'failed' but DO NOT roll back compose
5. if deploy is 'failed' AND on_fail_script_path: bash $hook  ← new dispatch point
   non-zero exit → log warn, never propagate
```

`pre_destroy` lives in a separate flow (see R-008) — invoked by
`hard-delete-with-hooks.ts` BEFORE compose-down + rm.

**Env exports per hook** (same as builtin deploy per FR-011):

```
APP_DIR=/path/to/app/on/target
BRANCH=main
COMMIT=<resolved sha>
SECRET_<KEY>=<decrypted env var value>   # one per applications.env_vars(_encrypted)
```

**Rationale**:

- Inline dispatch within the existing runner avoids introducing a new
  manifest entry per hook (would require 4 new manifest entries +
  scripts-manifest.ts churn for no functional gain).
- No env carryover keeps each hook idempotent and stateless from the
  runner's perspective. Operators who need shared state write to disk
  inside `$APP_DIR` (e.g. `pre_deploy` writes a marker file,
  `post_deploy` reads it).
- `on_fail` warn-only failure handling matches existing pattern from
  feature 005 (where audit emit failures are logged but never crash
  the script run).

**Alternatives considered**:

- New manifest entries `hooks/pre-deploy`, `hooks/post-deploy`, etc —
  rejected: adds 4 manifest entries + Zod schemas for what's already
  a bash invocation against a relative path; the manifest is for
  *first-class* dashboard scripts, not operator-supplied glue.
- Async `Promise.race` between hooks and compose — rejected: linear
  ordering is a contract, parallelism breaks "pre_deploy MUST finish
  before compose" semantics.
- Per-hook env override (custom env per hook) — explicitly out of scope
  per spec Out of Scope (operator can set env internally in their script).

---

## R-002 — DB-level CHECK constraint expression

**Decision**: Single CHECK constraint with OR-of-NULLs:

```sql
ALTER TABLE "applications" ADD CONSTRAINT "applications_script_path_hooks_mutex"
  CHECK (
    "script_path" IS NULL
    OR (
      "pre_deploy_script_path" IS NULL
      AND "post_deploy_script_path" IS NULL
      AND "on_fail_script_path" IS NULL
      AND "pre_destroy_script_path" IS NULL
    )
  );
```

**Semantic**:

- `script_path = NULL`: any hook combination valid (zero, one, several).
- `script_path != NULL`: ALL hooks MUST be NULL.

**Rationale**:

- Single constraint expression — easier to introspect in `\d
  applications` than four separate constraints.
- Catches direct `psql` writes that bypass the route layer (FR-013a
  layer 4 of defence-in-depth).
- Constraint validation on existing rows: ZERO existing rows have any
  hook column populated (columns being newly added in this migration),
  so ALTER ADD CONSTRAINT succeeds immediately without data shaping.

**Alternatives**:

- Four separate `CHECK` constraints (one per hook column) — rejected:
  more verbose, same semantic.
- Trigger-based enforcement — rejected: triggers are heavier, harder
  to debug, and CHECK is the standard idiom.
- Skip DB-level entirely (rely on Zod ×3) — rejected: spec FR-013a
  promotes this to a 4-layer invariant; defence against direct writes
  matters during data migration / disaster recovery / debug sessions
  where someone might `psql` in.

---

## R-003 — `created_via` enum extension via DROP+ADD CHECK

**Decision**: DROP existing CHECK constraint, ADD new one with extended
value list:

```sql
ALTER TABLE "applications" DROP CONSTRAINT "applications_created_via_enum";
ALTER TABLE "applications" ADD CONSTRAINT "applications_created_via_enum"
  CHECK ("created_via" IN ('manual', 'scan', 'bootstrap', 'migrate'));
```

**Rationale**:

- Project does NOT use PostgreSQL native ENUM type (would have allowed
  `ALTER TYPE ADD VALUE` — but that's irreversible without a full type
  re-create, which is worse than the CHECK rotation).
- Plain CHECK constraint is consistent with feature 009's pattern
  (`bootstrap_state_enum` uses CHECK).
- Atomic within a single migration file — both ALTER statements run
  in the same transaction; intermediate state (no constraint) lasts
  microseconds.

**Edge cases**:

- Backfill: zero existing rows have `created_via='migrate'` (value
  doesn't exist yet), so the new constraint is trivially satisfied.
- DOWN migration: if any row has `created_via='migrate'`, restoring the
  old constraint fails. The DOWN comment block warns operators to
  delete or relabel such rows first.

**Alternatives**:

- Skip enum extension; use string column with no constraint — rejected:
  loses the typo-protection that makes the column trustworthy.
- Switch to PG ENUM type — rejected: irreversible value addition is
  worse than CHECK rotation; also breaks consistency with the rest of
  the schema.

---

## R-004 — Audit query performance

**Decision**: Paginated `SELECT` with parameterised facets, page size
hard-capped at 100, total result hard-capped at 10,000. CSV export
streams via `res.write` chunks — never buffers the full dataset.

```ts
// audit-query.ts
async function query(filters: AuditFilters, page: number, pageSize = 100) {
  const where = buildWhereClause(filters);
  // Drizzle parameterised query, no string interpolation
  const rows = await db
    .select(/* canonical column subset */)
    .from(auditEntries)
    .where(where)
    .orderBy(desc(auditEntries.occurredAt))
    .limit(pageSize)
    .offset((page - 1) * pageSize);
  const totalCount = await db
    .select({ count: count() })
    .from(auditEntries)
    .where(where);
  return { rows, totalCount: Math.min(totalCount, 10_000) };
}

async function streamCsv(filters: AuditFilters, res: Response) {
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename=audit-${nowISO()}.csv`);
  res.write("timestamp,actor,action,resource_type,resource_id,details\n");
  let lastSeen: string | null = null;
  let written = 0;
  while (written < 10_000) {
    const batch = await db
      .select(/* ... */)
      .from(auditEntries)
      .where(and(buildWhereClause(filters), lastSeen ? lt(auditEntries.id, lastSeen) : undefined))
      .orderBy(desc(auditEntries.occurredAt), desc(auditEntries.id))
      .limit(500);
    if (batch.length === 0) break;
    for (const row of batch) {
      res.write(serialiseCsvRow(row));
      written += 1;
      if (written >= 10_000) break;
    }
    lastSeen = batch[batch.length - 1].id;
  }
  res.end();
}
```

**Rationale**:

- Existing index `(occurred_at DESC)` from feature 001 covers the
  primary scan dimension. Faceted filters (`actor IN (...)`, `action IN
  (...)`, `resource_type = ?`) are bitmap-friendly without additional
  indexes for the row counts this dashboard sees (~10k-100k rows over
  90-day window).
- CSV streaming avoids OOM on the 10k cap. 500-row batches keep memory
  bounded.
- `lastSeen` cursor pagination (vs OFFSET) avoids the deep-skip cost
  on large totals.

**Alternatives**:

- Full-text search via `tsvector` — rejected per spec Out of Scope (v2).
- Background job that pre-computes facet aggregations — rejected: row
  counts don't justify it; query latency is sub-second on the expected
  data shape.
- Buffer full CSV then send — rejected: 10k rows × ~500 bytes = 5 MB,
  not catastrophic but pointless when streaming is trivial.

---

## R-005 — Cross-server domain check query

**Decision**: Single `SELECT` join across `applications` + `servers`
(+ optional `app_certs` for cert status), parameterised on the domain
string and self-app-id exclusion.

```sql
SELECT a.id AS appId,
       a.name AS appName,
       a.domain,
       s.id AS serverId,
       s.label AS serverLabel,
       (SELECT status FROM app_certs WHERE app_id = a.id ORDER BY created_at DESC LIMIT 1) AS certStatus
  FROM applications a
  JOIN servers s ON s.id = a.server_id
 WHERE a.domain = $1
   AND a.id != $2
   AND a.deleted_at IS NULL
 ORDER BY s.label, a.name;
```

**Rationale**:

- One round-trip; LATERAL or CTE not needed for this row shape.
- Excludes soft-deleted apps per existing convention (feature 008
  soft-delete frees the domain unique slot via NULL).
- `excludeAppId` parameter prevents the dialog from listing the app
  whose domain edit is in progress.

**Alternatives**:

- Two queries (apps then certs) — rejected: more round-trips, no benefit.
- Cache result client-side — rejected: domain edits are infrequent and
  cache invalidation on cross-server domain changes adds complexity for
  no win.

---

## R-006 — Migration toolkit scan-row collision detection

**Decision**: Service-level branching via existence query before INSERT.

```ts
// migration-toolkit.ts
async function adopt(input: MigrationInput, userId: string): Promise<MigrationResult> {
  const existing = await db
    .select({ id: applications.id, createdVia: applications.createdVia })
    .from(applications)
    .where(and(
      eq(applications.serverId, input.serverId),
      eq(applications.remotePath, input.remotePath),
      isNull(applications.deletedAt),
    ))
    .limit(1);
  if (existing.length > 0) {
    if (existing[0].createdVia === "scan") {
      // PATCH-promote per FR-033a
      return augmentExisting(existing[0].id, input, userId);
    }
    // Active row with non-scan origin → reject per US6 edge case
    throw AppError.conflict("path_already_managed", { existingAppId: existing[0].id });
  }
  // No collision → INSERT new row with created_via='migrate'
  return insertNew(input, userId);
}
```

**Rationale**:

- Single conditional in service layer — frontend always calls
  `POST /api/applications/migrate`, doesn't need to know the branching.
- Audit emits different actions per branch:
  - INSERT path → `app.migrated`
  - PATCH-promote path → `app.migrated_from_scan`
  - Reject path → no audit (conflict error returned to operator)
- Race condition (two operators migrate same path simultaneously):
  existing UNIQUE constraint on `(server_id, remote_path)` from
  features 001/008 catches the race; second INSERT fails, we return
  `path_already_managed`.

**Alternatives**:

- Two endpoints (`POST /migrate/new` and `PATCH /migrate/promote`) —
  rejected: forces frontend to do detection that backend can do better
  with a single query.
- Always INSERT, let unique constraint fail — rejected: error message
  would say "duplicate key" instead of the more useful "this path is
  managed by scan, would you like to augment?".

---

## R-007a — `Revoke` action belongs OUTSIDE FailureCard scope

**Decision** (per Session 2026-05-05 review G-P0-4): `Revoke` action is
removed from the `FailureAction` enum and thus from FailureCard.
Revoke lives only on the normal cert-management UI when status is
`active`. FailureCard renders for cert *failure* states
(`failed/rate_limited/pending_reconcile`), where revoking makes no sense
— there's nothing in flight to revoke.

**Original draft conflict**: FR-017 listed Revoke in FailureCard's
action set "(only when cert status is `active`)" — but FailureCard
literally never renders for `active` status. Self-contradiction.

**Resolution**:
- FailureCard cert action set: `ForceRenew` + `EditConfig` only.
- Revoke action lives on the existing cert UI in `DomainTlsSection`
  (active-cert region), unchanged from feature 008.
- `FailureActionKind` enum does NOT include `Revoke` — typecheck
  catches future regressions.

## R-007b — FailureCard severity model

**Decision**: **Flat — no severity tiers in v1.** Every FailureCard is
rendered identically (red border, error icon, monospace details, action
row at bottom). Severity variance lives in the `summary` text and icon
choice per `state` token, not in a separate severity prop.

**Rationale**:

- YAGNI. The 6 failure surfaces (deploy, bootstrap clone/compose/
  healthcheck/proxy/cert, health probe, cert lifecycle, caddy reachability)
  all converge on "something failed, here's what to do". No real-world
  ask for "this failure is a Warning vs an Error" distinction surfaced
  in clarifications.
- Adding tiers later is additive (new optional `severity` prop with
  default). Removing them later is a breaking visual refactor (operators
  trained on tier-icons will be confused).
- FR-018 mentions "icon by severity" — this is reinterpreted as "icon
  by state" (e.g. clock icon for `cert_rate_limited`, network icon for
  `caddy_unreachable`). Each state maps to one icon via a registry in
  `failure-state-mapper.ts`.

**Alternatives**:

- 2-tier (warn / error) — rejected: every FailureCard is by definition
  an error; "warn" tier would confuse operators.
- 4-tier (info / warn / error / critical) — rejected: dashboard isn't a
  monitoring-grade severity system; this is operator UX, not pager
  routing.
- Per-context custom severity — rejected: defeats the unification goal
  of US3.

---

## R-008a — `pre_destroy` hook failure recovery (`ForceDelete` action)

**Decision** (per Session 2026-05-05 review GE-2): when the
`pre_destroy` hook fails (script disappears → exit 127, syntax error,
transient SSH issue), the app could otherwise become permanently
undeletable. Adding a `ForceDelete` action to the FailureCard enum
gives the operator a typed-confirm escape hatch that bypasses the
hook with explicit audit trail.

**Mechanics**:
- `DELETE /api/applications/:id/hard-delete` returns
  `pre_destroy_hook_failed` on hook non-zero. `hardDeleteWithHooks.ts`
  throws this BEFORE delegating to feature 008/009 hard-delete (per
  R-008b decorator pattern below).
- Frontend renders FailureCard with `state="pre_destroy_hook_failed"`,
  declarations.ts entry surfaces `Retry` + `ForceDelete` actions.
- `ForceDelete` opens typed-confirm dialog (operator types app name)
  → calls `DELETE /api/applications/:id/hard-delete?force=true`.
- `force=true` skips the hook entirely, audited as
  `app.hard_deleted_force_bypass` (separate event from regular
  `app.hard_deleted` for forensic distinction).

**Why explicit operator decision instead of auto-skip on exit 127**:
considered "auto-skip if exit code is 127 (file not found)" but
rejected — that's magic. Operator should know "your hook failed,
I'm not going to silently bulldoze; here's a button if you understand
the risk". Same philosophy as feature 008 hard-delete typed-confirm.

**Audit trail integrity**: `app.hard_deleted_force_bypass` payload
includes the hook path that was bypassed AND the failure reason
(exit code, SSH stderr). Future investigators can see "operator chose
to skip the dump" not "hard-delete just succeeded".

## R-008b — Decorator pattern for `pre_destroy` hook

**Decision**: New `hard-delete-with-hooks.ts` module exports
`hardDeleteWithHooks(input)` that wraps the existing hard-delete
services (feature 008's `hard-delete-app.ts` and feature 009's
`bootstrap-hard-delete.ts`).

```ts
// hard-delete-with-hooks.ts
import { hardDeleteApp as f008HardDelete } from "./feature008/hard-delete-app.js";
import { hardDeleteBootstrap as f009HardDelete } from "./feature009/bootstrap-hard-delete.js";
import { scriptsRunner } from "./scripts-runner.js";
import { db } from "../db/client.js";
import { applications } from "../db/schema.js";
import { eq } from "drizzle-orm";

export async function hardDeleteWithHooks(appId: string, userId: string): Promise<HardDeleteResult> {
  const app = await db.select().from(applications).where(eq(applications.id, appId)).limit(1);
  if (app.length === 0) throw AppError.notFound("app_not_found");

  if (app[0].preDestroyScriptPath) {
    const result = await scriptsRunner.runScript(
      "deploy/server-deploy",  // reuses existing deploy manifest entry's bash invocation infra
      app[0].serverId,
      { appDir: app[0].remotePath, scriptOverride: app[0].preDestroyScriptPath },
      userId,
      { phase: "pre_destroy" },
    );
    if (!result.ok) {
      throw AppError.internal("pre_destroy_hook_failed", { exitCode: result.exitCode });
    }
  }

  // Delegate to existing hard-delete based on origin
  if (app[0].createdVia === "bootstrap") {
    return f009HardDelete(appId, userId);
  }
  return f008HardDelete(appId, userId);
}
```

**Rationale**:

- Two existing hard-delete services (feature 008 + 009) keep working
  unchanged — opt-in by switching the route handler import to
  `hardDeleteWithHooks`.
- Failure of `pre_destroy` ABORTS the hard-delete (operator's hook
  protects something — backups, db dumps — and we should not bulldoze
  the app if the protection failed). Operator can fix the hook script
  and retry.
- Decorator-style avoids touching feature 008's and feature 009's
  hard-delete code paths, which are already fragile (realpath jail
  check, transaction-bound row state changes, audit emit ordering).

**Alternatives**:

- In-place modification of feature 008 + 009 hard-delete services to
  call `pre_destroy` first — rejected: regression risk in two
  battle-tested flows for one feature's optional concern.
- Mid-flight "before-delete" event hook system — rejected: overkill;
  one well-typed wrapper is sufficient.
- `pre_destroy` runs ASYNC (fire-and-forget) — rejected: defeats the
  purpose; operator hooks need to gate the destroy.

---

## R-009 — `STATE_REGISTRY` server/client boundary split

**Decision** (per Session 2026-05-05 review G-P0-2): the original draft
put React-callbacks (`retryDeploy`, `openHardDeleteDialog`) inside a
file claimed to live in `server/lib/`. Server cannot import React or
client routes. Fix: split the registry into two modules with strict
data-only contract on the server side.

```
server/lib/failure-state-declarations.ts
  → pure data: { state → { icon, applicableContexts, defaultActionKinds, fromStep?, customLabel? } }
  → no React, no client routes, no callbacks, importable from anywhere

client/lib/failure-state-wiring.ts
  → consumes server declarations + DI'd FailureCallbacks
  → produces fully-wired FailureAction[] for FailureCard
  → ALL React/route concerns live here
```

**Why split (not "just keep on client")**: the server still benefits
from knowing the canonical state-token vocabulary — for emitting the
correct token in API responses, validating in tests that all
`bootstrap_state` values have a declaration, and (future) for
generating typed clients. Server-side declarations are pure data, so
they're safe to share via a tsconfig path mapping like
`@server-types/failure-state-declarations`.

**Why not put EVERYTHING on client**: server-side audit logs reference
state tokens. Without server-side validation that a token is "real",
operators could see audit entries with state strings that have no UI
mapping (silently rendered as raw token text).

**Alternatives considered**:
- Whole registry on server with client-side hook overrides — rejected:
  same React-import problem, just one level removed.
- Whole registry on client, server emits opaque strings — rejected:
  loses validation that audit-emitted tokens are renderable.
- Code-generated client from server contract — overkill for this size.

---

## R-010 — Migration toolkit path-jail check

**Decision** (per Session 2026-05-05 review GE-1): `migration-toolkit.ts`
MUST resolve operator-supplied `remotePath` via SSH `realpath` and
assert the resolved canonical path is rooted under one of the server's
`scan_roots` (default `/opt`, `/srv`, `/var/www`,
`/home/<deployUser>/apps`). Out-of-jail paths reject with 422
`target_path_jail_violation` before any DB write.

**Reuses**: feature 009's `path-jail.ts` (built for bootstrap hard-delete)
exposes `resolveAndJailCheck(serverId, remotePath, allowedRoots)`.
Same signature serves migration toolkit — no new code needed beyond
calling it.

**Threat model**: operator (potentially after compromise of their
dashboard credentials) could otherwise:
1. Click "Migrate Existing App" with `remotePath="/etc"`.
2. App row created with `remote_path="/etc"`.
3. Click "Hard Delete".
4. Feature 008/009 hard-delete runs `rm -rf /etc` on the target.
5. Host bricked.

The `realpath` check (vs string-prefix check) defends against symlink
escapes: `mkdir -p /opt/apps/innocent && ln -s /etc /opt/apps/innocent/data`,
then `remotePath="/opt/apps/innocent/data"`. String-prefix would pass;
realpath catches the symlink resolution to `/etc` and rejects.

**Tests**: `migration-toolkit.test.ts` covers the canonical jail-violation
fixtures (literal `/etc`, `/`, `/var/log`, plus a symlink-escape fixture).

---

## R-011 — `on_fail` hook env extension (`FAIL_PHASE`, `FAIL_EXIT_CODE`)

**Decision** (per Session 2026-05-05 review GE-3): `on_fail` hook
receives two ADDITIONAL env vars beyond the base set (`APP_DIR`,
`BRANCH`, `COMMIT`, `SECRET_*`):

- `FAIL_PHASE` — one of `git_fetch`, `pre_deploy`, `compose_up`,
  `post_deploy`. Identifies which phase tripped the failure.
- `FAIL_EXIT_CODE` — integer exit code from the failed phase.

**Why**: original draft passed identical env to all hooks. An alert-
webhook script invoked as `on_fail` could only emit "deploy failed for
$APP_DIR" — useless for triage. With `FAIL_PHASE`, operator's hook
script can route differently: "compose_up failure → page on-call",
"pre_deploy DB migration failure → ping db-team", etc.

**Other hooks unchanged**: `pre_deploy`, `post_deploy`, `pre_destroy`
do NOT receive these vars (always undefined for them) — they don't run
in a failure context, the variables would be misleading.

**Implementation site**: `scripts-runner.ts` env-builder branches on
the dispatched hook stage; only `on_fail` branch adds these vars.

---

## R-012 — CSV export abort listener

**Decision** (per Session 2026-05-05 review GE-4): the streaming CSV
loop in `audit-query.streamCsv` MUST register `req.on("close", ...)`
and check the abort flag at every cursor-batch boundary (every 500
rows). When client closes the connection mid-download, the loop breaks
at the next batch and releases the DB cursor.

**Implementation**:

```ts
async function streamCsv(filters: AuditFilters, req: Request, res: Response) {
  let aborted = false;
  req.on("close", () => { aborted = true; });

  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename=audit-${nowISO()}.csv`);
  res.write("timestamp,actor,action,resource_type,resource_id,resource_label,details_json\n");

  let lastSeen: string | null = null;
  let written = 0;
  while (written < 10_000 && !aborted) {
    const batch = await db
      .select(/* ... */)
      .from(auditEntries)
      .where(and(buildWhereClause(filters), lastSeen ? lt(auditEntries.id, lastSeen) : undefined))
      .orderBy(desc(auditEntries.occurredAt), desc(auditEntries.id))
      .limit(500);
    if (batch.length === 0 || aborted) break;
    for (const row of batch) {
      if (aborted) break;
      res.write(serialiseCsvRow(row));
      written += 1;
      if (written >= 10_000) break;
    }
    lastSeen = batch[batch.length - 1].id;
  }
  res.end();
  // Drizzle connection cleanup happens via pool deref on res.end()
}
```

**Why this matters**: without abort detection, a closed-tab CSV download
holds a DB connection alive while the loop chews through up to 10,000
rows. At ~50 ms per 500-row batch, that's up to 1 second of pointless
work, holding a connection that could serve other requests. On a busy
dashboard, this becomes a connection-pool DoS vector.

**Alternatives**:
- AbortController + Drizzle abort signal — Drizzle doesn't expose
  cancel-mid-query for cursor pagination cleanly. Boundary-checking
  between batches is sufficient because each batch is short (500 rows).
- Server-Sent Events with explicit close handshake — overkill; CSV is
  one-shot download.
