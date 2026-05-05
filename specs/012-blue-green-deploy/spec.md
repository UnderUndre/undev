# Feature Specification: Blue/Green Deploy with Connection Drain

**Version**: 1.0 | **Status**: Draft | **Date**: 2026-05-05

> **Sequence note**: 011 (zero-touch-onboarding) reserves `0010_zero_touch.sql`,
> 010 (operational-maturity) reserves `0011_operational_maturity.sql`. This
> feature reserves `0012_blue_green_deploy.sql`.

> **Spec 005 contract lift**: feature 005 explicitly declared "no blue-green /
> canary / staged-rollout logic built on top of the runner. Scripts are
> one-shot." This feature lifts that limitation — adding a SECOND deploy
> strategy alongside the existing recreate-in-place flow. Recreate strategy
> remains default + unchanged for backwards compatibility.

## Clarifications

### Session 2026-05-05

- Q: Phase token naming convention — color-specific (GREEN_STARTING etc),
  color-specific with dynamic interpretation, sticky-rename ritual, neutral
  role tokens, or A/B slot labels? → A: **Neutral role tokens with sticky
  slot naming**. Phase tokens use role-based names independent of which
  colour is currently active: `CANDIDATE_STARTING`, `CANDIDATE_HEALTHY`,
  `SWITCHING`, `OUTGOING_DRAINING`, `OUTGOING_STOPPED`, `ACTIVE`. Failure
  variants: `FAILED_CANDIDATE_HEALTHCHECK`, `FAILED_SWITCH`,
  `FAILED_DRAIN_ABORT`, `FAILED_CADDY_ADMIN_POST_SWITCH`. Container names
  remain sticky per slot — `<service>-blue` and `<service>-green` are
  permanent names; the slot opposite to current `active_color` is the
  candidate this deploy. `active_color` toggles AFTER successful
  `OUTGOING_STOPPED → ACTIVE` transition. No container rename mid-deploy
  (rename is fragile in compose) — slot containers exist forever, just
  one is running at any time when not mid-deploy.

  First blue/green deploy on an app that was previously `recreate`: the
  existing single container is renamed (`docker rename` — metadata only,
  zero downtime) to `<service>-blue` and `active_color` set to `'blue'`
  during deploy initialization. Candidate then spawns as `<service>-green`.
  Subsequent deploys alternate. This single rename is the only ritual
  rename in the lifetime; after it, names are sticky.
- Q: Volume sharing during the drain window — allow with warning, block
  blue/green for volume-using apps, per-color volume copy, or defer? →
  A: **Allow shared volumes with PATCH-time warning + operator checkbox
  acknowledgement**. During `OUTGOING_DRAINING`, both outgoing and
  candidate containers run in parallel and share whatever `volumes:` the
  compose service declares. PATCH `/api/applications/:id` setting
  `deploy_strategy='blue_green'` MUST detect presence of `volumes:` in
  the app's compose service definition and require an explicit operator
  acknowledgement (`acknowledgeVolumeSharing: true` field in the
  request). UI surfaces a hint listing volume-category safety:
  > "Both containers share volumes during the drain window. Logs and
  > append-only files are safe. Unique-path uploads are safe. Database
  > files / shared state files RISK CORRUPTION — those services must
  > stay 'recreate'."

  Volume-corruption risk is operator's call (target audience is
  sophisticated devops). Hard-blocking all volume apps (option B) would
  exclude legitimate uses like logs-volume web services; per-color
  volume namespace (option C) would break data continuity for
  uploaded-files apps.

- Q: Caddy admin API failure AFTER successful switch — dedicated FailureCard
  with manual recovery, auto-reconciliation, alert-only, or auto-fail-safe
  rollback? → A: **Dedicated FailureCard with manual recovery actions
  + drain pauses + critical TG alert**. When Caddy admin API drops AFTER
  the switch was committed (during OUTGOING_DRAINING), deploy enters
  `FAILED_CADDY_ADMIN_POST_SWITCH` phase. Drain timer PAUSES (no
  auto-stop of outgoing). FailureCard renders with state
  `caddy_admin_failure_post_switch` and three actions: `Retry healthcheck`
  (re-pings Caddy admin endpoint), `View last-known config` (shows the
  config that dashboard committed at SWITCHING), `Mark recovered`
  (operator confirms — typed acknowledgement — that they verified Caddy
  is correctly routing externally; dashboard resumes drain countdown
  from where it paused). Audit `deploy.caddy_admin_failure_post_switch`
  emitted with full context (last-known config, ping failure stack).
  Alert fires via notification gate as critical-class. No
  auto-reconciliation: if Caddy was mid-config-write when API dropped,
  the actual state may differ from what dashboard committed; only
  human external verification is safe.

