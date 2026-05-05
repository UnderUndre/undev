# Implementation Plan: Operational Maturity

**Branch**: `010-operational-maturity` (or feature branch when split per Q1 of Session 2026-05-02) | **Date**: 2026-05-05 | **Spec**: [spec.md](spec.md)

## Summary

Six independent operational gaps closed atop features 001–009: mount the
already-built BootstrapWizard (US1), add per-stage lifecycle hooks
(US2), unify failure surfaces under a typed `FailureCard` contract
(US3), turn cross-server domain warnings into a concrete conflict report
with typed-confirm (US4), give `audit_entries` a faceted UI with CSV
export (US5), and a Migration Toolkit that PATCH-promotes scan-imported
rows or INSERTs new rows when adopting a manually-configured app (US6).

The story shape is **integration-heavy, novelty-light**. Almost every
piece extends an existing service, route, or component. The new
abstractions are: one validator (`script-hook-validator.ts` for the
mutual-exclusion invariant per FR-013a), one component family
(`FailureCard` + variant action button), and one wizard
(`MigrateExistingAppWizard`). Everything else is wiring.

Architectural shape:

- **Schema additions live in `0011_operational_maturity.sql`** — feature
  011 already occupies `0010_zero_touch.sql` on a sibling branch. The
  sequence is fixed up-front to prevent merge collisions.
- **Mutual exclusion (script_path ↔ hooks) is enforced at FOUR layers**:
  Zod refinement at form-write, Zod at API route, runner refusal at
  dispatch, AND a DB-level CHECK constraint as defence against direct
  `psql` writes (Q5 of plan outline).
- **`FailureCard` is a discriminated union** of canonical actions. The
  `kind` field is the lexicon. UI renders fixed labels per variant —
  drift is a TypeScript error, not a UX paper-cut.
- **`pre_destroy` hook integration with hard-delete uses a decorator
  pattern** (Q4 of plan outline) — new `hard-delete-with-hooks.ts`
  wraps existing feature 008 + feature 009 hard-delete services rather
  than mutating them. Two existing flows keep working unchanged; new
  callers opt in by importing the wrapper.
- **Migration toolkit detects scan-row collision in service code, not
  route**: route always calls `migrationToolkit.adopt(input)` which
  internally branches INSERT vs PATCH-promote. Frontend doesn't need
  two endpoints.

Backward compatibility: Apps with NO hooks set behave exactly as today.
Apps with `script_path` set continue to work; FR-013a invariant only
matters when an operator tries to add hooks to a script_path-app (or
vice versa).

## Technical Context

**Existing stack** (inherited 001–009):

- Express 5 + React 19 / Vite 8 / Tailwind 4
- drizzle-orm 0.45 + `postgres` 3.4
- `scriptsRunner.runScript(scriptId, serverId, params, userId, opts)`
  (feature 005) — extension point for hook dispatch
- `auditMiddleware` (feature 001) emitting `audit_entries` rows on every
  authenticated mutation
- File-tail modal (feature 009 incident 2026-05-02 fix) for live script
  output streaming
- BootstrapWizard component (feature 009) — built but unmounted; this
  feature mounts it
- Compose parser (feature 009) — reused by Migration Toolkit
- `script_path` validation regex + NULL normalisation (feature 007 FR-003)
  — pattern reused for 4 hook columns
- Hard-delete flows in feature 008 (cert + app) and feature 009 (bootstrap
  hard-delete with realpath jail check)
- Pino logger with redact config

**Existing scripts** (no new ones for this feature):

- `scripts/server/setup-vps.sh`, `scripts/deploy/server-deploy.sh`,
  `scripts/deploy/env-setup.sh` — hooks invoked via `bash <appDir>/<hookPath>`
  through the existing runner; no new dispatch primitive.

**New for this feature**:

- One new migration: `devops-app/server/db/migrations/0011_operational_maturity.sql`
  (next sequence after feature 011's `0010_zero_touch.sql` on the sibling
  branch).
- Four new columns on `applications`: `pre_deploy_script_path`,
  `post_deploy_script_path`, `on_fail_script_path`, `pre_destroy_script_path`.
