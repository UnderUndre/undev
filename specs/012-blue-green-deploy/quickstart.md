# Quickstart: Blue/Green Deploy with Connection Drain

**Date**: 2026-05-05 | **Branch**: `012-blue-green-deploy` | **Plan**: [plan.md](plan.md)

Operator-facing walkthrough across the five User Stories. Each section
maps to a Success Criterion (SC-001..SC-007) for verification.

**Pre-requisites** (one-time, dashboard-side):

1. Migration `0012_blue_green_deploy.sql` applied
   (`npm run db:migrate`).
2. Dashboard upgraded past commit landing this feature.
3. Features 010 + 011 merged (FailureCard contract + notification gate
   are dependencies).
4. App being deployed has Caddy reverse proxy enabled (`proxy_type='caddy'`).
5. App's compose service has a `healthcheck:` directive (required for
   CANDIDATE_HEALTHY signal).

---

## Step 1 — Configure deploy strategy (US1, SC-006)

**Goal**: switch a stateless web service from `recreate` to `blue_green`
and tune drain settings.

1. App detail → Edit Application.
2. Find new **Deploy Strategy** section (collapsed-section pattern from
   feature 010 hooks).
3. Strategy dropdown:
   - `recreate` (current default, no behaviour change)
   - `blue_green` (new strategy — DISABLED in dropdown if `proxy_type != 'caddy'`)
4. Pick `blue_green`. New inputs appear:
   - **Drain window (seconds)**: default 30, range 0..600
   - **Green healthcheck timeout (seconds)**: default 60, range 10..1800
5. If app's compose service has `volumes:` declared, a **Volume sharing
   acknowledgement** panel appears between strategy dropdown and Save.
   Lists detected volumes + safety hint:
   > "Both containers share volumes during the drain window. Logs and
   > append-only files are safe. Unique-path uploads are safe. Database
   > files / shared state files RISK CORRUPTION — those services must
   > stay 'recreate'."
6. Tick the "I understand both containers share these volumes during
   drain" checkbox to enable Save (per FR-008a).
7. Save. Audit `app.deploy_strategy_changed` written.

**SC-006 check**: operator survey post-rollout — "I trust that drain
configuration is doing what I expect" sentiment improves.

**Spec reference**: US1, FR-001..008a.

---

## Step 2 — Deploy a blue/green app (US2, SC-001, SC-002, SC-006)

**Goal**: trigger a deploy on the configured app; watch state machine
drive CANDIDATE_STARTING → ACTIVE.

1. App detail → Deploy button (existing UI).
2. DeployLog modal opens. Instead of standard "compose up" stream,
   you see the multi-phase Blue/Green progress:
   - **CANDIDATE_STARTING** (~1-30s depending on image build/pull)
   - **CANDIDATE_HEALTHY** (when compose healthcheck reports healthy)
   - **SWITCHING** (~100ms — Caddy admin POST /load)
   - **OUTGOING_DRAINING** (drain_seconds — countdown indicator visible)
   - **OUTGOING_STOPPED** (~10-15s — SIGTERM + stop_grace_period + SIGKILL)
   - **ACTIVE** (final state, ~1s)
3. During DRAINING, an **Abort and rollback** button is visible. Use it
   if you realise something is wrong with the candidate.
4. After ACTIVE, modal closes; app's `active_color` flipped (`blue ↔ green`).
5. Audit emits per phase: `deploy.blue_green_started`,
   `deploy.candidate_healthy`, `deploy.traffic_switched`, `deploy.drained`,
   `deploy.outgoing_stopped`, and (if enabled) `deploy.blue_green_succeeded`
   notification.

**Behind the scenes**:

- First blue/green deploy on a previously-recreate-deployed app: the
  existing container is renamed (`docker rename` — metadata only, zero
  downtime) to `<service>-blue` before candidate spawn. `active_color`
  set to `'blue'`. Subsequent deploys alternate between sticky slot
  containers.
- Caddy upstream switch is atomic (single `POST /load` to admin API);
  in-flight requests on outgoing complete on outgoing; new requests go
  to candidate.

**SC-001 check**: external probe runs HTTP request flood during the
deploy window; expect 100% completion (zero user-visible drops > 100ms).
Sub-100ms gaps from Caddy reload are below operator perception.

**SC-002 check**: drain window completes within `drain_seconds ± 2s`
(deviation from compose `stop_grace_period`).

**Spec reference**: US2, FR-009..018b.

---

## Step 3 — Recover from candidate healthcheck failure (US3, SC-003)

**Goal**: deploy a broken image (intentional or accidental); see
rollback to outgoing without affecting traffic.

1. Push broken image (e.g. compile error, bad env, port collision)
2. Click Deploy.
3. Phase progresses to CANDIDATE_STARTING. Compose healthcheck fails
   (timeout or container exit).
4. State transitions to `FAILED_CANDIDATE_HEALTHCHECK`. Caddy upstream
   NEVER touched — traffic stays on outgoing throughout.