- Q: SC-001's 5% gap — sub-second-drops-imperceptible, catastrophic-only,
  visible-drops-up-to-N, or drop entirely? → A: **Catastrophic failures
  only**. The 5% reserves for infrastructure-level failures outside the
  feature's control: Caddy crash mid-switch, dashboard OOM, network
  partition between dashboard and Caddy admin endpoint, host-level
  resource exhaustion. Sub-100ms Caddy reload gaps (atomic config-replace
  has microsecond-class race window) DO NOT count as "drops" — they're
  imperceptible to operators (no user perception, no application-side
  exception). Any user-visible drop >100ms during normal deploy is a
  BUG, not "expected 5%". Test gate: integration test fires request-flood
  during a normal deploy, expects 100% completion. Catastrophic-failure
  injection tests (e.g. kill-Caddy-mid-switch) allowed to fail SC-001
  but MUST fail GRACEFULLY — that path goes through
  `caddy_admin_failure_post_switch` recovery flow per Q3.

- Q: Dashboard restart mid-deploy — auto-resume, auto-fail, manual
  decision per row, or defer? → A: **Manual decision per row via
  "Interrupted deploys" panel on dashboard boot**. On boot, scan rows
  with non-NULL `deploy_state`; surface a panel listing affected apps
  with their last-known phase, candidate container state (running?
  exited?), and `active_color` at time of interrupt. Per row, operator
  chooses: `Resume from <phase>` (dashboard re-enters the state machine
  at that phase, with sanity-check probes first), `Abort and clean up
  candidate` (force-stop + remove candidate; outgoing remains active),
  `Mark complete` (typed-confirm — operator externally verified state
  matches intent; clears `deploy_state` to NULL, sets `active_color`
  per their input). FailureCard state token `deploy_interrupted_by_restart`
  added to feature 010 lexicon. Auto-resume (option A) is unsafe —
  SWITCHING / OUTGOING_DRAINING phases have ambiguous external state
  after crash. Auto-fail (option B) loses near-complete deploys
  (e.g. drain at 28/30 seconds). Manual choice matches the Caddy-admin
  failure pattern: no magic when state is uncertain.

## Problem Statement

Current deploy flow is `docker compose up -d` against the existing service
definition: compose recreates containers in place. Active HTTP connections
during recreate are dropped — uploads fail mid-stream, long-poll requests
time out, websockets cut. For services where any operator-visible request
takes more than a few seconds (file upload, batch job submission, large
DB query proxy), this is a steady stream of "deploy broke my user" tickets.

Operators want a graceful traffic switch:

1. Start a new container in parallel with the old one.
2. Wait for new container's healthcheck to pass.
3. Switch reverse-proxy upstream from old to new — atomically, without dropped requests.
4. Wait a **drain window** (operator-configurable, default 30s): in-flight
   requests on old container complete on their own; new requests go to new.
5. Stop old container.

This is an established deploy pattern (often called "blue/green") — but
needs reverse-proxy support (admin API for upstream switch), single-replica
service constraint (multiple parallel replicas → state corruption risk for
non-stateless services), and explicit operator opt-in per app (stateful
services like databases must NOT run two replicas at once).

## User Scenarios & Testing

### User Story 1 — Configure deploy strategy and drain settings (Priority: P1)

As an operator deploying a stateless web service, I want to switch its
deploy strategy from default `recreate` to `blue_green` and tune the
drain window + green healthcheck timeout. I want this option DISABLED in
the UI for apps that aren't behind Caddy reverse proxy, so I can't
accidentally configure something that won't work.

**Acceptance**:

- Edit Application form has a new "Deploy Strategy" section with three controls:
  - **Strategy** dropdown: `recreate` (default, current behaviour) or `blue_green`.
  - **Drain window** integer input (seconds): default 30, min 0, max 600.
  - **Green healthcheck timeout** integer input (seconds): default 60, min 10, max 1800.
- `blue_green` option is DISABLED in the dropdown when `proxy_type != 'caddy'`.
  Tooltip explains: "Blue/green requires Caddy reverse proxy for atomic upstream switch."
- Save persists; audit `app.deploy_strategy_changed` emitted.
- A hint near the dropdown reads: "Blue/green requires single-replica
  stateless services. Stateful services (databases) MUST stay 'recreate'."
- When app's compose declares `volumes:`, an additional acknowledgement
  panel appears between strategy dropdown and Save: lists detected
  volume mounts, displays the safety-categories hint (logs/uploads OK;
  database state NOT OK), and requires operator to tick a checkbox "I
  understand both containers share these volumes during drain". Save
  disabled until checked. Per FR-008a (acknowledgeVolumeSharing).

