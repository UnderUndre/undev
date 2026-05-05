# Quickstart: Operational Maturity

**Date**: 2026-05-05 | **Branch**: `010-operational-maturity` | **Plan**: [plan.md](plan.md)

Operator-facing walkthrough across the six User Stories. Each section
maps to a Success Criterion (SC-001..SC-006) for verification.

**Pre-requisites** (one-time, dashboard-side):

1. Migration `0011_operational_maturity.sql` applied (`npm run db:migrate`).
2. Dashboard upgraded past commit landing this feature.

---

## Step 1 — Bootstrap a brand-new app from GitHub (US1, SC-001)

**Goal**: onboard a fresh app without opening a terminal.

1. Server detail page → Apps tab.
2. Click **Bootstrap from GitHub** (new button next to Add Application
   and Scan Server).
3. Wizard opens (the feature 009 BootstrapWizard, now reachable):
   - Step 1: pick repo from GitHub search (5-min cache, debounced).
   - Step 2: confirm detected `docker-compose.yml` services + upstream
     port (auto-picked when single, dropdown for multiple).
   - Step 3: optional domain + ACME email.
   - Step 4: advanced (branch, compose path override, hooks if you want
     them inline at bootstrap time).
   - Step 5: review + submit.
4. State machine drives `INIT → CLONING → COMPOSE_UP → HEALTHCHECK →
   PROXY_APPLIED → CERT_ISSUED → ACTIVE` live; modal stays open with
   per-step log tail.
5. Closing the wizard mid-flow does NOT abort — state machine is
   server-side per feature 009 FR-007.

**SC-001 check**: ≤ 5 clicks from Bootstrap button to submit. No
terminal opened.

**Spec reference**: US1, FR-001..005.

---

## Step 2 — Add a database migration step before deploy (US2, SC-002)

**Goal**: inject a `pre_deploy` hook without rewriting the whole
deploy script.

1. App detail → Edit Application.
2. Expand the new **Lifecycle Hooks** section (collapsed by default).
3. Set **Pre-deploy hook**: `scripts/migrate-db.sh` (relative path
   inside the repo, must end `.sh`).
4. Verify **Script path (full replace)** is empty — leaving it set
   AND adding hooks blocks Save with inline error
   `script_path_hooks_mutually_exclusive` per FR-013a.
5. Save. Audit `app.hooks_changed` written.
6. Trigger a deploy. The runner now executes:
   - `git fetch + reset` (existing)
   - `bash $APP_DIR/scripts/migrate-db.sh` (new — env: `APP_DIR`,
     `BRANCH`, `COMMIT`, `SECRET_*`)
   - `docker compose up -d` (existing)
7. Hook non-zero exit aborts deploy with `failed` status. Hook stderr
   surfaces in DeployLog via the new FailureCard (US3).

**Other hooks**:

- `Post-deploy`: smoke tests, cache warm. Failure marks deploy `failed`
  but does NOT roll back compose.
- `On-fail`: alert webhook, slack notify. Hook failure logged at warn
  only, never propagated.
- `Pre-destroy`: db dump, cache flush. Runs on hard-delete via
  `hard-delete-with-hooks.ts` decorator. Hook failure ABORTS the delete.

**SC-002 check**: 30 days post-rollout, audit log shows ≥ 3 production
apps with at least one hook field non-NULL.

**Spec reference**: US2, FR-006..013, FR-013a.

---

## Step 3 — Recover from a failure via the unified FailureCard (US3, SC-003)

**Goal**: same recovery vocabulary across deploy / bootstrap / cert /
health failures.

When something fails anywhere in the dashboard, you'll see a red-bordered
card with:

- A status icon (clock for rate-limited, network for unreachable,
  shield/lock for auth, wrench for build issues).
- One-line summary of what failed.
- Expandable details (log excerpt, error message, stack trace).
- Action row at the bottom-right with consistent labels:
  - **Retry** (full restart)
  - **Retry from `<step>`** (resume from failed point — bootstrap only)
  - **Edit config** (navigate to edit form)
  - **View full log** (deeplink to log viewer)
  - **Hard delete…** (destructive, opens typed-confirm dialog)
  - **Force renew** (cert only)
  - **Revoke** (cert only)

The labels are TypeScript-enforced — drift between contexts is a
compile error. If you see "Try again" anywhere, that's a regression.

**SC-003 check**: operator survey post-rollout shows uniform vocabulary
recall across deploy/bootstrap/cert failure recovery. No "I didn't
know there was a Retry button there" reports.

**Spec reference**: US3, FR-014..018, [contracts/failure-card.md](contracts/failure-card.md).

---

## Step 4 — Attach a domain with cross-server conflict resolution (US4, SC-004)

**Goal**: explicit, typed-confirm decision before HA-style domain attach.

1. App detail → Domain & TLS section → Edit Domain.
2. Type the new domain (e.g. `example.com`).
3. Dashboard runs cross-server check on submit. If `example.com` is
   already attached to another app on a different server:
4. **Conflict panel** renders inline listing:
   - Server label + app name + domain + cert status of every conflicting
     row, with deeplinks.
5. **Type the domain to confirm** (FR-021): an input field appears,
   operator must type `example.com` exactly to enable Save. Typo or
   empty → Save disabled.
6. On submit, server re-checks conflicts at write time (race protection
   per US4 edge case).
7. Audit `app.cross_server_domain_confirmed` emitted with the conflict
   snapshot (forensic record of why HA was approved).