5. FailureCard renders (feature 010 contract):
   - **Retry** — re-runs deploy from CANDIDATE_STARTING (after fixing
     image)
   - **Edit Config** — navigate to app edit (e.g. fix healthcheck
     timeout)
   - **View Log** — failure details + last-log-lines from candidate
6. Failed candidate container stopped + removed automatically. No
   orphans.
7. `active_color` UNCHANGED. Audit `deploy.candidate_failed_rollback`.

**SC-003 check**: integration test injects bad-image candidate;
asserts traffic served by outgoing throughout, candidate cleaned up,
audit log forensic detail present.

**Spec reference**: US3, FR-019..022.

---

## Step 4 — Mid-deploy abort during drain (US4)

**Goal**: candidate passed healthcheck and traffic switched, but
during drain you realise something is wrong (operator visual check
fails); abort to switch traffic back.

1. Deploy in OUTGOING_DRAINING phase (countdown visible).
2. Click **Abort and rollback** button.
3. Typed-confirm dialog opens — type the app's name to confirm
   (destructive-action discipline).
4. On confirm: Caddy upstream switches BACK to outgoing color,
   candidate stopped + removed.
5. State transitions to `FAILED_DRAIN_ABORT`. FailureCard renders
   with `Retry` + `ViewLog` actions.
6. `active_color` reverts to its pre-deploy value. Audit
   `deploy.aborted` with phase context + operator id.
7. Notification fires (default ON for `deploy.aborted` event).

**Edge case**: if you click Abort just as drain expires (race), server
returns 409 `too_late_to_abort` — `active_color` already flipped, no
rollback possible.

**Spec reference**: US4, FR-023..026.

---

## Step 5 — Recover from Caddy admin failure mid-drain (US3 edge, FR-018a)

**Goal**: rare scenario — Caddy admin API drops AFTER successful
switch; dashboard can't verify upstream state.

1. Deploy is in OUTGOING_DRAINING. Caddy admin endpoint becomes
   unreachable (network blip, Caddy crash, etc).
2. Drain timer **PAUSES** automatically. State transitions to
   `FAILED_CADDY_ADMIN_POST_SWITCH`.
3. Critical-class TG alert fires (`deploy.caddy_admin_failure_post_switch`,
   default ON).
4. FailureCard renders with three actions:
   - **Retry healthcheck** — re-pings Caddy admin. If recovers, drain
     resumes from paused position.
   - **View last-known config** — shows the config dashboard committed
     at SWITCHING for operator's external comparison.
   - **Mark recovered** (typed-confirm) — operator confirms via SSH/curl
     that Caddy is correctly routing externally; dashboard resumes
     drain.
5. After Mark recovered: drain timer resumes from where it paused.
   State transitions back to OUTGOING_DRAINING.
6. Alternative: operator clicks Abort (typed-confirm) → switches back
   to outgoing, candidate stopped, deploy marked failed.

**Why this design** (per spec Q3 clarification): no auto-reconciliation.
Caddy may have been mid-config-write when API dropped — the actual
state may differ from what dashboard committed. Only human external
verification is safe.

**Spec reference**: FR-018a, Edge Cases US3.

---

## Step 6 — Restart-recovery after dashboard crash (FR-018b)

**Goal**: dashboard process crashes mid-deploy; on restart, operator
sees the interrupted deploy and chooses how to handle.

1. Dashboard process killed (OOM, restart, container kill) during
   OUTGOING_DRAINING phase.
2. On dashboard boot, `interrupted-deploys-scanner.ts` finds the row
   with `deploy_state IS NOT NULL`. Probes container state via
   `docker inspect`.
3. Apps list page renders **Interrupted deploys** panel at top:
   ```
   ⚠ 1 interrupted deploy detected
   ┌────────────────────────────────────────────┐
   │ App: my-cool-app   Server: prod-1          │
   │ Last phase: OUTGOING_DRAINING              │
   │ Started at: 2026-05-05 14:23:01 (12m ago)  │
   │ Candidate: my-cool-app-green (running)     │
   │ Outgoing: my-cool-app-blue (running)       │
   │                                            │
   │ [Resume from OUTGOING_DRAINING]            │
   │ [Abort and clean up candidate]             │
   │ [Mark complete]                            │
   └────────────────────────────────────────────┘
   ```
4. Operator picks per row:
   - **Resume** — sanity probe runs first; if state matches expected,
     drain timer restarts with full `drain_seconds` (NOT remaining
     time, since timer state was lost). Audit `deploy.interrupted_resumed`.
   - **Abort and clean up candidate** — typed-confirm; force-stops +
     removes candidate; outgoing left alive; `deploy_state` cleared.
   - **Mark complete** — typed-confirm; operator externally verified
     deploy actually completed (e.g. saw outgoing already stopped before
     crash); operator provides `finalActiveColor` value;
     `deploy_state` cleared, `active_color` set per operator input.