### User Story 2 — Deploy executes blue/green flow (Priority: P1)

As an operator deploying an app with `deploy_strategy='blue_green'`, I
trigger Deploy as usual; the dashboard runs the new flow that starts a
new container, waits healthy, switches traffic, drains, stops old. Live
multi-phase progress shown in DeployLog.

**Acceptance**:

- Deploy on a `blue_green` app surfaces sequential live progress (neutral
  role-based phase tokens per Session 2026-05-05 clarification):
  `CANDIDATE_STARTING → CANDIDATE_HEALTHY → SWITCHING → OUTGOING_DRAINING → OUTGOING_STOPPED → ACTIVE`.
- During SWITCHING, traffic is **atomically** redirected to the candidate
  container. No requests dropped at the switch moment (relies on Caddy
  admin API config-replace semantics).
- During OUTGOING_DRAINING, in-flight requests on the outgoing container
  continue to completion; all new requests go to candidate. Drain window
  = `drain_seconds` setting.
- DRAINING UI shows a countdown indicator.
- After drain expires, outgoing container stopped via SIGTERM. After
  compose's `stop_grace_period` (default 10s), SIGKILL fires.
  Connections still active at end of (drain + stop_grace_period) are
  LOST — this is the explicit budget operator chose.
- After successful stop, `applications.active_color` flips
  (`'blue' → 'green'` or vice versa). Container names are sticky per slot
  — `<service>-blue` and `<service>-green` exist as permanent slots,
  whichever opposite-of-active-color is the candidate next deploy.
- Each phase transition emits an audit event (see Key Entities).

### User Story 3 — Green healthcheck failure rolls back (Priority: P2)

As an operator whose new container fails to start (image bad, env var
missing, port collision, app crashes on boot), I want traffic to STAY
on blue and the failed green container to be removed. My service stays up.

**Acceptance**:

- If green's compose-defined healthcheck doesn't pass within
  `green_healthcheck_timeout_seconds`, deploy aborts.
- Reverse-proxy upstream is **NEVER touched** in this path. Traffic stays
  on blue throughout.
- Failed candidate container is stopped + removed (no orphaned containers).
- Deploy marked `failed`. FailureCard surfaces with state
  `candidate_healthcheck_failed`. Action set: `Retry`, `EditConfig`,
  `ViewLog` (per feature 010 FailureCard contract).
- `active_color` UNCHANGED. Audit `deploy.candidate_failed_rollback`
  emitted with failure reason (timeout vs container exit code) +
  candidate's last log lines for forensic detail.

### User Story 4 — Mid-deploy abort during draining (Priority: P2)

As an operator who realises mid-drain that something is wrong with the
new container (it passed healthcheck but doesn't actually serve real
requests properly), I want to abort the drain and switch traffic back
to old container — same operation as forward switch, but reversed.

**Acceptance**:

- DeployLog during DRAINING phase shows a visible "Abort and rollback" button.
- Clicking abort opens a typed-confirm dialog (operator types app name)
  before the abort fires — destructive-action discipline shared with hard-delete.
- On confirm: reverse-proxy upstream switches BACK to outgoing; candidate
  stopped + removed; deploy marked `failed` with reason `aborted_during_drain`.
- Abort window: only valid while phase is `OUTGOING_DRAINING`. After
  `OUTGOING_STOPPED`, abort returns 409 `too_late_to_abort`.
- `active_color` reverts to its pre-deploy value. Audit `deploy.aborted`
  emitted with phase context (the phase abort fired during) + operator who clicked.

### User Story 5 — Stateful services opt out of blue/green (Priority: P3)

As an operator deploying a stateful service (database, single-replica
state-bearing application), I want the deploy strategy to remain
`recreate` and existing flow to work unchanged — running two replicas
of a database for 30 seconds would corrupt state.

**Acceptance**:

- `deploy_strategy='recreate'` apps continue to use existing deploy flow
  exactly as today. No regression: feature 005's deploy entry point
  bifurcates on the new column but recreate path stays bit-identical.
- UI surfaces the safety hint near the strategy dropdown.

## Edge Cases

### US1 (Configure)

- **Operator sets blue_green on app with proxy_type='nginx-legacy' or 'none'**:
  UI disables the option. Server-side validation rejects PATCH with 400
  `blue_green_requires_caddy`. Closes Q3 from clarification (UI-side reject
  + server-side defence-in-depth).
- **Operator changes strategy mid-deploy**: PATCH blocked while a deploy
  job is in-flight (existing feature 004 deploy_lock prevents).
- **`drain_seconds=0`**: valid input. Means immediate cutover after the
  switch — green takes traffic, blue stopped instantly. Sane edge case
  for fast-restart services.
