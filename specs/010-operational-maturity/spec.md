# Feature Specification: Operational Maturity — Lifecycle Hooks, Failure UX, Audit UI, Migration Toolkit

**Version**: 1.0 | **Status**: Draft | **Date**: 2026-05-02

> **Umbrella spec note**: 010 collects 6 logically-related but technically independent
> work streams that mature dashboard operations after features 006/007/008/009 shipped.
> Each User Story below is shippable in isolation. The spec stays intentionally
> umbrella-scoped because all 6 share `applications` schema additions, audit-trail
> integration, and the deploy/runner pipeline. At implementation time, each US can
> extract into its own sub-spec (010a, 010b, …) if independent shipping is desired
> — see Clarifications Q1 below for the operator's preference.

## Clarifications

### Session 2026-05-05 (review pass — `.gemini/review.md` + `.github/review.md`)

- Q: US4 typed-confirm scope — only DomainEditDialog or all domain entry
  points (bootstrap + migrate + edit)? → A: **All entry points**. The
  invariant is "explicit decision before HA-style attach", not "only
  when editing". Cross-server check + typed-confirm move into
  `POST /api/applications/bootstrap` (feature 009 endpoint extension)
  AND `POST /api/applications/migrate` (this feature) AND
  `POST /api/applications/:id/domain` (feature 008, already covered).
  When any of these three flows attaches a domain that already exists
  on another server, the operator MUST type the domain string to
  proceed. Closes G-P0-1 + G-E-9 from review.
- Q: `STATE_REGISTRY` for FailureCard — server-side, client-side, or
  split? → A: **Two-tier split**. Server-side
  `failure-state-declarations.ts` is pure data: `state → { icon,
  defaultActionKinds: FailureActionKind[] }` (no callbacks, no href,
  no React imports). Client-side `failure-state-wiring.ts` is the
  callback registry: `(kind, ctx) → FailureAction` mapping that
  consumes the server declarations and produces fully-wired actions.
  Server can validate that a `state` token is recognised; client owns
  UI mechanics. Closes G-P0-2 from review.
- Q: Hooks entry points — only `EditAppForm` or also `BootstrapWizard` /
  `MigrateExistingAppWizard`? → A: **Only `EditAppForm`** (post-create
  step). Single entry point keeps FR-013a invariant simple and forces
  operator to make a separate "configure hooks" decision after the app
  exists. Bootstrap and Migrate wizards omit the hooks fields entirely
  — operator runs the wizard, then opens Edit Application to add hooks
  if desired. Closes G-P0-3 from review.
- Q: FR-017 Revoke action variant — appears in FailureCard for
  `failed/rate_limited/pending_reconcile` cert states, but spec text
  says "only when active". Self-contradictory. → A: **Revoke action
  removed from FailureCard scope**. `Revoke` lives only on the normal
  cert-management UI (when status is `active`). FailureCard for cert
  failures shows `ForceRenew` + `EditConfig` only. Closes G-P0-4 from
  review.
- Q: `pre_destroy` hook bricks the app when script disappears (exit
  127) or has bug — operator can't delete. Recovery? → A: Add
  **`ForceDelete`** action variant to FailureAction enum. When
  hard-delete fails with `pre_destroy_hook_failed`, FailureCard renders
  with two actions: `Retry` (re-runs hook, useful for transient SSH
  issues) and `ForceDelete` (bypasses hook, sends `?force=true`,
  audited as `app.hard_deleted_force_bypass`). Operator gets explicit
  decision rather than magic. Closes GE-2 from review.
- Q: `script_path` ↔ hooks atomic switch — UI must allow clearing
  script_path AND populating hooks in same PATCH? → A: **Yes, single
  atomic PATCH**. `EditAppForm` collects all hook + script_path state
  client-side and submits as one body. The mutex CHECK constraint
  validates the resulting row state, not intermediate. Form UI shows
  a "Switch from script_path to hooks" button that pre-populates the
  pending PATCH with `script_path: null` + cleared hooks (operator
  fills in). Closes GE-6 from review.

### Session 2026-05-05

- Q: Mutual exclusion `script_path` (feature 007 full-replace) vs hooks
  (US2 per-stage) — silent ignore, warn-and-allow, hard reject, or soft
  preference? → A: **Hard reject at all three layers** (form-write,
  API-route, runner). Zod cross-field refinement: if `script_path` is
  non-NULL, all four hook columns MUST be NULL (and vice versa). UI
  Save button disabled with inline error; API returns 400
  `script_path_hooks_mutually_exclusive`; runner refuses to dispatch
  with same error code (defence-in-depth — defends against direct DB
  writes bypassing the route). Closes OQ-001. A-002 promoted from
  "operator picks one model" assumption to enforced invariant.