**SC-004 check**: 30 days post-rollout, zero `app.cross_server_domain_confirmed`
events followed by `app.domain_changed` reverting the attach (= no
accidental HA setups).

**Spec reference**: US4, FR-019..021.

---

## Step 5 — Investigate an incident via the Audit Log (US5, SC-005)

**Goal**: forensic queries without dropping to SQL.

1. Sidebar → **Audit Log** (new entry, route `/audit`).
2. Default view: reverse-chronological list of recent events.
3. Use the filter sidebar:
   - **Actor**: multi-select from all distinct actors seen.
   - **Action**: multi-select dropdown (e.g. `app.domain_changed`,
     `server.added`, `cert.renewed`, `app.hooks_changed`).
   - **Resource type**: Server / Application / Cert / Bootstrap.
   - **Time range**: 1h / 24h / 7d / 30d / custom.
4. Filter state syncs to the URL — bookmark or share a forensic query.
5. Click any row's resource cell to deeplink to that resource (or see
   the last-known label as plaintext if the resource was hard-deleted).
6. Click **Export CSV** to download the current filtered view (capped
   at 10,000 rows, streamed — no buffer of full set on the server).

**SC-005 check**: median time from "incident reported" to "audit query
reveals responsible action" drops to ≤ 60 seconds (vs prior SSH+psql
baseline measured in minutes).

**Spec reference**: US5, FR-022..027.

---

## Step 6 — Adopt a manually-configured legacy app (US6, SC-006)

**Goal**: bring an outside-dashboard app under management without
hand-filling the Add Application form.

1. Server detail → Apps tab → **Migrate Existing App** (new button next
   to Bootstrap / Add / Scan).
2. Wizard prompts:
   - **Target path** on the host (autocompleted from feature 003 scan
     results if available).
   - **Compose file name** (default `docker-compose.yml`).
   - Optional **Health URL**, optional **Domain**.
3. On submit, the backend:
   - SSH `test -d` the path (returns 422 `target_path_invalid` if
     missing).
   - Reads `git remote get-url origin` if `.git` present (auto-fills
     `repo_url`).
   - Runs feature 009's compose parser to detect upstream service +
     port.
   - Checks for an existing `(server_id, remote_path)` row:
     - **No row**: INSERTs new row with `created_via='migrate'`. Audit
       `app.migrated`. Response code 201.
     - **Existing scan row** (`created_via='scan'`): PATCH-promotes the
       row, fills missing fields, preserves `created_via='scan'`
       (origin metadata kept). Audit `app.migrated_from_scan`. Response
       code 200.
     - **Existing manual / bootstrap / migrate row**: rejects with 409
       `path_already_managed` + deeplink to existing app.
4. Optional first health probe runs immediately if `healthUrl` set.
5. Optional Caddy reconcile triggers if `domain` set.

**SC-006 check**: 100% of currently-manually-configured production apps
can be migrated via the toolkit (no row falls back to manual `INSERT
INTO applications`).

**Spec reference**: US6, FR-028..033, FR-033a.

---

## Verification matrix

| SC | Tests for verification | Status check |
|---|---|---|
| SC-001 | `tests/integration/bootstrap-wizard-mount.test.ts` | Wizard reachable + 5-click path validated |
| SC-002 | `tests/integration/hooks-end-to-end.test.ts` + 30-day audit query for `app.hooks_changed` rows | post-rollout metric |
| SC-003 | `tests/integration/failure-card-{deploy,bootstrap,cert}.test.ts` + operator survey | post-rollout survey |
| SC-004 | `tests/integration/cross-server-domain-confirm.test.ts` + 30-day audit query | post-rollout metric |
| SC-005 | `tests/integration/audit-page-faceted.test.ts` + SLA timer on incident response | post-rollout metric |
| SC-006 | `tests/integration/migration-scan-promote.test.ts` + production app inventory survey | post-rollout audit |

---

## Troubleshooting

### Save disabled with "script_path_hooks_mutually_exclusive"

You set both `script_path` (full replace) and at least one hook field.
Per FR-013a, pick one model per app. Either clear `script_path` to use
hooks, or clear all hooks to use full replacement.

### Hook script exits 127 ("No such file")

The path you set isn't on the target after deploy. Check spelling, check
the file exists in the repo, check it's committed (not gitignored).

### Hook silently does nothing

Verify `script_path` is empty (full-replace would skip hooks). Check
deploy log — hooks log their dispatch with structured pino entries.

### Migrate Existing App fails with "path_already_managed"

The path is already a non-scan dashboard row. Open the existing app
(deeplink in the error response), or hard-delete it first if you really
want to re-import.

### FailureCard action button does nothing

Variants `HardDelete` and `Revoke` open a typed-confirm dialog before
firing — that's by design (destructive actions need explicit re-typing
of the resource name). If the dialog isn't appearing, check the
console for state errors.

### Audit CSV export hangs

Check the time range — exporting 30 days across all actors may stream
~5MB. The browser shows download-in-progress. Server caps at 10k rows
hard.

---

## What's NOT covered

Per spec Out of Scope:

- Per-hook env override (v2).
- Per-hook timeout override (v2).
- Audit log full-text search (v2 — facets cover v1 needs).
- Audit retention policy beyond existing prune (v2).
- Migration toolkit for cross-server moves (v2 — current scope is
  "outside-dashboard → managed").
- Hook templates / hook marketplace (v3).
- Bulk hook-edit UI across apps (v2).
- Audit log alerting on suspicious patterns (v3).

These are deliberate v1 boundaries.