- **`drain_seconds` larger than compose healthcheck interval**: no conflict.
  Drain is independent of healthcheck — drain governs OLD container's
  shutdown, healthcheck governed NEW container's readiness.

### US2 (Deploy execution)

- **Compose has multiple replicas (`replicas > 1`)**: blue/green strategy
  adds complexity (multi-replica upstream pool switch). v1 supports
  `replicas=1` only — verified at deploy-time. Replicas > 1 →
  reject deploy with `blue_green_replicas_not_supported_v1`.
- **`network_mode: host`**: incompatible with parallel containers
  (port collision on host). Reject deploy.
- **Single-port service uses host port pinning** (`ports: ["8080:80"]`):
  same as host network — can't run two simultaneously. Reject.
- **Container exposes via `expose:` only** (internal port, no host pin):
  blue/green works — Caddy routes by upstream container hostname.
- **Compose declares `volumes:` (named or bind)**: PATCH-time
  acknowledgement required per FR-008a. During `OUTGOING_DRAINING`, both
  containers write to the shared volume. Operator-acknowledged risk:
  logs/append-only/unique-path-uploads SAFE; database state files NOT
  SAFE — operator must use `recreate` strategy for stateful services.
- **Compose service rebuild required** (Dockerfile changed): candidate
  starts with new image; outgoing keeps old image. Expected behaviour.
- **Slot naming conflict on first blue/green deploy**: existing container
  has compose-default name (e.g. `<project>-<service>-1`). Per FR-011,
  it is renamed via `docker rename` to `<service>-blue` (metadata-only,
  no downtime) before candidate spawn. Subsequent deploys use sticky
  `<service>-blue` / `<service>-green` — no rename ever again.
- **Deploy interrupted (dashboard process restart) mid-flow**: row's
  `deploy_state` column reflects last-known phase (NULL when idle, else
  one of the phase tokens). Restart-recovery semantics deferred to plan
  (see OQ-004).

### US3 (Rollback)

- **Caddy admin API unreachable mid-deploy**: if SWITCHING never started,
  abort during CANDIDATE_STARTING with reason `caddy_admin_unreachable_pre_switch`.
  If SWITCHING completed and API drops AFTER, deploy enters
  `FAILED_CADDY_ADMIN_POST_SWITCH` phase — critical inconsistency, alert
  via notification gate, manual operator intervention required.
- **Candidate healthcheck flaky** (passes once, then fails inside drain
  window): drain proceeds because we already switched. Operator monitors
  and aborts via US4 if needed.
- **Candidate starts but immediately exits**: healthcheck fails fast,
  rollback kicks in within the configured timeout.

### US4 (Abort)

- **Operator closes browser tab during DRAINING**: abort button only
  visible in browser, but state machine is server-side. Drain continues
  to completion regardless of browser state. Closing tab can't cause
  inconsistency.
- **Operator clicks abort just as drain expires (race)**: server-side
  check — if `active_color` already flipped and outgoing container
  stopped, abort is no-op (returns 409 `too_late_to_abort`).

### US5 (Opt out)

- **App originally `recreate`, operator switches to `blue_green`**: next
  deploy uses new flow. No migration of existing state needed; the
  existing single container becomes "blue" on first blue/green deploy.
- **Existing `recreate` app has `active_color` accidentally set** (impossible
  by data flow but defensive): treated as NULL by recreate path.
  `active_color` only meaningful when strategy is blue_green.

## Functional Requirements

### US1 — Configuration

- **FR-001**: `applications` table MUST gain new columns: `deploy_strategy
  TEXT NOT NULL DEFAULT 'recreate'` (CHECK enum), `drain_seconds INTEGER
  NOT NULL DEFAULT 30`, `green_healthcheck_timeout_seconds INTEGER NOT
  NULL DEFAULT 60`, `active_color TEXT NULL` (CHECK enum-or-NULL),
  `deploy_state TEXT NULL` (current phase token; NULL when idle).
- **FR-002**: `deploy_strategy` MUST be one of `'recreate' | 'blue_green'`.
  Future strategies extend the enum.
- **FR-003**: `drain_seconds` validation: `0 ≤ N ≤ 600`. Zero is valid
  (immediate cutover after switch, no drain).
- **FR-004**: `green_healthcheck_timeout_seconds` validation: `10 ≤ N ≤ 1800`.
- **FR-005**: Edit Application form MUST surface a "Deploy Strategy"
  section with strategy dropdown + drain inputs. Section's `blue_green`
  option DISABLED (greyed out with tooltip) when `proxy_type != 'caddy'`.