- Q: FailureCard action vocabulary — typed enum, freeform strings,
  hybrid, or defer? → A: **Typed enum + Custom escape hatch**. Canonical
  set: `Retry`, `RetryFromFailedStep`, `EditConfig`, `ViewLog`,
  `HardDelete`, `ForceRenew`, `Revoke`, `Custom`. `Custom` carries a
  freeform `label: string` for one-off context-specific actions.
  TypeScript enforces single canonical lexicon across deploy / bootstrap
  / health / cert failure surfaces — directly serves SC-003's "uniform
  recovery vocabulary" goal. Closes OQ-002 by promoting "Retry from
  failed step" to its own first-class action variant distinct from
  full-restart `Retry`.
- Q: Migration toolkit on a path with existing scan-imported row —
  reject as conflict, PATCH-promote in place, mutate created_via, or
  defer? → A: **PATCH-promote in place**. Wizard detects existing
  `(server_id, path)` row with `created_via='scan'`, switches to
  "augment existing" mode: pre-fills detected fields (repo URL,
  compose path), operator enters missing fields (health URL, domain,
  hooks), submit performs PATCH (not INSERT) on the existing row,
  emits audit event `app.migrated_from_scan` with full snapshot of
  added fields. `created_via` STAYS `'scan'` — origin metadata
  preserved for forensics. Avoids the dead-end UX of plain reject AND
  the metadata loss of overwriting `created_via='migrate'`.

### Session 2026-05-02 (initial)

- Q: Umbrella spec or split into 6 sub-specs? → A: **Umbrella** for design coherence; per-US extraction at planning phase if pace requires.
- Q: Per-app lifecycle hook scope — only `pre/post/on_fail` or full hook tree (`pre_clone`, `pre_build`, `pre_compose`, `post_compose`, `on_fail`, `on_success`, `pre_destroy`)? → A: **Conservative — only the four with proven demand**: `pre_deploy`, `post_deploy`, `on_fail`, `pre_destroy`. Each new hook adds Zod field + validator + dispatch wiring + form UI + docs; we ship the well-defined four and let usage data drive expansion. Feature 007 pattern (single `script_path` overrides whole deploy) stays as alternative for "I want to replace deploy entirely" use case.
- Q: Failure UX scope — refactor existing failure surfaces or unify under one new component? → A: **One new component, gradual mounting**. New `FailureCard` component with `(state, action[])` contract. Mount in DeployLog first (highest visibility), then BootstrapStateBadge, then app health status. Old surfaces stay until each replaced — no big-bang rewrite.
- Q: Audit UI — full-text search, faceted filtering, or simple list? → A: **Faceted filtering** (actor, resource, action, time range) + sort. No FTS in v1 — `audit_entries` row count manageable for SQL `WHERE` over 90-day window. FTS can land in v2 if log volume grows.
- Q: Migration toolkit scope — bulk script for one-shot legacy import, or persistent UI for ongoing manual conversions? → A: **Persistent UI**. One-shot scripts get lost. UI form: paste path / repo URL / detected service → "Import & adopt" flow that creates the row + scan baseline + optional immediate health probe. Reusable for any future "I have an existing app outside dashboard control" scenario.
- Q: Bootstrap UI integration — wire feature 009 wizard into existing AddAppForm OR keep wizard as separate "Bootstrap from GitHub" button alongside Add? → A: **Separate button + flow**. Feature 009 wizard is purpose-built for "from-zero" onboarding (5-step state machine, repo selector with GitHub search, auto-detect compose). Forcing it into AddAppForm dilutes both UX paths. Add stays minimal "I know what I'm doing"; Bootstrap is "guide me through it".

## Problem Statement

After features 006 (health monitoring), 007 (project-local deploy), 008 (domain & TLS),
and 009 (bootstrap deploy) shipped, six operational gaps remain visible to operators:

1. **Bootstrap wizard isn't reachable from the UI**. Feature 009 designed a complete
   5-step state machine, repo selector with GitHub search, port auto-detection, and
   recovery-from-failure UX — but the wizard component is not mounted anywhere. New
   apps still go through the legacy `AddAppForm` which assumes the operator has
   already SSH'd, mkdir'd, and git-cloned (incident 2026-05-02 surfaced this for
   the `cliproxyapi-dashboard` app — operator hit Deploy on a path that didn't
   exist on target). Until the wizard is wired into Server detail view, feature 009
   is shipped-but-invisible.

2. **Per-app deploy customisation is binary**. Feature 007's `script_path` is
   all-or-nothing — operator either uses builtin `server-deploy.sh` or completely
   replaces it. No middle ground for "I want builtin behaviour PLUS my own
   pre-deploy migration step". Real apps need composable hooks (database migrations
   before compose-up, smoke-tests after, alert webhook on fail, cleanup on destroy)
   — currently each project rewrites the whole deploy script just to inject one
   step. Per-app hooks would let operators inject per-stage scripts without
   maintaining a fork of `server-deploy.sh`.

3. **Failure surfaces are inconsistent across the UI**. Deploy fails in the Job
   panel show one error format; bootstrap fails in BootstrapStateBadge another;
   health-check fails in the app status dot a third; cert-issuance fails in
   DomainTlsSection a fourth. Each surface invented its own error display + recovery
   actions independently. Operators can't transfer mental model from one failure
   to another, and recovery actions ("Retry", "Edit Config", "Hard Delete") are
   spelled differently every time.