- Enum extension on `applications.created_via` from
  `'manual' | 'scan' | 'bootstrap'` → `'manual' | 'scan' | 'bootstrap' | 'migrate'`.
- DB-level CHECK constraint enforcing mutual exclusion `script_path` ↔
  hooks (FR-013a layer 4).
- New audit event types: `app.hooks_changed`, `app.migrated_from_scan`,
  `app.migrated`, `app.cross_server_domain_confirmed`.
- ~6 new server services / libs (see Project Structure).
- ~4 new HTTP route files / sub-routes.
- ~13 new client components, hooks, pages.
- One new typed contract — `FailureAction` discriminated union (lives in
  `client/components/failure/FailureCard.tsx` + mirrored Zod for runtime
  state-token validation).
- No new npm dependencies. CSV serialisation via standard `Buffer` writes
  (no `papaparse` etc).
- No new manifest entries — hooks are bash invocations of operator-supplied
  scripts, dispatched via existing `executeWithStdin` + `shQuote` (feature
  005 secret-transport convention).

**Unknowns resolved in [research.md](research.md)**:

- R-001: Hook dispatch order + env propagation across pre/post/on_fail/pre_destroy
- R-002: DB-level CHECK constraint expression for mutual exclusion
- R-003: `created_via` enum extension via DROP+ADD CHECK constraint (no PG ENUM type)
- R-004: Audit query performance (faceted filters + CSV export caps)
- R-005: Cross-server domain check query shape
- R-006: Migration toolkit scan-row collision detection
- R-007a: `Revoke` action OUT of FailureCard scope (Session 2026-05-05 review G-P0-4)
- R-007b: FailureCard severity model — flat vs tiered
- R-008a: `pre_destroy` failure recovery via `ForceDelete` action (Session 2026-05-05 review GE-2)
- R-008b: Decorator pattern for `pre_destroy` hook wrapping feature 008/009 hard-delete
- R-009: `STATE_REGISTRY` server/client boundary split (Session 2026-05-05 review G-P0-2)
- R-010: Migration toolkit path-jail check via feature 009's `path-jail.ts` (Session 2026-05-05 review GE-1, security)
- R-011: `on_fail` hook env extension — `FAIL_PHASE` + `FAIL_EXIT_CODE` (Session 2026-05-05 review GE-3)
- R-012: CSV export abort listener for closed-tab DB connection release (Session 2026-05-05 review GE-4)

## Project Structure