- **FR-006**: PATCH `/api/applications/:id` MUST validate that
  `deploy_strategy = 'blue_green'` requires `proxy_type = 'caddy'`.
  Mismatch → 400 `blue_green_requires_caddy`.
- **FR-007**: PATCH MUST also validate that `compose.services.<upstream_service>.deploy.replicas`
  is `1` (or unset = 1) for blue_green. Replicas > 1 → reject 400
  `blue_green_replicas_not_supported_v1`.
- **FR-008**: PATCH MUST validate that the upstream service does NOT use
  `network_mode: host` and does NOT pin host ports for blue_green.
  Violation → reject 400 `blue_green_incompatible_compose`.
- **FR-008a**: PATCH MUST detect presence of `volumes:` in the app's
  compose service definition. When present, MUST require explicit
  acknowledgement field `acknowledgeVolumeSharing: true` in the
  request body; missing or false → reject 400 `volume_sharing_unacknowledged`
  with response payload listing detected volume mounts so UI can render
  the hint inline. Per Session 2026-05-05 review — volume-corruption
  risk is operator's informed choice, not silent assumption.

### US2 — Deploy Execution

- **FR-009**: Deploy on `blue_green` app MUST execute multi-phase state
  machine. Phase tokens (neutral role-based per Session 2026-05-05
  clarification): `CANDIDATE_STARTING | CANDIDATE_HEALTHY | SWITCHING |
  OUTGOING_DRAINING | OUTGOING_STOPPED | ACTIVE | FAILED_CANDIDATE_HEALTHCHECK |
  FAILED_SWITCH | FAILED_DRAIN_ABORT | FAILED_CADDY_ADMIN_POST_SWITCH`.
  Idle (no active deploy) is represented by `deploy_state IS NULL`, NOT
  by an `IDLE` phase token. `ACTIVE` is a transient token marking
  "deploy just completed"; cleared to NULL within seconds of becoming
  ACTIVE.
- **FR-010**: Each phase transition MUST persist `applications.deploy_state`
  AND emit an `audit_entries` row. Live UI streams via existing WS event
  channel (reuse feature 005 / 009 streaming).
- **FR-011**: CANDIDATE_STARTING MUST start a new container with image
  build/pull from latest git ref. Container name is sticky per slot —
  `<service>-blue` or `<service>-green` depending on which slot is the
  candidate this deploy (candidate slot = OPPOSITE of current
  `active_color`). On the very first blue/green deploy of an app
  previously deploying via `recreate`, the existing container is renamed
  via `docker rename` (metadata-only, zero traffic interruption) to
  `<service>-blue` AND `active_color` set to `'blue'` as part of deploy
  initialization. From then on, names are permanent (no further renames).
- **FR-012**: CANDIDATE_HEALTHY transition triggers AFTER candidate
  container's compose-defined healthcheck reports healthy (reuses feature
  006's wait-for-healthy convention) within `green_healthcheck_timeout_seconds`.
  Note: the column is named `green_healthcheck_timeout_seconds` for
  historical reasons, but the value applies to whichever slot is the
  candidate this deploy.
- **FR-013**: SWITCHING MUST update reverse-proxy upstream config atomically
  via Caddy admin API (`POST /load` config-replace semantics). Switch
  failure → abort path with reason `caddy_admin_unreachable` or
  `caddy_admin_rejected_config`.
- **FR-014**: OUTGOING_DRAINING window equals `drain_seconds`. During the
  window, traffic flows to candidate (now active upstream); in-flight
  requests on outgoing container allowed to complete on their own.
- **FR-015**: At end of drain, outgoing container MUST be stopped via SIGTERM.
  After compose's `stop_grace_period` (default 10s), SIGKILL fires.
  Connections still active at end of drain are FORCE-KILLED — operator's
  drain time is the explicit budget. This is the trade-off operator
  accepted by choosing the drain value.
- **FR-016**: After successful OUTGOING_STOPPED, `active_color` flips
  (e.g. was `'blue'` → becomes `'green'`). Deploy state → ACTIVE → NULL.
  Audit `deploy.outgoing_stopped` emitted.
- **FR-017**: Feature 010 hook integration: `post_deploy` hook fires AFTER
  ACTIVE phase reaches stable (drain complete + outgoing stopped). NOT
  during OUTGOING_DRAINING — operator's hook expects a single active
  container.
- **FR-018**: `pre_deploy` hook fires BEFORE CANDIDATE_STARTING per existing
  feature 010 contract. `on_fail` hook fires on any abort path with
  `FAIL_PHASE` env var carrying the phase name. New `FAIL_PHASE` values
  added to feature 010's enum: `candidate_starting`, `candidate_healthcheck`,
  `switching`, `outgoing_draining`, `outgoing_stopping`, `caddy_admin_post_switch`.

