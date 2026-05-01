# Tasks: Bootstrap Deploy from GitHub Repo

**Feature**: 009-bootstrap-deploy-from-repo
**Inputs**: `spec.md`, `plan.md`, `research.md`, `data-model.md`, `contracts/api.md`, `quickstart.md`
**Prerequisites**: yaml ^2.6.0 dependency approval (Standing Order #2); features 001/002/003/004/005/006/008 merged
**Format reminder**: every task line is `- [ ] [TaskID] [AGENT] [Story?] Description with file path`. No `[P]` markers, no chained arrows. Story tag `[USx]` only inside Phase 3..6.

## Agent tags

| Tag | Domain |
|---|---|
| `[SETUP]` | Cross-cutting shared-file writes — single owner per file |
| `[DB]` | Migration `.sql`, `schema.ts`, parameterized Drizzle queries |
| `[BE]` | Server services / routes / lib / manifest |
| `[FE]` | React components / hooks / pages |
| `[OPS]` | Bash scripts under `scripts/bootstrap/`, package.json |
| `[E2E]` | Cross-domain integration tests |
| `[SEC]` | Security audit / vulnerability review |

## Status legend

`[ ]` not started · `[~]` in progress · `[x]` done · `[!]` blocked

## Path conventions

- Server: `devops-app/server/`
- Client: `devops-app/client/`
- Migrations: `devops-app/server/db/migrations/0009_bootstrap.sql`
- Bootstrap shell scripts: `scripts/bootstrap/`
- Tests: `devops-app/tests/{unit,integration}/`

---

## Phase 1: Setup

- [x] T001 [SETUP] [OPS] Verify `yaml: ^2.6.0` and `transliteration: ^2.6.1` are present in `devops-app/package.json` dependencies (both already installed by user; install step skipped per Standing Order #2 — no `npm install` needed). Confirm lockfile resolves both, confirm `import { transliterate } from 'transliteration'` and `import { parse } from 'yaml'` succeed under typecheck. Standards: no `as any` on the type-check probe. — `yaml ^2.8.3` and `transliteration ^2.6.1` confirmed in package.json; typecheck of helpers using both passes clean.
- [ ] T002 [SETUP] [BE] Audit `devops-app/CLAUDE.md` guardrail compliance for this feature: no `as any`, no `console.log`, no `dangerouslySetInnerHTML`, Zod on every route body, parameterized queries via Drizzle. Document deviations as comments inline; no code change unless violation found.
- [x] T003 [SETUP] [BE] Append five manifest entries to `devops-app/server/scripts-manifest.ts` atomically (`bootstrap/clone`, `bootstrap/compose-up`, `bootstrap/wait-healthy`, `bootstrap/finalise`, `bootstrap/hard-delete`) per `contracts/api.md` § Manifest entries — typed Zod schemas, `pat: z.string().describe("secret")` on clone, `outputArtifact` on finalise, `dangerLevel: high` on hard-delete. — Added new ScriptCategory `bootstrap` + folder map entry; five entries appended at end of manifest array.
- [x] T004 [SETUP] [DB] Extend `devops-app/server/db/schema.ts` with six new columns on `applications` (bootstrapState, bootstrapAutoRetry, upstreamService, upstreamPort, composePath, createdVia) and the new `appBootstrapEvents` pgTable per data-model.md — Drizzle typed columns only, no raw SQL strings, indexes declared in builder callback. — Only 4 columns added; `upstreamService`/`upstreamPort` already shipped in feature 008. `appBootstrapEvents` table added with 2 indexes.

**Sync barrier — Phase 1 complete before Phase 2 starts.**

---

## Phase 2: Foundational

- [x] T005 [DB] Create `devops-app/server/db/migrations/0009_bootstrap.sql`: ALTER applications add 6 columns, 3 CHECK constraints (bootstrap_state enum **including `failed_clone_pat_expired` per FR-016a**, created_via enum, upstream_port range), backfill `created_via='scan'` WHERE `skip_initial_clone=true`, CREATE app_bootstrap_events table + 2 indexes, DOWN migration in comment block. Reviewable static SQL, no string interpolation. (See T069 for follow-up migration if 0009 already shipped.) — Reviewable SQL written to `0009_bootstrap.sql`. Only 4 ALTERs (upstream_* shipped in 008). `failed_clone_pat_expired` folded into 0009 since not yet shipped to prod, T065 marked obsolete.
- [x] T006 [BE] Implement `devops-app/server/lib/slug.ts` (and re-export `deriveSlug` via `devops-app/server/lib/repo-slug.ts` if plan.md uses that name) — implements FR-006 6-step pipeline: (1) NFD-decompose + diacritic strip via `String.prototype.normalize('NFD').replace(/\p{Diacritic}/gu, '')`, (2) `transliterate()` (npm `transliteration`) for non-Latin → ASCII (Cyrillic/Greek/Hebrew/Arabic), (3) `toLowerCase()`, (4) replace non-`[a-z0-9]+` runs with single `-`, (5) trim leading/trailing `-`, (6) truncate 64 chars, (7) fallback `repo-<sha256(originalRepoName).slice(0,8)>` if empty. Typed signature `(repoName: string) => string`. Internal post-condition assertion: result MUST match `/^[a-z0-9]+(-[a-z0-9]+)*$/` — fail-fast `throw new Error('slug invariant broken')` on regex miss (programmer error, not operator error). Also export `validateSlug` and `isSlugUniqueOnServer` per FR-027 with typed I/O `{ ok: true } | { ok: false; error: string }`, parameterized Drizzle query for uniqueness. Standards: no `as any`, no `console.log`, no `throw new Error()` for operator-facing errors (use `AppError.badRequest` there).
- [x] T007 [BE] Implement `devops-app/server/lib/compose-parser.ts` — `parseCompose(yamlText): ParsedCompose` using `yaml.parse`, exported `ComposeService` interface, `pickPort` helper for `expose:`/`ports:` priority, detect `network_mode: host` and `deploy.replicas`. Per FR-004 graceful fallback: NEVER throw on operator-supplied compose. Return discriminated union — on YAML parse failure return `{ kind: 'yaml_invalid', error: <parse-error-string> }`; on zero services return `{ kind: 'no_services' }`; per-service, when a `ports:` value contains `${…}` interpolation or otherwise fails integer parse, mark service kind `{ kind: 'ambiguous_port', service: name, raw_value: '<string>' }` AND leave `upstream_port` UNSET (do not coerce, do not eval env) — caller surfaces operator prompt; success path returns `{ kind: 'ok', services: [...] }`. Throw only on programmer-error unreachable defaults. Standards: no `as any` (narrow via Zod or `unknown`), no `console.log`, typed return only.
- [x] T008 [BE] Implement `devops-app/server/lib/path-jail.ts` — `resolveAndJailCheck(serverId, remotePath, jailRoot)` over SSH using `readlink -f || realpath`, typed result union, trailing-slash-aware prefix check per FR-028 / R-008. Throws `PathJailEscapeError`. — Implemented as DI helper accepting an `ExecCapture` callback; `assertJailed` throws `PathJailEscapeError`.
- [x] T009 [BE] Implement `devops-app/server/lib/pat-redact.ts` — pino redact paths extension covering `req.body.pat`, `scriptRun.params.pat`, `auditEntry.details.pat`; export typed redactor for FR-015..FR-017 reuse; structured error `PatRedactionError` if pattern leaks past mask.
- [ ] T010 [BE] Extend `devops-app/server/services/github.ts` with `fetchDefaultBranch(token, owner, repo)` and `fetchComposeFile(token, owner, repo, path, ref?)` per plan.md § Repo selector. Typed JSON envelope decode, 404 → `null`, 403/401 → `GitHubApiError`. No `as any`.
- [ ] T011 [BE] Scaffold `devops-app/server/services/bootstrap-orchestrator.ts` — class skeleton with `start`, `retryFromFailedStep`, `hardDelete`, `canTransition` table, internal `onStepCompleted` dispatch table; transitions wrapped in DB transaction (UPDATE + INSERT app_bootstrap_events) before WS broadcast per R-012; typed `BootstrapStateError` thrown on forbidden transitions.
- [x] T012 [BE] Define typed error classes in `devops-app/server/lib/bootstrap-errors.ts`: `BootstrapStateError`, `PathJailEscapeError`, `ComposeFetchError`, `SlugCollisionError`, `RemotePathCollisionError`, `JailEscapeError`. All extend `AppError` with `{ code }` discriminator for client mapping. — Implementation note: codebase has no shared `AppError` base; classes extend `Error` directly (matching feature 005 / 008 pattern) and carry `readonly code` discriminator.

**Checkpoint — Phase 2 complete before any user-story phase starts.**

---

## Phase 3: User Story 1 — Onboard new app via wizard (P1)

**Goal**: operator picks a GitHub repo, optional domain, clicks Bootstrap, ends up with `bootstrap_state='active'` row + running container + (optional) Caddy + cert. State machine drives all six step transitions live.

**Independent test criteria**: a public repo with valid `docker-compose.yml` and one `expose:`-d service progresses INIT → CLONING → COMPOSE_UP → HEALTHCHECK → ACTIVE in ≤90s without operator intervention; WS events fire after DB commit; closing wizard mid-flow does not abort.

- [ ] T013 [BE] [US1] Implement `GET /api/github/repos/:owner/:repo/compose` in `devops-app/server/routes/github.ts` with Zod path/query validation, fallback `.yml` → `.yaml` per FR-003/R-013, returns `{ found, services, errors, warnings }`; structured 401/403/422 error responses.
- [ ] T014 [BE] [US1] Implement `POST /api/applications/bootstrap` in `devops-app/server/routes/bootstrap.ts` with Zod `bootstrapRequestSchema` validation, server-side slug regex enforcement (FR-027), upstreamService/Port both-or-neither check, **`composePath` validated via `validate-compose-path.ts` (T066) Zod refinement per FR-020a layer-1**, parameterized INSERT via Drizzle (Q1), append-INIT event, dispatch `orchestrator.start(appId, userId)` async; structured error responses (`SLUG_COLLISION`, `REMOTE_PATH_COLLISION`, `COMPOSE_NO_SERVICES`, `COMPOSE_PATH_UNSAFE`, `SSH_UNREACHABLE`); no `as any`.
- [ ] T015 [BE] [US1] Implement `GET /api/applications/:id/bootstrap-state` in `devops-app/server/routes/bootstrap.ts` per contracts/api.md — typed response with embedded events array via Q4 LATERAL JSONB_AGG, `currentRun` lookup against `script_runs`, 404/410 mapping; parameterized via Drizzle `sql` template.
- [x] T016 [OPS] [US1] Author `scripts/bootstrap/clone.sh` per plan.md snippet: source common.sh, parse `--remote-path`, `--repo-url`, `--branch`, idempotency check (`.git` + matching `remote.origin.url` → `git fetch && git reset --hard origin/<branch> && git clean -fdx` per FR-013 — `-fdx` mandatory to wipe untracked build artefacts/root-owned mounted-volume detritus from previous failed attempt), heredoc-reconstructed AUTH_URL with `$SECRET_PAT` (FR-029), exit codes 0/2/3 mapped to FR-013 cases. Standards: `set -euo pipefail`, no PAT in argv, stderr surfaced verbatim for downstream classifier.
- [x] T017 [OPS] [US1] Author `scripts/bootstrap/compose-up.sh`: parse `--remote-path`, `--compose-path`; `cd $REMOTE_PATH && docker compose -f $COMPOSE_PATH up -d --remove-orphans` per R-007. `set -euo pipefail`; common.sh sourced.
- [x] T018 [OPS] [US1] Author `scripts/bootstrap/wait-healthy.sh` reusing feature 006's wait-for-healthy polling tail (FR-011); skip silently when no healthcheck declared on `--compose-service`; exit 0 on healthy, non-zero on timeout with structured stderr.
- [x] T019 [OPS] [US1] Author `scripts/bootstrap/finalise.sh`: `git -C $REMOTE_PATH rev-parse HEAD`, emit `{"currentCommit":"<sha>"}` JSON line on stdout for `outputArtifact: stdout-json` capture per feature 005 R-005.
- [ ] T020 [BE] [US1] Wire `bootstrap-orchestrator.start()` flow in `devops-app/server/services/bootstrap-orchestrator.ts`: assert state=init, transition INIT→CLONING via DB tx, fetch PAT from `github_connection.token`, **re-validate `applications.compose_path` via `validate-compose-path.ts` (T066) immediately before SSH-command construction per FR-020a layer-3 TOCTOU defence — reject with `failed_compose` + structured event metadata if validator rejects**, dispatch `scriptsRunner.runScript("bootstrap/clone", ...)` with `appId` in params (for Q7 stuck-state lookup), subscribe to terminal via `jobManager.onJobEvent`; PAT never written to applications row.
- [ ] T021 [BE] [US1] Implement `onStepCompleted` dispatch table in `bootstrap-orchestrator.ts`: cloning→compose_up→healthcheck→(domain ? proxy_applied→cert_issued : active); each transition acquires deploy lock from feature 004 before COMPOSE_UP / HARD_DELETE per FR-021; failure path writes `failed_<step>` + Telegram notify hook.
- [ ] T022 [BE] [US1] Implement WS broadcasts `bootstrap.state-changed` and `bootstrap.step-log` from orchestrator + scriptsRunner log stream per R-010/R-012 — DB-first, broadcast-second; reuse `ws/broadcaster.ts`; typed event payloads.
- [ ] T023 [FE] [US1] Build `devops-app/client/lib/bootstrap-api.ts` typed REST client (POST bootstrap, GET state, retry, edit-config, hard-delete, GET compose) using shared fetch wrapper; map `{ code }` to typed error union; no `as any`.
- [ ] T024 [FE] [US1] Build `devops-app/client/hooks/useBootstrapState.ts` — combines REST snapshot (2s poll fallback per FR-026) and WS subscription, dedup by `lastAppliedOccurredAt`, typed return `{ state, events, currentRun }`.
- [ ] T025 [FE] [US1] Build `devops-app/client/components/bootstrap/ComposeDetectionView.tsx` — renders parsed services, single-port auto-pick, multi-port dropdown, zero-port manual input, warning banners for `network_mode: host` and `replicas > 1`; controlled inputs only, no `dangerouslySetInnerHTML`.
- [ ] T026 [FE] [US1] Build `devops-app/client/components/bootstrap/BootstrapWizard.tsx` — 5 steps (Repo / Detection / Domain / Advanced / Review) with controlled inputs, client-side slug validation mirroring server, Submit calls `POST /api/applications/bootstrap`, switches to progress view; closing modal does not abort (server-side state machine per FR-007).
- [ ] T027 [FE] [US1] Build `devops-app/client/components/bootstrap/BootstrapProgressView.tsx` — live step indicators driven by `useBootstrapState`, log tail per step subscribing to `bootstrap.step-log`, error states mapped from server `{ code }`.
- [ ] T028 [FE] [US1] Modify `devops-app/client/pages/ServerPage.tsx` to add the "Bootstrap from GitHub" button next to existing Add Application — opens `BootstrapWizard` modal scoped to current `serverId`.
- [ ] T029 [E2E] [US1] Add `devops-app/tests/integration/bootstrap-happy-path.test.ts` — mock GitHub Contents API + SSH executor, verify INIT→ACTIVE chain with all 7 `app_bootstrap_events` rows in correct order, current_commit persisted, Telegram notify fired exactly once.

---

## Phase 4: User Story 2 — Recover from partial failure (P1)

**Goal**: failed step preserves all data, operator clicks Retry (or Edit Config + Retry), bootstrap resumes idempotently from the failed step.

**Independent test criteria**: simulate failed_compose by injecting bad compose, click Retry → state transitions failed_compose→compose_up; idempotent re-run does not re-clone; chain progresses to ACTIVE; reconciler auto-retries when `bootstrap_auto_retry=true` up to 3 strikes.

- [ ] T030 [BE] [US2] Implement `POST /api/applications/:id/bootstrap/retry?from=<step>` in `devops-app/server/routes/bootstrap.ts` with Zod query validation, calls `orchestrator.retryFromFailedStep`, 400 INVALID_TRANSITION if `canTransition` rejects, 409 BOOTSTRAP_IN_PROGRESS if a `script_runs` row is currently running for the app.
- [ ] T031 [BE] [US2] Implement `PATCH /api/applications/:id/bootstrap/config` in `devops-app/server/routes/bootstrap.ts` with `editConfigSchema` Zod (FR-020 fields only), **`composePath` Zod refinement via `validate-compose-path.ts` (T066) per FR-020a layer-2**, reject `remotePath`/`repoUrl` with 400 IMMUTABLE_FIELD, 409 BOOTSTRAP_NOT_FAILED if state not failed_*, 400 `COMPOSE_PATH_UNSAFE` on validator reject; parameterized UPDATE via Drizzle.
- [ ] T032 [BE] [US2] Implement `bootstrap-orchestrator.retryFromFailedStep(appId, fromStep, userId)` — validate via `canTransition`, append `app_bootstrap_events` row with `metadata.reason='manual_retry'`, transition + dispatch the step's manifest entry; idempotent contract per FR-013 (clone fetch+reset, compose `up -d --remove-orphans`).
- [ ] T033 [BE] [US2] Implement `devops-app/server/services/bootstrap-reconciler.ts` — `setInterval(reconcile, 5*60_000).unref()` from `server/index.ts`, Q5 + Q6 + Q7 from data-model.md, 3-strike backoff per FR-022 with Telegram alert + auto-disable, env override `BOOTSTRAP_RECONCILER_INTERVAL_MS` (fallback `5*60_000` mirroring feature 005's prune timer).
- [ ] T034 [FE] [US2] Build `devops-app/client/components/bootstrap/EditBootstrapConfigDialog.tsx` — controlled form for `branch`, `composePath`, `upstreamService`, `upstreamPort`; `remotePath`/`repoUrl` display-only; submit calls PATCH endpoint; error states mapped from server `{ code }`.
- [ ] T035 [FE] [US2] Modify `devops-app/client/components/apps/ApplicationDetail.tsx` — Failed-state action bar with **Retry from <step>**, **Edit Config**, **Delete** buttons, disable Retry while a bootstrap script_run is running for the app.
- [ ] T036 [E2E] [US2] Add `devops-app/tests/integration/bootstrap-compose-failure.test.ts` — broken compose → failed_compose → Edit Config (`composePath`) → Retry → ACTIVE; verify event chain consistency (R-005 invariant 2).
- [ ] T037 [E2E] [US2] Add `devops-app/tests/integration/bootstrap-reconciler.test.ts` — `bootstrap_auto_retry=true` row in failed_clone, advance reconciler tick × 4, assert 3 retries then auto-disable + Telegram alert.

---

## Phase 5: User Story 3 — Bootstrap private repo with PAT (P2)

**Goal**: PAT injected at exec time only, never persisted on target, scrubbed from logs/audit/script_runs.params; PAT scope error produces actionable message + reconnect deeplink.

**Independent test criteria**: bootstrap a private repo, `ps`-snapshot during clone shows no `oauth2:ghp_*` substring; `script_runs.params.pat='***'`; pino log capture has no `ghp_*` substring; PAT-scope-insufficient error surfaces with deeplink to Settings → GitHub.

- [ ] T038 [BE] [US3] Implement PAT injection pipeline in `bootstrap-orchestrator.start()` — fetch PAT from `github_connection.token` at dispatch time, pass via env-var `SECRET_PAT` per feature 005 R-006, never on argv, never in `applications` row; cite FR-014..FR-017.
- [ ] T039 [BE] [US3] Wire pino redact in `devops-app/server/lib/logger.ts` to use `pat-redact.ts` paths; ensure `script_runs.params.pat` is masked to `"***"` at insert via feature 005's `serialiseParams` `secret` flag handling; verify `audit_entries.details.pat='***'`.
- [ ] T040 [BE] [US3] Implement scope-error detection in `bootstrap/clone` failure handler — pipe stderr+exitCode through `pat-error-classifier.ts` (T063) per FR-016a; on `kind='pat_expired'` write **`failed_clone_pat_expired`** state (NOT generic `failed_clone`) and append `app_bootstrap_events` row with `metadata = { error_kind: 'pat_expired', message }`; on `kind='sso_required'|'permission_denied'` write `failed_clone` with `metadata.errorMessage` referencing connection name + missing scope per FR-016; structured response with deeplink hint. Standards: typed discriminated input/output, no `as any`.
- [ ] T041 [FE] [US3] Modify `devops-app/client/components/bootstrap/BootstrapProgressView.tsx` — render PAT-scope-error variant with **Reconnect GitHub** deeplink to Settings → GitHub when error code matches `GITHUB_REPO_NOT_ACCESSIBLE` or scope error string.
- [ ] T042 [E2E] [US3] Add `devops-app/tests/integration/bootstrap-clone-failure.test.ts` — simulate PAT scope insufficient → failed_clone → reconnect → retry succeeds; assert no PAT substring in `script_runs.params`, `audit_entries.details`, or pino capture stream (SC-003).

---

## Phase 6: User Story 4 — Logs and Telegram on completion (P2)

**Goal**: every bootstrap step writes a `script_runs` row visible in feature 005's log viewer; Telegram fires once on ACTIVE and once on failed_<step>; Apps list renders BootstrapStateBadge with distinct yellow spinner.

**Independent test criteria**: bootstrap a repo end-to-end, observe N `script_runs` rows tagged `script_id='bootstrap/*'` in chronological order; Telegram receives exactly one success message (no per-step noise); Apps list badge spins during in-flight states and disappears at ACTIVE.

- [ ] T043 [BE] [US4] Wire `script_runs` integration per step in `bootstrap-orchestrator` — every `scriptsRunner.runScript` call links to `applications.id` via params.appId, retains `script_id='bootstrap/<step>'`; deploy-history view groups bootstrap script_runs as one composite entry per FR-023.
- [ ] T044 [BE] [US4] Implement Telegram notifier hook in `bootstrap-orchestrator` — single message on transition to `active` ("Bootstrapped: {name}") and on transition to any `failed_<step>` ("Bootstrap failed: {name} at {step}: {error}") per FR-024; suppress per-step success spam.
- [ ] T045 [FE] [US4] Build `devops-app/client/components/apps/BootstrapStateBadge.tsx` — spinning ring (yellow, distinct shape from feature 006 health dot) for in-flight states, red badge with "Failed at <step>" tooltip for failed_*, no badge for active per FR-025. **For state `failed_clone_pat_expired` (FR-016a): distinct icon + tooltip "GitHub authentication failed"; failed-state action panel renders "Reconnect GitHub" deeplink button to feature 002 connection-edit page (`?connectionId=<id>`) plus a "Retry" button disabled-with-tooltip ("Re-save the GitHub connection first") until operator re-saves the connection.** Standards: no `dangerouslySetInnerHTML`, typed props.
- [ ] T046 [FE] [US4] Modify `devops-app/client/components/apps/AppsList.tsx` — render `BootstrapStateBadge` next to feature 006's health dot, add `<CreatedViaFilter>` dropdown (`all|manual|scan|bootstrap`) persisted to localStorage per FR-033, query backend with `?createdVia=` param (Q9).
- [ ] T047 [E2E] [US4] Add `devops-app/tests/integration/bootstrap-ws-stream.test.ts` — assert `bootstrap.state-changed` events fire after DB commit, `bootstrap.step-log` lines stream from each script_run, ordering preserved against `occurredAt`.
- [ ] T048 [E2E] [US4] Add `devops-app/tests/integration/bootstrap-domain-inline.test.ts` — bootstrap with domain set → PROXY_APPLIED + CERT_ISSUED via feature 008 → ACTIVE; assert `app_certs` row created, Caddy site present per FR-012.

---

## Phase 7: Polish

- [ ] T049 [BE] Build hard-delete flow: `POST /api/applications/:id/hard-delete` in `devops-app/server/routes/bootstrap.ts` with `hardDeleteSchema` Zod, server-side `confirmName === applications.name` check (FR-027), `bootstrap-orchestrator.hardDelete` ordering per FR-021 (cert revoke → compose down -v → realpath jail check → rm -rf → DELETE applications); 422 JAIL_ESCAPE on jail failure, 503 SSH_UNREACHABLE with `stagesCompleted/Failed` detail.
- [x] T050 [OPS] Author `scripts/bootstrap/hard-delete.sh` — invoked via `bootstrap/hard-delete` manifest entry; performs `readlink -f || realpath` jail check inline (R-008), `docker compose down -v`, `rm -rf $RESOLVED`; exits non-zero on jail escape with stderr `JAIL_ESCAPE: <resolved>`.
- [ ] T051 [FE] Build `devops-app/client/components/bootstrap/HardDeleteDialog.tsx` — two-radio cleanup mode, typed-confirm input that must equal `applications.name`, Confirm disabled until match; map server-side 422 JAIL_ESCAPE / 503 SSH_UNREACHABLE to actionable error UI; no `dangerouslySetInnerHTML`.
- [ ] T052 [E2E] Add `devops-app/tests/integration/bootstrap-hard-delete.test.ts` — typed-confirm enforced server-side, FR-021 ordering verified (cert before compose-down before rm), JAIL_ESCAPE rejection on symlink-to-/etc test fixture.
- [ ] T053 [SEC] Security audit pass on PAT handling — verify three-layer defence (DB write-time masking, manifest secret schema, heredoc env-var transport); grep `script_runs.params`, `audit_entries.details`, pino capture for `ghp_*` and `github_pat_*` patterns; reference FR-015..FR-017, FR-029. Document findings in `specs/009-bootstrap-deploy-from-repo/security-review.md`.
- [ ] T054 [SEC] Security audit on path-jail (FR-028) — escape-attempt test suite: `apps/../../../etc`, symlink `apps/foo → /`, absolute path outside jail, BusyBox vs GNU `readlink` parity; assert `rm -rf` never fires on resolution outside `${DEPLOY_USER_HOME}/apps/`.
- [ ] T055 [SEC] Security audit on injection vectors — slug regex (FR-027), `composePath` shell metachar rejection, `branch` regex consistency with feature 005 BRANCH_REGEX, GitHub `owner/repo` path-param sanitisation, no string interpolation in any SQL.
- [ ] T056 [BE] Regression check on builtin deploy path — bootstrap-created apps with `created_via='bootstrap'` and `skip_initial_clone=false` (FR-031) trigger feature 005's `deploy/server-deploy` correctly on next deploy; idempotent fast-path "already cloned" works.
- [ ] T057 [BE] Implement stuck-state recovery in `bootstrap-reconciler.ts` per Q7 / R-012 — apps in non-failed in-flight states with no `script_runs` row currently `running` get re-dispatched once; structured logging.
- [ ] T058 [FE] Polish hard-delete UX — show stage-by-stage progress (cert revoke → compose down → rm), success toast with `removed` summary, error states show partial-cleanup `stagesCompleted/Failed` per route 503 detail.
- [ ] T059 [BE] Add unit tests `devops-app/tests/unit/{slug,compose-parser,path-jail,pat-redact,bootstrap-state-machine,bootstrap-orchestrator}.test.ts` covering FR-006/FR-027 metachars, compose edge cases (replicas, network_mode host), jail escape scenarios, redaction completeness, valid/invalid transitions, retry-from-failed step matrix.
- [ ] T060 [BE] Add `bootstrap-pat-leak.test.ts` integration verifying SC-003 zero-leak gate against `script_runs.params`, `audit_entries.details`, pino capture, simulated `ps -ef` snapshot during clone.

**Sync barrier — Phase 7 complete = feature shippable.**

---

## Phase 8: Review-pass additions (2026-04-28 — Gemini + GPT)

These tasks are appends from the Gemini + GPT review pass. Amendments to T001, T005, T006, T007, T014, T016, T020, T031, T040, T045 are inline above.

- [x] T061 [BE] [US1] Slug helper test suite at `devops-app/tests/unit/repo-slug.test.ts` — minimum 20 fixtures covering FR-006 pipeline: pure ASCII (`my-app`), Latin-extended (`Café`, `Naïve`), Cyrillic (`Мой-Супер-Проект`, `Россия`), Greek (`Αθήνα`), Hebrew/Arabic, emoji-only (`🔥💯` → `repo-<hash>`), CJK without table coverage (`日本語` → `repo-<hash>`), boundary at 64 chars (truncation), leading/trailing dashes, all-special-chars (`!!!@@@` → `repo-<hash>`), empty string, single char (`a`), reserved Windows names (`con`, `nul`), mixed-case (`CamelCase`), repeated dashes (`a---b` → `a-b`), digits-only (`123`), unicode whitespace. Each fixture asserts (a) result matches `^[a-z0-9]+(-[a-z0-9]+)*$`, (b) determinism (same input → same output across two calls). Standards: typed test fixtures, no `as any`, vitest `describe.each`.
- [x] T062 [BE] [US1] Compose-parser test suite at `devops-app/tests/unit/compose-parser.test.ts` — covers FR-004 graceful fallback: env-var interpolation (`${APP_PORT}` → `kind: 'ambiguous_port'`, `${HOST_PORT:-3000}` → ambiguous), zero services (`{ kind: 'no_services' }`), malformed YAML (`{ kind: 'yaml_invalid', error: ... }`), multi-service detection (operator-prompt branch), `network_mode: host` warning flag, `deploy.replicas: 3` flag, valid single-service happy path, `expose:`/`ports:` priority. Standards: discriminated-union narrowing in tests, no `as any`.
- [x] T063 [BE] [US3] Build `devops-app/server/lib/pat-error-classifier.ts` — typed input `{ stderr: string; exitCode: number }` → discriminated output `{ kind: 'pat_expired' | 'sso_required' | 'permission_denied' | 'other'; message: string }`. Patterns per FR-016a: `Authentication failed for 'https://github.com/...'` → `pat_expired`; `Permission ... denied to ...` → `permission_denied`; `SSO ...` / `single sign-on` → `sso_required`; else `other`. Pure function, no I/O, no `as any`, no `console.log`.
- [x] T064 [BE] [US3] Unit tests `devops-app/tests/unit/pat-error-classifier.test.ts` — every kind, plus edge cases (empty stderr, mixed patterns, exitCode=0 anomaly).
- [x] T065 [DB] [US3] Follow-up migration `devops-app/server/db/migrations/0010_bootstrap_pat_expired.sql` — N/A: folded `failed_clone_pat_expired` directly into 0009 since 0009 has not shipped to prod. No 0010 file created. — IF migration `0009_bootstrap.sql` already shipped to prod, ALTER the bootstrap_state CHECK constraint to add `'failed_clone_pat_expired'`. Reviewable static SQL, DOWN block in comment. (Skip / fold into T005 if 0009 not yet shipped — note in PR description.)
- [x] T066 [BE] [US1] Build `devops-app/server/lib/validate-compose-path.ts` — mirrors feature 007 `validate-script-path.ts` pattern. Typed signature `(input: unknown) => { ok: true; value: string } | { ok: false; code: 'unsafe_path' | 'wrong_extension' | 'too_long'; message: string }`. Rules per FR-020a: printable ASCII `^[\x20-\x7E]+$`, ≤256 chars, no `..` substring, no `\\`, no leading `/`, MUST end `.yml` or `.yaml`. Reject non-string at runtime → `unsafe_path`. No coercion, no `as any`, no `throw new Error()` for operator input — only `ok:false` returns. Pure function.
- [x] T067 [BE] [US1] Unit tests `devops-app/tests/unit/validate-compose-path.test.ts` — happy path (`docker-compose.yml`, `services/api/compose.yaml`), `..` reject, `\\` reject, leading `/` reject, wrong extension (`.txt`, `.yaml.bak`), >256 chars, non-printable bytes, non-string input.
- [ ] T068 [FE] [US1] Inline compose-path validation hint in `devops-app/client/components/bootstrap/BootstrapWizard.tsx` (Advanced section) and `devops-app/client/components/bootstrap/EditBootstrapConfigDialog.tsx` (T034) — debounced (300ms) call to existing route's validation refinement; surface error code → user-friendly message ("Path contains `..`", "Must end in .yml or .yaml", "Path too long (max 256)"). Standards: controlled input, no `dangerouslySetInnerHTML`, typed error mapping union.
- [ ] T069 [BE] [POLISH] Implement `GET /api/servers/:serverId/bootstraps?status=in_flight|failed|active` in `devops-app/server/routes/bootstrap.ts` per FR-026a — Zod-validated path + query, parameterized Drizzle query joining `applications` + latest `app_bootstrap_events` row (LATERAL), sorted in-flight first then `created_at desc`. Typed response envelope. No raw SQL, no `as any`.
- [ ] T070 [FE] [POLISH] Build `devops-app/client/components/bootstrap/BootstrapHistoryPanel.tsx` per FR-026a — table view (app name, current `bootstrap_state`, created_at, last state-change). Per-row action by state: in-flight → "Resume monitoring" (re-opens `BootstrapWizard`/`BootstrapProgressView` scoped to `appId`); `failed_*` → "Retry / Edit Config / Hard Delete"; `active` → "View App". Default sort: in-flight first. Standards: controlled inputs only, no `dangerouslySetInnerHTML`, typed props, error states mapped from `{ code }`.
- [ ] T071 [FE] [POLISH] Integrate `BootstrapHistoryPanel` into `devops-app/client/pages/ServerPage.tsx` (sub-tab or above the Apps list — implementation choice per plan.md). Live-update via existing WS channel `bootstrap.state-changed` (refetch on event). Standards: no `dangerouslySetInnerHTML`, typed WS payloads.

> Cross-story note: T066 underpins layer-1 (T014, US1) and layer-2 (T031, US2) Zod refinements plus layer-3 (T020, US1) runner-side TOCTOU defence. The validator itself is labelled US1 since the wizard is its primary entry point; layer-2 reuse in US2's Edit Config is tracked via T031's amendment. FR-026a (T069..T071) lacks a dedicated User Story in spec.md → labelled `[POLISH]` per spec-tasks convention (UX nicety added late in review).

---

## Dependency Graph

```
T001 → T003
T002 → T003
T001 + T002 → T004
T001 + T002 + T003 + T004 → T005

T004 → T006
T004 → T007
T004 → T008
T004 → T009
T004 → T010
T005 → T011
T006 + T008 + T009 + T010 → T011
T011 → T012

T010 → T013
T011 + T012 → T014
T011 → T015
T003 → T016
T003 → T017
T003 → T018
T003 → T019
T011 + T016 → T020
T020 → T021
T021 → T022
T014 + T015 → T023
T022 + T023 → T024
T007 → T025
T013 + T024 + T025 → T026
T024 → T027
T026 + T027 → T028
T020 + T021 + T022 + T026 + T027 → T029

T011 → T030
T011 → T031
T021 → T032
T032 → T033
T031 → T034
T030 + T034 → T035
T032 + T035 → T036
T033 → T037

T020 → T038
T009 + T038 → T039
T038 → T040
T027 + T040 → T041
T038 + T039 + T040 → T042

T020 → T043
T021 → T044
T022 → T045
T045 → T046
T022 + T043 → T047
T043 + T044 → T048

T008 + T021 → T049
T008 + T050 → T049
T003 + T008 → T050
T049 + T050 → T051
T049 + T050 + T051 → T052
T038 + T039 + T042 → T053
T008 + T050 → T054
T006 + T013 + T014 → T055
T020 + T021 → T056
T033 → T057
T051 + T052 → T058
T006 + T007 + T008 + T009 + T011 + T021 + T032 → T059
T038 + T039 + T042 → T060
```

### Update 2026-04-28 (review-pass tasks)

```
T006 → T061
T007 → T062
T012 → T063
T063 → T064
T005 → T065
T012 → T066
T066 → T067
T026 + T034 + T066 → T068
T015 → T069
T024 + T069 → T070
T028 + T070 → T071
T063 → T040
T065 → T040
T066 → T014
T066 → T031
T066 → T020
```

---

## Parallel Lanes

| Agent | Phase 1 | Phase 2 | Phase 3 (US1) | Phase 4 (US2) | Phase 5 (US3) | Phase 6 (US4) | Phase 7 |
|---|---|---|---|---|---|---|---|
| `[SETUP]` | T001, T002, T003, T004 | — | — | — | — | — | — |
| `[DB]` | T004 (shared) | T005 | — | — | — | — | — |
| `[BE]` | T002, T003 | T006, T007, T008, T009, T010, T011, T012 | T013, T014, T015, T020, T021, T022 | T030, T031, T032, T033 | T038, T039, T040 | T043, T044 | T049, T056, T057, T059, T060 |
| `[FE]` | — | — | T023, T024, T025, T026, T027, T028 | T034, T035 | T041 | T045, T046 | T051, T058 |
| `[OPS]` | T001 (shared) | — | T016, T017, T018, T019 | — | — | — | T050 |
| `[E2E]` | — | — | T029 | T036, T037 | T042 | T047, T048 | T052 |
| `[SEC]` | — | — | — | — | — | — | T053, T054, T055 |

---

## Agent Summary

| Agent | Task count |
|---|---|
| `[SETUP]` | 4 (T001..T004) |
| `[DB]` | 2 (T004, T005 — T004 shared with SETUP) |
| `[BE]` | 31 |
| `[FE]` | 12 |
| `[OPS]` | 6 |
| `[E2E]` | 8 |
| `[SEC]` | 3 |
| **Total** | **60** |

Per User Story:

| Story | Tasks |
|---|---|
| US1 (Onboard) | T013..T029 — 17 |
| US2 (Recover) | T030..T037 — 8 |
| US3 (PAT) | T038..T042 — 5 |
| US4 (Logs/Telegram) | T043..T048 — 6 |
| Setup + Foundation | T001..T012 — 12 |
| Polish | T049..T060 — 12 |

---

## Critical Path

```
T001 → T003 → T004 → T005 → T011 → T020 → T021 → T026 → T029 → T049 → T052 → T053
```

Length: 12 tasks. MVP-blocking — every other task is either parallelisable inside its phase or polish-tier.

---

## Implementation Strategy

**MVP scope** = Phase 1 + Phase 2 + Phase 3 (US1). At T029 green: a public-repo bootstrap reaches ACTIVE end-to-end with state machine, WS, and progress UI. Ship-gate.

**P1 complete** = MVP + Phase 4 (US2 Retry/Edit Config/reconciler). At T037 green: failed bootstraps recoverable without re-cloning; auto-retry available.

**P2 complete** = + Phase 5 (US3 PAT) + Phase 6 (US4 Logs/Telegram). At T048 green: private repos bootstrap safely; ops visibility complete; Apps list filters by `created_via`.

**Hardened release** = + Phase 7. Hard-delete with jail check shipped (T049..T052), three security audits passed (T053..T055), regression on builtin deploy (T056), stuck-state recovery (T057), unit + leak tests (T059, T060).

Lane execution: SETUP fans out to DB+BE+FE+OPS in parallel inside each US phase. The orchestrator (T011, T020, T021) is the throughput bottleneck — keep it as one BE owner. SEC tasks run last (T053..T055) once attack surface is fully assembled.

Standing-order checks: T001 (yaml dep) blocks until user approves per Standing Order #2. T005 (migration) ships as reviewable SQL per Standing Order #5. T049/T050 (hard-delete) gated by typed-confirm + jail check per Standing Order #6.