```
undev/
├── specs/010-operational-maturity/
│   ├── spec.md                                  # [EXISTING — clarified through Session 2026-05-05]
│   ├── plan.md                                  # [NEW — this file]
│   ├── research.md                              # [NEW — R-001..R-008]
│   ├── data-model.md                            # [NEW — schema additions, audit events, invariants]
│   ├── quickstart.md                            # [NEW — operator walkthrough across 6 US]
│   └── contracts/
│       ├── api.md                               # [NEW — HTTP endpoints + audit query shape]
│       └── failure-card.md                      # [NEW — FailureAction discriminated union + per-context action sets]
└── devops-app/
    ├── server/
    │   ├── db/
    │   │   ├── schema.ts                        # [MOD — 4 hook cols + extend created_via tuple]
    │   │   └── migrations/
    │   │       └── 0011_operational_maturity.sql # [NEW — additive ALTER + enum extension + CHECK]
    │   ├── lib/
    │   │   ├── script-hook-validator.ts         # [NEW — Zod refinement + mutual-exclusion check (FR-013a)]
    │   │   ├── failure-state-declarations.ts    # [NEW — pure-data state→{icon, defaultActionKinds} registry; server/client split per Session 2026-05-05 review G-P0-2]
    │   │   ├── domain-attach-validator.ts       # [NEW — shared cross-server check + typed-confirm logic (D2 from review); reused by edit/migrate/bootstrap routes]
    │   │   └── path-jail.ts                     # [REUSED from feature 009 — imported as-is for migration-toolkit (R-010)]
    │   ├── services/
    │   │   ├── scripts-runner.ts                # [MOD — invoke pre_deploy/post_deploy/on_fail at dispatch points]
    │   │   ├── hard-delete-with-hooks.ts        # [NEW — decorator wrapping feature 008/009 hard-delete; calls pre_destroy first]
    │   │   ├── migration-toolkit.ts             # [NEW — adopt(input): detect scan-row → PATCH-promote OR INSERT]
    │   │   ├── audit-query.ts                   # [NEW — paginated faceted query + CSV stream]
    │   │   └── cross-server-domain-check.ts     # [NEW — FR-019 query]
    │   └── routes/
    │       ├── apps.ts                          # [MOD — PATCH validates hook fields via script-hook-validator; new POST /apps/migrate]
    │       ├── audit.ts                         # [NEW — GET /api/audit + GET /api/audit/export.csv]
    │       └── cross-server-domain-check.ts     # [NEW — GET /api/applications/cross-server-domain-check]
    ├── client/
    │   ├── components/
    │   │   ├── apps/
    │   │   │   ├── AppsTab.tsx                  # [MOD — add Bootstrap + Migrate Existing App buttons]
    │   │   │   ├── EditAppForm.tsx              # [MOD — collapsible Lifecycle Hooks section]
    │   │   │   ├── DomainEditDialog.tsx         # [MOD — embed conflict panel + typed-confirm field]
    │   │   │   ├── DomainTlsSection.tsx         # [MOD — render FailureCard for cert failures]
    │   │   │   ├── CrossServerDomainConflictPanel.tsx  # [NEW]
    │   │   │   └── MigrateExistingAppWizard.tsx # [NEW]
    │   │   ├── audit/                           # [NEW dir]
    │   │   │   ├── AuditFilters.tsx             # [NEW]
    │   │   │   ├── AuditTable.tsx               # [NEW]
    │   │   │   └── ResourceLink.tsx             # [NEW — handles deleted-resource fallback]
    │   │   ├── bootstrap/
    │   │   │   └── BootstrapStateBadge.tsx      # [MOD — expand to FailureCard on failed_*]
    │   │   ├── deploy/
    │   │   │   └── DeployLog.tsx                # [MOD — replace red banner with FailureCard]
    │   │   └── failure/                         # [NEW dir]
    │   │       ├── FailureCard.tsx              # [NEW — typed FailureAction with ActionTrigger nested union per Session 2026-05-05 review G-P1-5]
    │   │       └── FailureActionButton.tsx      # [NEW — variant-aware renderer; uses AppError.internal not raw throw]
    │   ├── lib/
    │   │   └── failure-state-wiring.ts          # [NEW — wireActions(state, ctx, callbacks) per Session 2026-05-05 review G-P0-2 client/server split]
    │   ├── hooks/
    │   │   ├── useAuditQuery.ts                 # [NEW]
    │   │   ├── useFailureCallbacks.ts           # [NEW — DI hook providing FailureCallbacks for wireActions]
    │   │   ├── useCrossServerDomainCheck.ts     # [NEW]
    │   │   └── useMigrationAdopt.ts             # [NEW]
    │   ├── pages/
    │   │   └── AuditPage.tsx                    # [NEW — wraps AuditFilters + AuditTable]
    │   └── lib/
    │       └── sidebar-routes.ts                # [MOD — add /audit entry] (verify exact module name during implementation)
    └── tests/
        ├── unit/
        │   ├── script-hook-validator.test.ts    # [NEW — mutual-exclusion three layers + valid combos]
        │   ├── failure-state-mapper.test.ts     # [NEW — state-token → action set per context]
        │   ├── failure-card.test.ts             # [NEW — variant rendering + label invariants]
        │   ├── audit-query.test.ts              # [NEW — facet combinations, page caps, CSV serialiser]
        │   ├── cross-server-domain-check.test.ts # [NEW — query returns conflicts excluding self + soft-deleted]
        │   ├── migration-toolkit.test.ts        # [NEW — scan-row PATCH-promote vs new INSERT branch]
        │   ├── hard-delete-with-hooks.test.ts   # [NEW — pre_destroy invocation + feature 008/009 wrapping]
        │   └── scripts-runner-hooks.test.ts     # [NEW — pre/post/on_fail dispatch ordering + env propagation]
        └── integration/
            ├── bootstrap-wizard-mount.test.ts   # [NEW — US1 wizard reachable from AppsTab]
            ├── hooks-end-to-end.test.ts         # [NEW — US2 PATCH hook field → deploy invokes hook in correct order]
            ├── failure-card-deploy.test.ts      # [NEW — US3 DeployLog mounts FailureCard on failed]
            ├── failure-card-bootstrap.test.ts   # [NEW — US3 BootstrapStateBadge expands on failed_*]
            ├── failure-card-cert.test.ts        # [NEW — US3 DomainTlsSection on cert failure]
            ├── cross-server-domain-confirm.test.ts # [NEW — US4 conflict panel + typed-confirm flow]
            ├── audit-page-faceted.test.ts       # [NEW — US5 filter combos + CSV export]
            └── migration-scan-promote.test.ts   # [NEW — US6 scan-row PATCH-promote path]
```