### US3 — Rollback

- **FR-018b**: On dashboard boot, a scanner MUST find all `applications`
  rows with non-NULL `deploy_state` (interrupted blue/green deploys).
  Each such row MUST surface in an "Interrupted deploys" panel on the
  apps list page (or equivalent first-screen surface). Per Session
  2026-05-05 clarification, dashboard does NOT auto-resume or auto-fail
  these rows. Operator chooses per row: `Resume from <phase>` (state
  machine re-enters at the recorded phase with sanity-probe first),
  `Abort and clean up candidate` (force-stop + remove the candidate
  container, outgoing left alive, `deploy_state` cleared, `active_color`
  unchanged), or `Mark complete` (typed-confirm dialog requiring app
  name; operator externally verified state; clears `deploy_state` to
  NULL, sets `active_color` per operator input). FailureCard state
  token `deploy_interrupted_by_restart` added to feature 010 lexicon.

- **FR-018a**: When Caddy admin API becomes unreachable AFTER SWITCHING
  has committed (during OUTGOING_DRAINING), deploy MUST transition to
  `FAILED_CADDY_ADMIN_POST_SWITCH` phase per Session 2026-05-05
  clarification. Drain timer PAUSES (no auto-stop of outgoing). FailureCard
  renders with state `caddy_admin_failure_post_switch` exposing three
  actions: `Retry healthcheck` (re-pings admin endpoint; on success,
  resumes drain), `View last-known config` (shows the config dashboard
  committed at SWITCHING for operator's external comparison), `Mark
  recovered` (typed-confirm dialog requiring app name; resumes drain
  from paused position). Critical-class alert fires via notification
  gate. No auto-reconciliation — human external verification is the
  only safe path because Caddy may have been mid-config-write when API
  dropped.

- **FR-019**: Candidate healthcheck failure (timeout or container exit)
  MUST abort deploy WITHOUT touching reverse-proxy. Traffic stays on
  outgoing container throughout.
- **FR-020**: Failed candidate container MUST be stopped + removed. No
  orphaned candidate containers persist.
- **FR-021**: Audit `deploy.candidate_failed_rollback` MUST be emitted
  with payload `{ failureReason, exitCode?, timeoutSeconds?, lastLogLines, candidateColor }`.
- **FR-022**: Failed deploy state surfaces FailureCard with state
  `candidate_healthcheck_failed` per feature 010 contract. Action set:
  `Retry`, `EditConfig`, `ViewLog`.

### US4 — Mid-deploy Abort

- **FR-023**: DeployLog during DRAINING MUST display a visible "Abort and
  rollback" button.
- **FR-024**: Abort flow: typed-confirm dialog (operator types app name)
  → reverse-proxy upstream switches BACK to outgoing container → candidate
  stopped + removed → deploy marked `failed` with reason
  `aborted_during_drain`.
- **FR-025**: Abort window: only valid while `deploy_state = 'OUTGOING_DRAINING'`.
  After OUTGOING_STOPPED, abort returns 409 `too_late_to_abort`.
- **FR-026**: Audit `deploy.aborted` emitted with payload `{ phase, abortedBy }`.

### US5 — Stateful Opt-out

- **FR-027**: Apps with `deploy_strategy='recreate'` MUST use existing
  deploy flow unchanged — feature 005's deploy entry point bifurcates
  ONLY on the strategy column; recreate path stays bit-identical to today.
- **FR-028**: `active_color` UNUSED for recreate strategy (always NULL).
  Switching strategy from `blue_green` to `recreate` clears `active_color`
  on next save.
- **FR-029**: UI hint near strategy dropdown: "Blue/green requires
  single-replica stateless services. Stateful services (databases) MUST
  stay 'recreate'."

### Cross-cutting

- **FR-030**: All actions emit audit entries via existing `auditMiddleware`.
- **FR-031**: All UI inputs validate client-side AND server-side
  (defence-in-depth).
- **FR-032**: deploy_lock from feature 004 MUST prevent concurrent deploys
  to the same app — blue/green deploys are NOT exempt; same one-deploy-per-app-at-a-time invariant.

## Success Criteria

- **SC-001**: Operators with `deploy_strategy='blue_green'` apps see ZERO
  USER-VISIBLE connection drops at the switch moment for 95%+ of deploys
  (verified by external probe during deploy window over 30 days
  post-rollout). Per Session 2026-05-05 clarification: "user-visible
  drop" = any request taking longer than 100ms to fail or any
  application-side exception during the switch second. Sub-100ms Caddy
  reload race windows are NOT user-visible and don't count. The 5%
  acceptable failure tail is reserved for catastrophic infra failures
  (Caddy crash, dashboard OOM, network partition); these MUST fail
  gracefully via the `caddy_admin_failure_post_switch` recovery flow,
  never as silent data loss. Test gate: integration test fires
  request-flood during normal deploy, asserts 100% completion (no
  drops); separate catastrophic-injection test allowed to fail SC-001
  but MUST not corrupt audit trail or leave orphan containers.
- **SC-002**: Drain window completes within `drain_seconds ± 2 seconds`
  for 99% of deploys (deviation sourced only from compose stop_grace_period
  or system clock skew).
- **SC-003**: Green healthcheck failures are caught + rolled back without
  affecting traffic in 100% of cases (verified via fault injection
  test fixtures simulating bad images + crashing containers).
- **SC-004**: Mid-deploy abort completes within 5 seconds of operator
  click in 95%+ of cases (switch back to blue + green stop).
- **SC-005**: 100% of `deploy_strategy='recreate'` apps continue working
  exactly as before (no regression — measured via existing deploy
  success rate over 30 days post-rollout).
- **SC-006**: Average operator time from "click Deploy" to "ACTIVE" for
  blue/green apps is `green_healthcheck_timeout + drain_seconds + 30s overhead`
  ± 15s. Predictable timing that operators can plan against.
- **SC-007**: Operator-survey "I trust deploy doesn't kill my long-running
  requests" sentiment improves from baseline post-rollout (qualitative
  confidence metric).

## Key Entities

### `applications` (modified — 5 new columns)

- `deploy_strategy TEXT NOT NULL DEFAULT 'recreate'` — `'recreate' | 'blue_green'`.
  CHECK constraint enforces enum.
- `drain_seconds INTEGER NOT NULL DEFAULT 30` — 0..600 inclusive.
- `green_healthcheck_timeout_seconds INTEGER NOT NULL DEFAULT 60` —
  10..1800 inclusive.
- `active_color TEXT NULL` — `'blue' | 'green'` or NULL when strategy is
  recreate. CHECK constraint enforces enum-or-NULL.
- `deploy_state TEXT NULL` — current blue/green phase token (NULL when
  not deploying). Reused as resumability anchor when dashboard restarts
  mid-flow.

### `audit_entries` (existing — new event types)

Per Session 2026-05-05 clarification, audit event names use neutral role
language matching the phase tokens (no green/blue in event names except
in the strategy-name string `blue_green` itself, which IS the canonical
strategy identifier).

- `app.deploy_strategy_changed` — operator changed `deploy_strategy`
  and/or drain/timeout settings.
- `deploy.blue_green_started` — happy-path entry. (`blue_green` here is
  the strategy name, not a phase color.)
- `deploy.candidate_healthy` — candidate passed compose healthcheck.
- `deploy.traffic_switched` — Caddy admin upstream switch completed.
- `deploy.drained` — drain window elapsed.
- `deploy.outgoing_stopped` — outgoing container terminated; `active_color`
  flipped; deploy reached ACTIVE.
- `deploy.candidate_failed_rollback` — candidate didn't pass healthcheck;
  traffic never switched.
- `deploy.aborted` — operator-initiated abort during OUTGOING_DRAINING.
- `deploy.too_late_to_abort` — operator clicked abort but state had
  already advanced past OUTGOING_DRAINING.
- `deploy.caddy_admin_failure_pre_switch` — admin API failed BEFORE the
  switch was committed; rollback path possible.
- `deploy.caddy_admin_failure_post_switch` — admin API failed AFTER the
  switch was committed; manual recovery required.

## Assumptions

- A-001: All apps using `blue_green` use Caddy reverse proxy with admin
  API enabled (per feature 008's existing infrastructure). Apps without
  Caddy MUST use `recreate` (UI enforces, server-side enforces).
- A-002: Compose service has a single replica (`replicas: 1` or unset).
  Multi-replica blue/green deferred to v2 (would need
  upstream-pool-of-N → upstream-pool-of-N switch).
- A-003: Compose service has a defined `healthcheck` directive. Apps
  without compose-level healthcheck cannot use blue/green (no signal for
  CANDIDATE_HEALTHY transition). Validated at PATCH time.
- A-004: Container start time is bounded by `green_healthcheck_timeout_seconds`.
  Operator's responsibility to set realistically for their service
  (cold starts, image pull time, app boot time all included).
- A-005: After drain expires, SIGTERM + compose `stop_grace_period` SIGKILL
  is the explicit operator-accepted budget. Connections still active at
  end of total wait are LOST. This is the operational contract — drain
  time is a commitment.
- A-006: Reverse-proxy admin API is reachable from dashboard backend
  (not laptop). Same network assumption as feature 008.

## Dependencies

- **Feature 004** (db-deploy-lock): per-app deploy lock used for blue/green
  serialization (no concurrent green spawns).
- **Feature 005** (universal-script-runner): deploy entry point bifurcates
  by `deploy_strategy`. New manifest entries `deploy/blue-green-up`,
  `deploy/blue-green-switch`, `deploy/blue-green-drain`,
  `deploy/blue-green-stop-blue`. This feature LIFTS the "no blue/green"
  scope-out from spec 005.
- **Feature 006** (app-health-monitoring): wait-for-healthy convention
  reused for CANDIDATE_HEALTHY signal.
- **Feature 008** (application-domain-and-tls): Caddy admin client used
  for atomic upstream switch.
- **Feature 010** (operational-maturity): `post_deploy` hook fires after
  ACTIVE; FailureCard's state vocabulary extended with
  `green_healthcheck_failed` and `aborted_during_drain` and
  `caddy_admin_failure`. `on_fail` hook receives `FAIL_PHASE` per
  feature 010 FR-011 — this feature adds new phase tokens to the enum.
- **Feature 011** (zero-touch-onboarding): orthogonal — server-level
  config not directly used by this feature; per-app config lives here.

## Out of Scope

- Canary deploys (gradual % rollout, e.g., "10% to green for 5 min, then 100%"). v2.
- Multi-region failover. v3.
- Container orchestration replacement (Kubernetes-style). Out of mission.
- Stateful service automatic blue/green (databases etc). Operator picks
  `recreate`; this feature does NOT auto-detect statefulness.
- Concurrent deploys to same app. Still serialized via feature 004
  deploy_lock.
- Custom traffic-shaping (X% to new, Y% to old). v3.
- Multi-replica blue/green (`replicas > 1`). v2.
- Apps without compose-level healthcheck. v2 may add `wait_for_port_open`
  fallback.
- Manual-trigger blue/green outside of Deploy flow (e.g., "switch back
  to blue" UI for the previous version). v2 — currently needs to redeploy.
- Per-server default deploy_strategy (one config that all server's apps
  inherit). v2 — currently per-app only.

## Related

- Spec 004 `/specs/004-db-deploy-lock/spec.md`: per-app lock primitive.
- Spec 005 `/specs/005-universal-script-runner/spec.md`: explicitly
  declared "no blue/green" — this feature lifts that. Cross-reference
  this spec from 005's Out of Scope when this ships.
- Spec 006 `/specs/006-app-health-monitoring/spec.md`: wait-for-healthy
  convention reused.
- Spec 008 `/specs/008-application-domain-and-tls/spec.md`: Caddy admin
  API integration foundation.
- Spec 010 `/specs/010-operational-maturity/spec.md`: hooks dispatch +
  FailureCard state vocabulary.
- Spec 011 `/specs/011-zero-touch-onboarding/spec.md`: parallel branch —
  reserves migration sequence 0010; this feature reserves 0012.
- Operator request thread (chat 2026-05-05): origin of "хочется
  настраивать время свича трафика чтобы операции успели завершиться".

## Open Questions

- OQ-001 (US2): drain countdown UX — real-time countdown timer in DeployLog,
  or static "drain_seconds remaining"? Defer to design.
- ~~OQ-002 (US2)~~: **RESOLVED** in Session 2026-05-05 (Q1) — sticky
  per-slot container naming `<service>-blue` / `<service>-green` (no
  rename rituals; one-time `docker rename` on first blue/green deploy
  to migrate existing recreate-deployed container into a slot).
- ~~OQ-003 (US3)~~: **RESOLVED** in Session 2026-05-05 (Q3) — dedicated
  FailureCard with manual-recovery actions (Retry healthcheck / View
  last-known config / Mark recovered) + drain timer pause + critical
  TG alert. No auto-reconciliation.
- ~~OQ-004 (US2)~~: **RESOLVED** in Session 2026-05-05 (Q4) — manual
  decision per row via "Interrupted deploys" panel on dashboard boot.
  No auto-resume / no auto-fail; operator picks Resume / Abort /
  Mark complete per affected app.
## Notification triggers (feature 011 catalogue extension)

This feature adds new entries to the notification event catalogue
(feature 011 `notification_preferences`). Each fires a TG message when
the event type is enabled in operator preferences:

- `deploy.candidate_failed_rollback` — failure-class, default ON
- `deploy.aborted` — security-class, default ON
- `deploy.caddy_admin_failure_pre_switch` — failure-class, default ON
- `deploy.caddy_admin_failure_post_switch` — failure-class, default ON
  (critical — manual intervention required)
- `deploy.blue_green_succeeded` — success-class, default OFF (operator
  opts in if they want the green-light TG)