**Why manual decision**: per spec Q4 — auto-resume risky (state
ambiguous after crash), auto-fail wastes near-complete deploys.
Operator's external verification is the only safe path.

**Spec reference**: FR-018b, US2 edge cases, Q4 clarification.

---

## Step 7 — Stateful service opt-out (US5, SC-005)

**Goal**: ensure existing recreate-strategy apps continue working
unchanged.

1. Open any app currently using `recreate` strategy (default for all
   apps).
2. Trigger Deploy. Existing flow runs exactly as today — single
   `docker compose up -d` recreate.
3. No behaviour change visible to operator. No new UI elements unless
   they explicitly switch to `blue_green` in Edit form.

**SC-005 check**: existing integration tests for recreate strategy
pass without modification (no regression). Deploy success rate over
30 days post-rollout matches pre-rollout baseline.

**Spec reference**: US5, FR-027..029.

---

## Verification matrix

| SC | Tests for verification | Status check |
|---|---|---|
| SC-001 | `tests/integration/blue-green-sc-001-request-flood.test.ts` + 30-day external-probe metric | post-rollout metric |
| SC-002 | `tests/integration/blue-green-happy-path.test.ts` (drain window assertion) | CI gate |
| SC-003 | `tests/integration/blue-green-candidate-fail.test.ts` | CI gate |
| SC-004 | `tests/integration/blue-green-abort-during-drain.test.ts` (timing assertion) | CI gate |
| SC-005 | `tests/integration/blue-green-recreate-no-regression.test.ts` + existing recreate fixtures pass | CI gate |
| SC-006 | Deploy timing observability metric over 30 days | post-rollout metric |
| SC-007 | Operator survey post-rollout | qualitative |

---

## Troubleshooting

### Strategy dropdown shows `blue_green` greyed out

App's `proxy_type` is not `'caddy'`. Either: switch the app to Caddy
(via Domain & TLS section, requires re-issuance), or keep `recreate`
strategy.

### PATCH returns `blue_green_replicas_not_supported_v1`

Compose service has `deploy.replicas: > 1`. v1 supports single-replica
only. Either reduce to 1 or use `recreate` strategy. Multi-replica
blue/green tracked as v2.

### PATCH returns `blue_green_incompatible_compose` with `reason: 'no_healthcheck'`

Compose service must declare a `healthcheck:` directive — dashboard
needs the signal to detect CANDIDATE_HEALTHY. Add a healthcheck to your
compose; common pattern:

```yaml
services:
  myapp:
    healthcheck:
      test: ["CMD-SHELL", "curl -f http://localhost:8080/health || exit 1"]
      interval: 5s
      timeout: 3s
      retries: 5
      start_period: 10s
```

### PATCH returns `volume_sharing_unacknowledged`

Compose service declares `volumes:`. Tick the volume-sharing
acknowledgement checkbox in the Deploy Strategy section.

### Deploy stuck in CANDIDATE_STARTING for full timeout

Healthcheck not passing. Check candidate container logs (DeployLog
modal shows them). Common causes: app fails to start (env vars,
permissions), healthcheck endpoint not yet reachable inside the
container's network namespace.

### Caddy admin failure post-switch — manual recovery

Dashboard shows FailureCard with `caddy_admin_failure_post_switch`
state. Drain timer paused. Verify externally:

```bash
ssh deploy@<server> 'curl -s http://localhost:2019/config/'
# If returns 200 with expected config — Caddy is fine, click Mark recovered
# If returns error — Caddy needs restart; investigate logs
```

After external verification, click **Mark recovered** in dashboard.

### Interrupted deploy on boot

`Interrupted deploys` panel appears. Inspect candidate + outgoing
container states (panel shows them). Most common scenarios:

- Candidate `running` + outgoing `running`: deploy was in
  OUTGOING_DRAINING. Choose **Abort and clean up candidate** to stop the
  candidate and revert.
- Candidate `running` + outgoing `exited`: deploy was past
  OUTGOING_STOPPED but DB column wasn't updated. Choose **Mark
  complete** with `finalActiveColor: <candidate-color>`.
- Candidate `exited` + outgoing `running`: deploy failed early. Choose
  **Abort and clean up candidate**; redeploy from scratch.

---

## What's NOT covered

Per spec Out of Scope:

- Canary deploys (gradual % rollout). v2.
- Multi-region failover. v3.
- Container orchestration replacement (Kubernetes). Out of mission.
- Stateful service automatic blue/green (DBs etc). Operator picks
  `recreate`.
- Concurrent deploys to same app (still serialized via deploy_lock).
- Custom traffic-shaping (X% to new, Y% to old). v3.
- Multi-replica blue/green (`replicas > 1`). v2.
- Apps without compose-level healthcheck. v2 may add `wait_for_port_open`
  fallback.
- Manual-trigger blue/green outside of Deploy flow. v2 — currently
  needs to redeploy.
- Per-server default deploy_strategy. v2 — currently per-app only.

These are deliberate v1 boundaries.