## Migration plan

`devops-app/server/db/migrations/0011_operational_maturity.sql` — additive
plus enum extension. Sequence number 0011 chosen because feature 011
(`011-zero-touch-onboarding` branch) already owns 0010. Cross-feature
rule: when both branches merge to main, 0010 lands first (feature 011
foundational), then 0011 (this feature) — no schema collision.

### Applications — 4 new hook columns

```sql
ALTER TABLE "applications" ADD COLUMN "pre_deploy_script_path" TEXT NULL;
ALTER TABLE "applications" ADD COLUMN "post_deploy_script_path" TEXT NULL;
ALTER TABLE "applications" ADD COLUMN "on_fail_script_path" TEXT NULL;
ALTER TABLE "applications" ADD COLUMN "pre_destroy_script_path" TEXT NULL;
```

### Mutual exclusion CHECK constraint (FR-013a layer 4)

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

This is layer 4 of defence-in-depth. Layers 1-3 are Zod (form / API /
runner). DB CHECK catches direct `psql` writes that bypass the route.

### `created_via` enum extension to add `'migrate'`

```sql
-- PostgreSQL CHECK-constraint enums require DROP + ADD (no
-- "ALTER ENUM ADD VALUE" since we're not using a PG ENUM type).
ALTER TABLE "applications" DROP CONSTRAINT "applications_created_via_enum";
ALTER TABLE "applications" ADD CONSTRAINT "applications_created_via_enum"
  CHECK ("created_via" IN ('manual', 'scan', 'bootstrap', 'migrate'));
```

### DOWN migration (manual, operator-gated)

```sql
-- ALTER TABLE "applications" DROP CONSTRAINT "applications_created_via_enum";
-- ALTER TABLE "applications" ADD CONSTRAINT "applications_created_via_enum"
--   CHECK ("created_via" IN ('manual', 'scan', 'bootstrap'));
-- ALTER TABLE "applications" DROP CONSTRAINT "applications_script_path_hooks_mutex";
-- ALTER TABLE "applications" DROP COLUMN "pre_destroy_script_path";
-- ALTER TABLE "applications" DROP COLUMN "on_fail_script_path";
-- ALTER TABLE "applications" DROP COLUMN "post_deploy_script_path";
-- ALTER TABLE "applications" DROP COLUMN "pre_deploy_script_path";
-- WARNING: rows with created_via='migrate' MUST be deleted or relabelled
-- BEFORE running the constraint-restore.
```

## Constitution Check