4. **Cross-server domain conflicts surface only as soft warnings**. Spec 008 FR-001a
   prints a confirmable warning when an operator attaches a domain already used on
   another server. But the warning is ad-hoc text — no enumeration of "where else
   this domain lives", no link to the conflicting app, no confirmation dialog with
   typed acknowledgement. Operators clicking "OK" without reading proceed into HA
   setups they didn't intend.

5. **Audit log has no UI**. `audit_entries` table is populated on every authenticated
   API call (per `auditMiddleware`). But operators have no UI to browse it. Post-
   incident analysis ("who changed this app's domain at 3am?") requires SSH + psql
   queries. With multiple operators using the dashboard, this is a compliance and
   debugging gap.

6. **Legacy app onboarding is high-friction**. Apps that exist on a server outside
   dashboard control (manually configured nginx, hand-cloned repos, ad-hoc systemd
   units) require operator to SSH, inspect, then translate state into Add Application
   form fields. Feature 003 (scan-for-repos) discovers candidates but doesn't
   automate the import — operator still hand-fills the form. A "Migrate this app
   to dashboard management" flow would close the gap from discovery to managed.

This spec collects the six fixes into one coherent operational-maturity push.

## User Scenarios & Testing

### User Story 1 — Operator onboards a brand-new app via the Bootstrap wizard (Priority: P1)

As a dashboard admin onboarding a fresh app, I want to click "Bootstrap from GitHub"
on the Server detail view and have the dashboard guide me through repo selection,
detection, configuration, and first deploy — so I never SSH into the target to
mkdir or git clone manually.

**Acceptance**:

- The Server detail view's Apps tab has a "Bootstrap from GitHub" button next to
  the existing "Add Application" and "Scan Server" buttons.
- Clicking opens the feature 009 wizard (already implemented per spec 009 FR-001..033).
- The wizard's state machine (CLONING → COMPOSE_UP → HEALTHCHECK → PROXY_APPLIED →
  CERT_ISSUED → ACTIVE) drives the on-screen progress, with live tail of the
  detached run via the file-tail modal (incident 2026-05-02 fix).
- Completing the wizard leaves a fully managed app row + cloned repo + running
  containers + (optional) attached domain with cert.
- The operator never opens a terminal during bootstrap.

### User Story 2 — Inject a database migration step before deploy (Priority: P1)

As a project maintainer running an app with a Drizzle / Prisma / Rails / Django
schema, I want to register a `pre_deploy_script_path` that runs migrations between
git pull and compose-up, so I get the migration safety of feature 007's full
script-replace WITHOUT rewriting the entire deploy logic.

**Acceptance**:

- Edit Application form has new optional fields: `Pre-deploy hook`, `Post-deploy
  hook`, `On-fail hook`, `Pre-destroy hook`. Each a relative path (same FR-003
  validation as feature 007's `scriptPath`).
- When `pre_deploy_script_path` is set, the runner invokes
  `bash <appDir>/<pre_deploy>` after `git fetch+reset` but before `docker compose up -d`.
- Hook script exit non-zero aborts deploy with status `failed` and surfaces the
  hook's stderr in the log viewer.
- Hook receives same env exports as builtin deploy (`APP_DIR`, `BRANCH`, `COMMIT`,
  any `SECRET_*` from `applications.envVars`).
- Apps with NO hooks set behave exactly as today (backward-compat).
- `post_deploy` runs after compose-up succeeds (smoke tests, cache warm, webhook
  notify). Failure here marks deploy `failed` but does NOT roll back compose
  changes — explicit choice (operator's hook can do its own rollback if desired).
- `on_fail` runs only when any earlier step fails (cleanup, alert webhook, slack
  notify). Failure of `on_fail` itself is logged at warn level, not crashed up.
- `pre_destroy` runs before hard-delete (db dump, cache flush) per feature 008's
  hard-delete flow + feature 009's bootstrap hard-delete.

### User Story 3 — Unified failure card across deploy / bootstrap / health / cert (Priority: P1)

As a dashboard admin diagnosing a broken state in any feature, I want one
consistent "what went wrong + what to do next" card that surfaces in all failure
contexts, so my recovery muscle memory transfers between deploy, bootstrap,
health, and cert errors.

**Acceptance**:

- New `<FailureCard>` component accepts: `state` (failed_clone, failed_compose,
  failed_healthcheck, failed_proxy, failed_cert, deploy_timeout, cert_rate_limited,
  caddy_unreachable, http_probe_blocked, etc), `summary` (one-line human),
  `details` (full error message, log excerpt, stack trace if relevant), `actions`
  (array of `{label, href|onClick}`).
- DeployLog renders FailureCard when job ends `failed` instead of current red banner.
- BootstrapStateBadge expands to show FailureCard when state matches `failed_*`.
- DomainTlsSection renders FailureCard when cert status is `failed` / `rate_limited` /
  `pending_reconcile`.
- Health probe failure tooltip on app dot links to FailureCard rendered in app
  detail view.
- Common action vocabulary: "Retry", "Edit Config", "View full log", "Hard Delete".
  Each context populates the relevant subset.
- Visual style consistent: red border, status icon, summary above details, action
  bar at bottom right.

### User Story 4 — Pre-flight cross-server domain conflict report (Priority: P2)

As an admin attaching a domain, I want a concrete list of "domain X is already
used by app Y on server Z" before I confirm — so the warning is actionable, not
hand-wavy.

**Acceptance**:

- When the Domain edit dialog detects cross-server conflict (per spec 008 FR-001a),
  it renders an inline panel listing each conflicting `(serverLabel, appName,
  appDomain, certStatus)` tuple with deeplink to the conflicting app's detail
  view.
- The "Try anyway" checkbox is replaced with a typed-confirmation field requiring
  the operator to type the domain name to confirm intent (mirrors feature 008
  FR-027 hard-delete pattern).
- DNS pre-check result and conflict report shown side-by-side — operator can see
  "DNS resolves to gcloud server (correct), but app `foo` on ai-twins server also
  has this domain attached" and decide.
- Same-server collision (per spec 008 FR-001) remains hard-blocked at DB level —
  no UI flow because it's structurally impossible.

### User Story 5 — Browse audit log via UI with faceted filters (Priority: P2)

As an operator investigating a post-incident "who changed what when", I want a
dedicated Audit Log page with filters (actor, resource, action, time range) so
I never drop to SQL for forensics.

**Acceptance**:

- New sidebar entry "Audit Log" → `/audit` route.
- Page shows reverse-chronological list of `audit_entries` with columns:
  Timestamp, Actor (user email), Action (verb), Resource (type + id + label),
  Details (JSON or short summary).
- Filter sidebar: Actor (multi-select), Action (multi-select dropdown of seen
  actions), Resource type (Server / Application / Cert / Bootstrap), Time range
  (last 1h, 24h, 7d, 30d, custom).
- URL query state is filter state — bookmarkable / shareable forensic queries.
- Pagination at 100 rows per page.
- Each row's "Resource" cell links to the resource detail (if app/server) or
  shows redacted reference (if deleted).
- Export CSV button — current filtered view dumped for offline analysis.

### User Story 6 — Convert a manually-configured legacy app to dashboard-managed (Priority: P3)

As an operator with apps that pre-date dashboard adoption, I want a "Migrate this
app to dashboard management" flow that takes path / repo URL / compose location
and creates the row + scan baseline + initial health probe — so I don't reverse-
engineer my own ops setup into form fields.

**Acceptance**:

- New "Migrate Existing App" button on Server detail view's Apps tab (next to
  "Bootstrap from GitHub", "Add Application", "Scan Server").
- Wizard prompts for: target path on host (autocompleted from `scan` results
  if available), expected compose file name, optional health URL, optional
  domain.
- Backend validates target exists (SSH `test -d`), reads `git remote get-url
  origin` if .git present (auto-fills `repo_url`), inspects compose for
  upstream service detection (reuses feature 009 compose parser logic).
- On submit: creates app row with `created_via = 'migrate'` (new enum value
  on `applications.created_via`), runs first health probe, optionally triggers
  Caddy reconcile if domain provided.
- Migration emits an audit entry with full snapshot of detected state, useful
  for rollback or "what was this app like before we adopted it" forensics.

## Edge Cases

### US1 (Bootstrap UI integration)

- **Wizard mounted but feature 009 backend incomplete**: bootstrap state machine
  shipped per spec 009 plan, but `bootstrap-orchestrator.ts` may not be wired to
  ALL phase transitions. Mounting the UI surfaces this — symptom: wizard stuck on
  CLONING. Mitigation: smoke-test full wizard end-to-end before mount; checklist
  each state machine transition has a corresponding orchestrator action.

### US2 (Per-app lifecycle hooks)

- **Hook script doesn't exist on target**: dispatched `bash <appDir>/<hookPath>`
  exits 127 with "No such file". Treated as hook failure (no special pre-flight
  per feature 007 R-005 pattern).
- **Hook hangs**: same 30-min runner timeout as builtin deploy. No per-hook
  timeout override in v1 (operator can edit script to add internal `timeout`).
- **Multiple hooks fire on same deploy**: `pre_deploy` runs before deploy proper;
  `post_deploy` after success; `on_fail` only on any earlier failure. NEVER
  multiple hooks fire from the same dispatch — strict ordering.
- **Hook tries to invoke another hook**: scripts can shell out to whatever they
  want; dashboard does not enforce hook-purity. Operator's responsibility.
- **Hook needs different env than deploy**: not supported in v1. All hooks share
  the deploy's env exports. Per-hook env override is v2.
- **`pre_destroy` script disappears after Edit form save** (operator deleted
  it from repo, or syntax error): hard-delete fails with
  `pre_destroy_hook_failed`. Recovery FailureCard renders with `Retry` +
  `ForceDelete` actions per FR-010 — operator chooses to fix the hook
  and retry, OR bypass it with explicit force decision (audited).
  Without this, an app could become permanently undeletable.
- **`on_fail` hook receives no failure context**: closed by FR-011
  extension — `FAIL_PHASE` + `FAIL_EXIT_CODE` env vars provided so
  alert scripts route by phase ("compose_up vs pre_deploy failure"
  matters for triage).
- **Atomic switch from `script_path` to hooks**: operator clears
  `script_path` AND populates hook fields in same PATCH per FR-013
  clarification. CHECK constraint validates final row state, not
  intermediate. UI button "Switch from script_path to hooks" pre-fills
  the pending PATCH for one-click migration.

### US3 (Failure card unification)

- **Failure with no actionable recovery** (e.g. permanent rate-limit): FailureCard
  shows summary + details + a single "View full log" action. Empty action array
  is valid input.
- **Multiple failure causes simultaneously** (e.g. compose failed AND cert failed):
  primary failure surfaces; secondary failures listed in details. UI doesn't
  stack multiple FailureCards.
- **Recovery action requires multi-step** (e.g. "Edit Config + Retry"): action
  navigates to edit form with retry intent persisted in URL state, then deploys
  on save.

### US4 (Cross-server domain conflicts)

- **Conflict resolves while operator is mid-confirm**: conflicting app's domain
  cleared by another operator between dialog open and submit. Submit re-checks
  conflict at write time; if resolved, proceeds without prompting again.
- **Soft-deleted apps with the same domain**: excluded from conflict list (per
  feature 008 — soft-deleted apps free their domain UNIQUE slot via NULL).

### US5 (Audit log UI)

- **Audit entries reference a deleted resource** (app hard-deleted): row shows
  resource ID + last-known label as plain text, no link.
- **Massive query result** (operator selects "all time, all actors"): page-size
  cap at 100 + pagination. Backend caps at 10000 total to prevent OOM.
  Response carries `isCapped: boolean` so UI can render "≥10000 results
  — narrow the filter" instead of misleading "exactly 10000".
- **Sensitive data in audit `details` JSON** (e.g. domain change with new value):
  rendered as JSON tree; secrets already redacted at write time per
  `auditMiddleware` policy.
- **CSV export interrupted mid-stream** (operator closes browser tab):
  Express request fires `close` event; the streaming loop MUST listen
  and abort the cursor pagination at the next iteration to release the
  DB connection promptly. Without this listener the loop runs to
  10,000-row cap regardless, hogging the connection.
- **Audit `resource_type='other'`**: when the resource doesn't fit
  server/application/cert/bootstrap (e.g. settings changes,
  cross-feature events), `resource_type='other'` is valid. Filter UI
  exposes this value as a selectable option (was missing in earlier
  draft).

### US6 (Legacy app migration)

- **Path exists but is not a git repo**: wizard accepts (operator's choice); app
  row created with `repo_url = null` or `repo_url = 'docker://<path>'` + scan-
  docker mode (feature 003 pattern).
- **Path exists but compose file missing**: wizard surfaces error with feature
  009-style "set Compose Path manually" hint.
- **Path conflict with already-managed app**: wizard rejects with link to the
  existing app's detail view, UNLESS the existing row has
  `created_via='scan'` — see PATCH-promote handling below.
- **Path matches existing scan-imported row** (`created_via='scan'`):
  wizard switches to **augment existing** mode per Session 2026-05-05
  clarification — pre-fills detected fields (repo URL, compose path),
  operator enters missing fields, submit PATCHes the existing row
  rather than INSERTing a new one. `created_via` is preserved as
  `'scan'` (origin metadata kept). Audit `app.migrated_from_scan` with
  the snapshot of added fields.
- **Path-jail violation** (operator types `/etc`, `/var/log`, `/`,
  `/home/deploy/.ssh`, etc.): migration toolkit MUST validate the
  resolved path is within an allowlisted root (default `/opt`,
  `/srv`, `/var/www`, `/home/deploy/apps` per scan_roots config).
  Reuses feature 009's `path-jail.ts` `realpath` check before
  accepting the path. Violation → 422 `target_path_jail_violation`.
  Without this, "Migrate" + later "Hard Delete" could `rm -rf /etc`
  and brick the host.
- **Scan-row PATCH-promote on a row with existing `script_path`**:
  scan-imported rows shouldn't have `script_path` set, but if they
  somehow do (operator hand-edited), the migration wizard MUST NOT
  collect hooks from the operator (per FR-012 — hooks are
  EditAppForm-only). PATCH-promote populates only US6-scope fields
  (health URL, domain). To add hooks, operator opens Edit
  Application after promotion completes.
- **Bootstrap or migrate sets `domain` AND triggers cross-server
  conflict**: typed-confirm REQUIRED in the same wizard flow per
  Session 2026-05-05 clarification. Wizard runs cross-server check
  at submit; conflicts present → wizard surfaces conflict panel +
  typed-confirm input + Save disabled until exact match. No
  "we'll catch it later in Edit Domain" — invariant lives at
  every domain entry point.

## Functional Requirements

### US1 — Bootstrap UI integration

- **FR-001**: Server detail view's Apps tab MUST render a "Bootstrap from GitHub"
  button alongside existing "Add Application" and "Scan Server" buttons.
- **FR-002**: Clicking the button MUST open the BootstrapWizard component
  implemented per spec 009 plan.md §UI.
- **FR-003**: The wizard MUST integrate with the file-tail modal (post-incident
  2026-05-02 fix) for live remote-log streaming during the detached deploy phase.
- **FR-004**: Successful completion MUST refresh the Apps list to show the new
  app row immediately (no manual refresh).
- **FR-005**: A smoke test MUST exist exercising the wizard end-to-end against
  mocked SSH + GitHub API (`tests/integration/bootstrap-wizard-flow.test.ts`).

### US2 — Per-app lifecycle hooks

- **FR-006**: The `applications` table MUST gain four optional TEXT columns:
  `pre_deploy_script_path`, `post_deploy_script_path`, `on_fail_script_path`,
  `pre_destroy_script_path`. Each subject to the same NULL-normalisation +
  validation rules as feature 007's `scriptPath` (FR-003 in spec 007).
- **FR-007**: The deploy runner MUST invoke `pre_deploy` (if set) AFTER git
  fetch+reset, BEFORE `docker compose up -d`. Non-zero exit aborts deploy.
- **FR-008**: The deploy runner MUST invoke `post_deploy` (if set) AFTER
  successful compose-up. Non-zero exit marks deploy `failed` but does NOT roll
  back compose state.
- **FR-009**: The deploy runner MUST invoke `on_fail` (if set) when any earlier
  step fails. `on_fail` failure logged at warn, never propagated.
- **FR-010**: The hard-delete flows (feature 008 FR-018, feature 009 FR-021)
  MUST invoke `pre_destroy` (if set) BEFORE compose-down + rm. When the
  hook fails (any non-zero exit including 127 for missing script), the
  hard-delete MUST abort with `pre_destroy_hook_failed` and surface a
  recovery FailureCard with two actions: `Retry` (re-runs hook) and
  `ForceDelete` (bypasses hook with `?force=true`, audited separately
  as `app.hard_deleted_force_bypass`). Closes the bricked-app risk per
  Session 2026-05-05 review.
- **FR-011**: All hook scripts MUST receive the same env exports as builtin
  deploy (`APP_DIR`, `BRANCH`, `COMMIT`, `SECRET_*`). The `on_fail` hook
  MUST additionally receive `FAIL_PHASE` (one of `git_fetch`, `pre_deploy`,
  `compose_up`, `post_deploy`) and `FAIL_EXIT_CODE` (integer) so alert
  scripts can route by failure category instead of treating every failure
  as a generic "deploy failed" signal. Per Session 2026-05-05 review.
- **FR-012**: Edit Application form MUST surface all four hook fields under a
  collapsible "Lifecycle Hooks" section (collapsed by default to keep simple
  apps' UI clean). **Hooks are NOT exposed in BootstrapWizard or
  MigrateExistingAppWizard** per Session 2026-05-05 review — operator
  configures hooks in a separate post-create step, keeping FR-013a
  invariant simple to enforce.
- **FR-013**: Hook validation MUST occur at form-write, API-route, and runner
  layers (defence-in-depth pattern from feature 007). The form MUST allow
  clearing `script_path` AND populating hook fields in a single atomic
  PATCH submission — operators do not need a two-step "clear, save, set,
  save" UX (per Session 2026-05-05 review).
- **FR-013a**: All three validation layers MUST enforce mutual exclusion
  with feature 007's `script_path`: if `script_path` is non-NULL, all
  four hook columns MUST be NULL (and vice versa). Violation surfaces
  as: form Save disabled with inline error; API returns 400
  `script_path_hooks_mutually_exclusive`; runner refuses dispatch with
  same error code (defends against direct DB writes that bypass the
  route layer).

### US3 — Failure card unification

- **FR-014**: New `FailureCard` component MUST be implemented with typed prop
  contract:
  ```ts
  type FailureAction =
    | { kind: "Retry"; href?: string; onClick?: () => void }
    | { kind: "RetryFromFailedStep"; fromStep: string; href?: string; onClick?: () => void }
    | { kind: "EditConfig"; href: string }
    | { kind: "ViewLog"; href: string }
    | { kind: "HardDelete"; onClick: () => void }
    | { kind: "ForceRenew"; onClick: () => void }
    | { kind: "Revoke"; onClick: () => void }
    | { kind: "Custom"; label: string; href?: string; onClick?: () => void };

  interface FailureCardProps {
    state: string;          // context-specific state token, e.g. "failed_clone"
    summary: string;
    details?: ReactNode;
    actions?: FailureAction[];
  }
  ```
  The `kind` discriminator is the canonical lexicon — UI maps each kind
  to a fixed display label + icon, ensuring vocabulary uniformity across
  contexts (SC-003). `Custom` is reserved for genuine one-off actions
  with no canonical equivalent.
- **FR-015**: DeployLog MUST replace its current red banner with FailureCard
  when job status is `failed`. Action set: `Retry`, `ViewLog`, optionally
  `EditConfig` (if app has editable params relevant to failure).
- **FR-016**: BootstrapStateBadge MUST expand to FailureCard when state matches
  `failed_*`. Action set: `RetryFromFailedStep` (with `fromStep` carrying
  the bootstrap state name from spec 009), `EditConfig`, `HardDelete`.
- **FR-017**: DomainTlsSection MUST render FailureCard for cert status
  `failed` / `rate_limited` / `pending_reconcile`. Action set:
  `ForceRenew`, `EditConfig` (domain edit). `Revoke` is NOT included —
  it lives on the normal cert-management UI rendered when cert status
  is `active` (per Session 2026-05-05 review-pass clarification —
  removes the FR-017 self-contradiction).
- **FR-018**: A common visual style guide MUST be documented for FailureCard
  (red-border container, icon by severity, summary as h3-equivalent, details
  in monospace pre or markdown, actions as button row).

### US4 — Cross-server domain conflicts

- **FR-019**: The domain edit dialog MUST query
  `GET /api/applications/cross-server-domain-check?domain=<domain>&excludeAppId=<self>`
  on submit. Endpoint returns `[{ serverId, serverLabel, appId, appName, domain,
  certStatus }]`.
- **FR-020**: When the response is non-empty, the dialog MUST render a panel
  listing each conflict with deeplink to the app, replacing the current
  ad-hoc "Try anyway" checkbox.
- **FR-021**: Confirmation MUST require typing the domain name (mirror feature
  008 FR-027 pattern). Empty or mismatched input disables the confirm button.

### US5 — Audit log UI

- **FR-022**: New route `/audit` MUST render a page with reverse-chronological
  list of `audit_entries`.
- **FR-023**: Filter sidebar MUST support: Actor (multi-select from distinct
  values), Action (multi-select), Resource type (enum), Time range (presets +
  custom).
- **FR-024**: Filter state MUST sync to URL query params. Bookmarkable.
- **FR-025**: Backend endpoint `GET /api/audit?actor[]=&action[]=&resource_type=
  &since=&until=&page=&page_size=` MUST return paginated results with total
  count. Page size capped at 100, total result cap at 10000.
- **FR-026**: Resource cell MUST link to detail view if resource still exists,
  else render label + ID as plain text.
- **FR-027**: "Export CSV" button MUST stream the current filtered query (up to
  10000 rows) as `audit-<timestamp>.csv`.

### US6 — Legacy app migration toolkit

- **FR-028**: New "Migrate Existing App" button on Server detail view (next to
  Bootstrap / Add / Scan).
- **FR-029**: Wizard input: target path (autocompleted from feature 003 scan
  results), compose file name, optional health URL, optional domain.
- **FR-030**: Backend validates path exists via SSH `test -d`, reads
  `remote.origin.url` if `.git` present.
- **FR-031**: Compose detection MUST reuse feature 009's compose parser
  (FR-004 in spec 009).
- **FR-032**: New enum value `migrate` MUST be added to `applications.created_via`.
- **FR-033**: Migration MUST emit an audit entry with full snapshot of detected
  state for forensics.
- **FR-033a**: When the wizard detects an existing
  `(server_id, target_path)` row with `created_via='scan'`, it MUST
  switch to "augment existing" mode: PATCH the existing row with the
  collected fields (health URL, domain, hooks, etc), preserve
  `created_via='scan'`, and emit audit action `app.migrated_from_scan`
  carrying the diff (`addedFields: string[]`). INSERT path is taken
  ONLY when no matching row exists. Active rows with any other
  `created_via` value (`'manual'`, `'bootstrap'`, `'migrate'`) still
  trigger reject per US6 edge case "Path conflict with already-managed
  app".

## Success Criteria

- **SC-001 (US1)**: Operator onboards a brand-new app in ≤ 5 clicks (Bootstrap →
  pick repo → confirm detection → optional domain → submit) without opening a
  terminal. Validated by recording onboarding flow on first 10 production
  bootstraps.
- **SC-002 (US2)**: At least 3 production apps adopt at least one lifecycle hook
  within 30 days post-rollout, replacing custom forks of `server-deploy.sh`.
- **SC-003 (US3)**: User survey of operators shows uniform recovery action
  vocabulary across deploy/bootstrap/cert failure contexts. No "I didn't know
  there was a Retry button there" reports.
- **SC-004 (US4)**: Zero accidental cross-server HA domain attachments in 30
  days post-rollout. Validated by audit log review of `domain_change` events
  followed by quick reversal.
- **SC-005 (US5)**: Median time from "incident reported" to "audit query
  reveals responsible action" drops from manual-SSH-psql baseline to UI-faceted
  filter time (target ≤ 60 seconds).
- **SC-006 (US6)**: 100% of currently-manually-configured apps on production
  servers can be migrated via the toolkit (target: zero apps requiring fallback
  to manual `INSERT INTO applications`).

## Key Entities

### `applications` (modified — new columns)

US2:
- `pre_deploy_script_path TEXT NULL`
- `post_deploy_script_path TEXT NULL`
- `on_fail_script_path TEXT NULL`
- `pre_destroy_script_path TEXT NULL`

Each subject to feature 007's `script_path` validation regex + NULL normalisation.

US6:
- Extend `created_via` enum: `'manual' | 'scan' | 'bootstrap' | 'migrate'`.

### `audit_entries` (existing — UI consumer)

US5: no schema changes. UI reads existing columns.

## Assumptions

- A-001 (US1): feature 009 BootstrapWizard component is structurally complete per
  spec 009 plan; integration is purely "mount it in AppsTab".
- A-002 (US2): builtin `server-deploy.sh` is the dispatch path for hook injection;
  feature 007's `script_path` (full replacement) bypasses hooks. Operator picks
  one model per app — **enforced as invariant per FR-013a**, not just an
  operator-discipline assumption.
- A-003 (US3): existing failure surfaces are loosely-coupled; replacement is
  drop-in not refactor.
- A-004 (US5): `audit_entries` table is populated correctly today (per feature
  001's auditMiddleware). UI just reads it.
- A-005 (US6): feature 003's scan-for-repos discovers candidates; migration
  toolkit reuses scan output for autocomplete.

## Dependencies

- **Feature 001** (devops-app): `auditMiddleware`, `audit_entries` table, base
  schema (US5).
- **Feature 003** (scan-for-repos): scan candidate list for migration autocomplete
  (US6).
- **Feature 005** (script-runner): manifest dispatch + secret transport for hooks
  (US2).
- **Feature 007** (project-local-deploy): `script_path` validation pattern reused
  for hook paths (US2). Mutual-exclusion contract: if `script_path` set, hooks
  ignored (full-replace wins).
- **Feature 008** (domain-and-tls): hard-delete flow integration with `pre_destroy`
  hook (US2); cross-server check existing endpoint extension (US4).
- **Feature 009** (bootstrap-deploy): wizard mount target (US1); compose parser
  reuse (US6); hard-delete with `pre_destroy` (US2).

## Out of Scope

- Per-hook env override (v2 — operator can edit script to set env internally).
- Per-hook timeout override (v2 — same workaround).
- Audit log full-text search (v2 — faceted filtering covers v1 needs).
- Audit log retention policy beyond existing prune (v2 — current prune sufficient).
- Migration toolkit for cross-server moves (v2 — current scope is "outside-dashboard
  → managed", not "server A → server B").
- "Hook templates" / hook marketplace (v3 — once usage data shows demand).
- Bulk-edit UI for hooks across multiple apps (v2 — single-app edit form sufficient v1).
- Audit log alerting on suspicious patterns (v3 — observability concern, not UI).

## Related

- Spec 003 `/specs/003-scan-for-repos/spec.md`: feeds migration toolkit.
- Spec 007 `/specs/007-project-local-deploy/spec.md`: defines `script_path` validation
  pattern reused for hooks.
- Spec 008 `/specs/008-application-domain-and-tls/spec.md`: defines hard-delete flow
  + cross-server warning extended in US4.
- Spec 009 `/specs/009-bootstrap-deploy-from-repo/spec.md`: provides the wizard mounted
  in US1; provides compose parser reused in US6.
- Incident 2026-05-02: surfaced US1 + US3 + US6 gaps in operational narrative.
- CLAUDE.md rule 5 (no direct migrations): schema additions for US2 + US6 ship as
  reviewable SQL.

## Open Questions

- ~~OQ-001 (US2)~~: **RESOLVED** in Session 2026-05-05 — hard reject at
  form-write/API/runner per FR-013a.
- ~~OQ-002 (US3)~~: **RESOLVED** in Session 2026-05-05 — explicit
  `RetryFromFailedStep` first-class action variant in the typed enum
  per FR-014, distinct from full-restart `Retry`.
- ~~OQ-003 (US5)~~: **RESOLVED** in Session 2026-05-05 review pass —
  flat rows with `details_json` as a single column (one CSV row per
  audit entry, JSON-stringified details). Per `contracts/api.md` § CSV
  export shape. Expanded one-row-per-detail-key deferred to v2 if
  operator demand surfaces.
- OQ-004 (US6): migration toolkit and Bootstrap wizard share UX surface area;
  could be unified into one "Add app" entry-point with branching paths (Bootstrap
  / Migrate / Manual). Defer to design phase.
