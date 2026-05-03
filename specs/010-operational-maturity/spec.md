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
- **Sensitive data in audit `details` JSON** (e.g. domain change with new value):
  rendered as JSON tree; secrets already redacted at write time per
  `auditMiddleware` policy.

### US6 (Legacy app migration)

- **Path exists but is not a git repo**: wizard accepts (operator's choice); app
  row created with `repo_url = null` or `repo_url = 'docker://<path>'` + scan-
  docker mode (feature 003 pattern).
- **Path exists but compose file missing**: wizard surfaces error with feature
  009-style "set Compose Path manually" hint.
- **Path conflict with already-managed app**: wizard rejects with link to the
  existing app's detail view.

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
  MUST invoke `pre_destroy` (if set) BEFORE compose-down + rm.
- **FR-011**: All hook scripts MUST receive same env exports as builtin deploy
  (APP_DIR, BRANCH, COMMIT, SECRET_*).
- **FR-012**: Edit Application form MUST surface all four hook fields under a
  collapsible "Lifecycle Hooks" section (collapsed by default to keep simple
  apps' UI clean).
- **FR-013**: Hook validation MUST occur at form-write, API-route, and runner
  layers (defence-in-depth pattern from feature 007).

### US3 — Failure card unification

- **FR-014**: New `FailureCard` component MUST be implemented with typed prop
  contract `{ state: string; summary: string; details?: ReactNode; actions?:
  Array<{ label: string; href?: string; onClick?: () => void }> }`.
- **FR-015**: DeployLog MUST replace its current red banner with FailureCard
  when job status is `failed`. Action set: ["Retry", "View full log",
  "Edit Config" (if app has editable params relevant to failure)].
- **FR-016**: BootstrapStateBadge MUST expand to FailureCard when state matches
  `failed_*`. Action set per spec 009 FR-019..021.
- **FR-017**: DomainTlsSection MUST render FailureCard for cert status
  `failed` / `rate_limited` / `pending_reconcile`. Action set: ["Force renew",
  "Edit domain", "Revoke" (if active)].
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
  one model per app.
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

- OQ-001 (US2): hook ordering when both `script_path` (full replace) AND hooks set
  — error at form-write or silent ignore? Current spec assumes mutual exclusion;
  needs UI guard wording finalised.
- OQ-002 (US3): `FailureCard` action for "Retry from failed step" vs "Retry from
  scratch" — should the action explicitly distinguish, or is implicit "from failed
  step" sufficient? Bootstrap wizard already has both; deploy doesn't.
- OQ-003 (US5): export CSV format — flat rows with JSON-stringified details, or
  expanded one-row-per-detail-key? Defer to first user request.
- OQ-004 (US6): migration toolkit and Bootstrap wizard share UX surface area;
  could be unified into one "Add app" entry-point with branching paths (Bootstrap
  / Migrate / Manual). Defer to design phase.