No `.specify/memory/constitution.md` in repo. CLAUDE.md Standing Orders
+ AI-Generated Code Guardrails serve as proxy (same convention as feature
011's plan). Each rule checked:

| Rule (CLAUDE.md) | Status | Notes |
|---|---|---|
| #1 Never commit/push without request | ✓ | Plan deliverables are files only. |
| #2 Never install packages without approval | ✓ | **Zero new npm deps.** CSV serialisation hand-rolled (~30 lines). |
| #3 Never use `--force / --yes / -y` flags | ✓ | All destructive flows (US4 typed-confirm, US6 wizard) require explicit operator typing. |
| #4 Never put secrets in code/commits/logs | ✓ | Hooks receive existing `SECRET_*` exports per feature 005's secret transport (no new secret material). Audit details JSON respects existing redact policy (FR-026 of feature 001). |
| #5 Never run migrations directly | ✓ | `0011_operational_maturity.sql` ships as reviewable SQL. |
| #6 No destructive commands without 3x consent | ✓ | `pre_destroy` hook runs INSIDE existing hard-delete flows that already require typed acknowledgement (feature 008 + 009). No new destructive entry-points. |
| #7 Never read .env / secrets unless asked | ✓ | Migration toolkit reads operator-supplied paths only; never auto-reads `.env`. |
| AGCG: no `process.env.X \|\| "fallback"` | ✓ | Audit query uses existing pino + `auditMiddleware` config. |
| AGCG: no `as any` | ✓ | All new modules typed. `FailureAction` discriminated union forces exhaustive switch. |
| AGCG: no `throw new Error()` raw | ✓ | Use existing `AppError` factory pattern. |
| AGCG: no `console.log` | ✓ | Pino `logger` everywhere with `ctx` field. |
| AGCG: no swallowed `catch (e) { }` | ✓ | All catches log + re-throw OR convert to typed result. |
| AGCG: no `req.body.field` without Zod | ✓ | Every new route validates body with Zod. |
| AGCG: no `dangerouslySetInnerHTML` | ✓ | Audit details JSON rendered via React tree, not HTML. |

**Gate status: PASS.** No waivers needed.

## Phase 0: Outline & Research

Output: [research.md](research.md). Resolves R-001..R-008 listed in
Technical Context. Each entry documents Decision / Rationale /
Alternatives.

Key resolutions:

- **R-001** Hook dispatch order: linear sequence inside `scripts-runner`
  with explicit fail-fast on `pre_deploy` non-zero, fail-but-don't-rollback
  on `post_deploy`, warn-only on `on_fail` failure (per FR-007/008/009).
  Each hook is an independent shell invocation — no env carryover (each
  receives the same fresh `APP_DIR / BRANCH / COMMIT / SECRET_*` exports
  per FR-011).
- **R-002** Mutex CHECK constraint expressed as a single CHECK clause
  with OR-of-NULLs (see Migration plan section above). Tested by
  fixture migration in `tests/integration/`.
- **R-003** `created_via` enum extension via DROP+ADD CHECK constraint.
  Project does NOT use PostgreSQL ENUM type (would require `ALTER TYPE
  ADD VALUE`, harder to reverse). Plain CHECK constraint is consistent
  with feature 009's pattern.
- **R-004** Audit query: paginated `WHERE` over `(occurred_at, actor,
  action, resource_type)`; existing index on `(occurred_at DESC)` per
  feature 001 sufficient for time-range scan. Faceted filters add
  `IN (...)` predicates. CSV export caps at 10,000 rows AND streams
  via `res.write` chunks (no buffering of full dataset).
- **R-005** Cross-server domain check: simple
  `SELECT serverId, serverLabel, appId, appName, domain, certStatus
  FROM applications JOIN servers JOIN app_certs WHERE domain = $1
  AND id != $2 AND deleted_at IS NULL`. One round-trip.
- **R-006** Migration toolkit scan-row detection: `SELECT id FROM
  applications WHERE server_id = $1 AND remote_path = $2 AND created_via =
  'scan'`. If hit → PATCH path; else INSERT. Active rows with other
  `created_via` values reject (per FR-033a + US6 edge case).
- **R-007** FailureCard severity model: **flat (no tiers)**. Every
  FailureCard is "something failed, here's how to recover". Severity
  variance lives in icon + summary phrasing, not in a typed level.
  YAGNI — adding tiers later is an additive change, removing them is a
  breaking visual refactor.
- **R-008** Decorator pattern for `pre_destroy` hook: new
  `hard-delete-with-hooks.ts` exports `hardDeleteWithHooks(input)`
  which (a) checks if app has `pre_destroy_script_path`, (b) dispatches
  the hook via runner if so, (c) delegates to existing
  `feature008-hard-delete.ts` OR `feature009-bootstrap-hard-delete.ts`
  based on `created_via`. Existing services unchanged — opt-in by
  importing the wrapper.

## Phase 1: Design & Contracts

Outputs:

- [data-model.md](data-model.md) — schema additions, FR-013a invariant
  formalised, audit event types catalogued, mutex CHECK SQL.
- [contracts/api.md](contracts/api.md) — all new HTTP endpoints with
  Zod-derived schemas, audit query response shape, CSV export streaming
  contract, migration toolkit input/output.
- [contracts/failure-card.md](contracts/failure-card.md) — `FailureAction`
  discriminated union, per-context action set (deploy / bootstrap / cert
  / health), display label registry, exhaustive-switch pattern for
  rendering.
- [quickstart.md](quickstart.md) — operator walkthrough across 6 US
  with smoke-checks mapped to SC-001..SC-006.

### Agent context update

The repo has no `.specify/scripts/powershell/update-agent-context.ps1`.
Per user direction (carried over from feature 011), CLAUDE.md is **not**
modified by this plan.

## Re-evaluate Constitution Check post-design

After draft of data-model.md + contracts/api.md + contracts/failure-card.md:

| Rule | Status |
|---|---|
| All Standing Orders + AGCG | ✓ (no design choice introduces a violation) |
| Migration is additive | ✓ (only ALTER ADD + enum-rotation; no row destruction; constraint drop+add operates on definition only, not data) |
| Mutual exclusion enforceable at all 4 layers | ✓ (Zod ×3 + DB CHECK ×1) |
| `FailureAction` exhaustive at compile time | ✓ (TypeScript forces switch coverage) |
| `pre_destroy` integration non-invasive | ✓ (decorator wrapper, existing services untouched) |

**Gate status: PASS post-design.** No re-design required.

## Cross-feature coordination

- **Migration sequence number**: this plan reserves `0011_operational_maturity.sql`.
  Feature 011 reserves `0010_zero_touch.sql`. When both merge to main,
  the order is 0010 → 0011 (alphabetical, also matches creation order).
- **`auditMiddleware` event-type catalogue**: feature 011 introduced 9
  new event types. This feature adds 4 more (`app.hooks_changed`,
  `app.migrated_from_scan`, `app.migrated`,
  `app.cross_server_domain_confirmed`). When both merge, the
  `audit-middleware.ts` catalogue must include all 13.
- **Hard-delete flows**: feature 008 + feature 009 have their own
  hard-delete services. This feature wraps both via the decorator
  (R-008). Operators must opt in by switching the route handlers to
  call `hardDeleteWithHooks(...)` instead of the underlying services
  directly. Routes touched: `apps.ts` (feature 008's app hard-delete)
  and the bootstrap hard-delete route (feature 009).
- **`script_path` invariant** (feature 007): unchanged. FR-013a only
  ADDS a constraint between `script_path` and the new hook columns;
  existing apps with `script_path` set continue to work unchanged.

## Open dependencies

- **`update-agent-context.ps1` and `.specify/`** infrastructure absent
  (same state as feature 011). Plan written by-convention against
  existing 009 / 011 plan formats.
- **DB-level CHECK constraint cost on existing data**: validated
  expression `script_path IS NULL OR (all hooks IS NULL)` is satisfied
  by every existing row (no row currently has hook columns set — they
  don't exist). ALTER ADD CONSTRAINT will succeed without migration
  data shaping.

## Stop point

Plan ends at Phase 2. Implementation tasks (Phase 3) are produced by
`/speckit.tasks` from this plan + the spec.

## Generated artifacts

- [plan.md](plan.md) (this file)
- [research.md](research.md)
- [data-model.md](data-model.md)
- [contracts/api.md](contracts/api.md)
- [contracts/failure-card.md](contracts/failure-card.md)
- [quickstart.md](quickstart.md)

Suggested next: `/speckit.tasks`.
