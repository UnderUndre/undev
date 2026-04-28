# Research: Bootstrap Deploy from GitHub Repo

**Phase 0 output** | **Date**: 2026-04-28

---

## R-001: Compose pre-fetch — GitHub Contents API vs full clone

**Decision**: Use the GitHub Contents API (`GET /repos/:owner/:repo/contents/:path[?ref=:branch]`) to fetch the compose file before any SSH happens. No clone-to-tmp, no SSH round-trip in the wizard's detection step.

The Contents API returns a JSON envelope `{ content: "<base64>", encoding: "base64" }`. Decode to UTF-8, parse with `yaml.parse`. Single HTTP request, ~200 ms median latency from the dashboard host (the same host that already has the GitHub PAT and rate-limit budget tracked in feature 002).

**Rate-limit math**: feature 002 documents 5 000 requests/hour for authenticated PATs (FR-037 there). The Contents API call counts against the same bucket. A bootstrap wizard interaction is at most 4 GitHub API calls (repo metadata for default branch + recent-20 list + 1 search + 1 contents fetch), and operators bootstrap dozens of apps a day, not thousands. Headroom is comfortable.

**Fallback when API blocked**: if the Contents API returns 404 (file missing), retry with `.yaml` extension per FR-003. If 403 (PAT scope insufficient — `Contents: read` not granted), surface the error with a deeplink to reconnect. Never fall through to a clone — the operator already failed at "select a repo we can read", and a clone would be slower and produce the same auth error.

**Rationale**: clone-then-read is a 5–30 second SSH operation that only adds value if the operator wants the bytes ON the target. We don't — we want the bytes in dashboard memory just to render Step 2 of the wizard. The CLONING step (which DOES need the bytes on the target) happens later, owned by the orchestrator.

**Alternatives considered**:

- **Clone-to-target before detection**: 5–30s wait before the wizard can show service detection. Bad UX. Also wastes work if the operator changes their mind after seeing "0 services" and aborts — the clone stays on the target as garbage.
- **Clone-to-tmp on dashboard host then read locally**: requires git binary on the dashboard host (currently it's a node container with no git). Also fails for private repos because feature 002 didn't deploy a credential helper on the dashboard host.
- **Subscribe to GitHub webhook on push, cache compose content**: massive over-engineering for a one-shot detection step.

---

## R-002: Compose YAML parser library choice

**Decision**: Add `yaml` (eemeli/yaml, ~2.6.0, MIT, ~17 kB minified) as a runtime dependency. Justified: there is no YAML parser in `package.json` today (verified — the dependency block has `cookie`, `cors`, `drizzle-orm`, `express`, `lru-cache`, `pino`, `postgres`, `ssh2`, `uuid`, `ws`, `zod`, plus the `@underundre/undesign` package; none of these parse YAML).

Pinned at `^2.6.0` (caret — patch + minor updates). The `yaml` package follows semver strictly; minor bumps (2.6 → 2.7) are additive features; patch bumps fix bugs. Major bumps (2.x → 3.x) are explicit dashboard-release events.

**Rationale**:
- `yaml.parse` handles all the compose-yaml shapes we care about — anchors (`&x` / `*x`), multi-line strings, `null` distinction (vs empty string).
- Same upstream that the Compose CLI uses internally for some validation flows.
- 17 kB cost vs hand-rolled parser of ~300 lines that would need 30+ test cases.
- No native deps; Node-only; works in our `node:25` container.

**Alternatives considered**:

- **`js-yaml`**: older, slightly larger, slightly slower; YAML 1.1 spec only (we need YAML 1.2 for some compose extensions like `!!str` tag handling). Rejected.
- **Hand-rolled regex parser**: would silently fail on multi-line `command:` values, anchors, nested ports lists. The whole point of compose detection is correctness — bugs here cause wrong upstream-port choices in production.
- **Spawn `docker compose config` on the dashboard host**: requires Docker on the dashboard host; defeats the "pre-fetch without target involvement" model.

**Approval trigger** (CLAUDE.md Standing Order #2): user approval requested at task execution time before `npm install yaml`.

---

## R-003: PAT injection technique — heredoc vs env-var vs URL-embedded

**Decision**: Three-layer combo — env-var transport (feature 005's secret pattern) PLUS heredoc reconstruction inside the on-target script. The PAT is exported as `$SECRET_PAT` to the `bash` process via feature 005's existing env-var routing (R-006 there), and the script rebuilds the authenticated URL via:

```bash
AUTH_URL=$(cat <<EOF
${REPO_URL/https:\/\//https://oauth2:$SECRET_PAT@}
EOF
)
git clone --branch "$BRANCH" "$AUTH_URL" "$REMOTE_PATH"
```

The PAT lives in three places only during a clone: (a) the dashboard's process memory, (b) the SSH-encrypted data channel as part of the script bytes, (c) the bash process environ on the target. None of (a), (b), or (c) are visible to `ps`, `auditd execve`, or `script_runs.params`.

**Threat-model coverage** (extends feature 005 R-006's table):

| Exposure path | Blocked by |
|----|----|
| `SELECT * FROM script_runs` | feature 005 R-006 layer 1 (mask `secret`-marked params to `"***"`) |
| Pino log scrape | feature 005 R-006 layer 1 (pino redact paths) |
| `audit_entries` query | feature 005 R-006 layer 1 (audit middleware mask) |
| `ps auxwww` on target during clone | env-var transport — never on argv |
| Target `auth.log` / `auditd execve` | env-var transport — sshd / auditd see only `bash -s --` |
| `git clone` URL on argv (visible to `ps` for milliseconds) | heredoc reconstruction — URL is constructed inside the bash process, written to a local var, never on argv |
| `~/.netrc` / `git config --global credential.helper store` | FR-017 — explicitly avoided; one-shot clone |
| Git's `~/.cache/git/credential/socket` (libsecret helper) | Not configured; git's default helper is `cache` with 0s timeout when no helper is set |

**Rationale**: URL-embedded-on-argv (`git clone https://oauth2:$PAT@github.com/.../...`) is the simplest form but fails the `ps`-during-clone test. Env-var alone (`GIT_ASKPASS=...`) requires a writable script on the target, which violates the no-target-state invariant. Heredoc reconstruction inside the script keeps the PAT in the bash process and out of every observability surface we care about.

**Alternatives considered**:

- **`GIT_ASKPASS` script**: would need to write a small shell script on the target that echoes the PAT — adds target-side state (FR-017 violation) and an extra `chmod 700`/`rm` cycle.
- **HTTPS git config global helper with cache**: sets process-wide credential-helper state on the target; subsequent fetches by other processes (e.g. an unrelated cron) would inherit the cache. Forbidden by FR-017.
- **SSH-key-based clone**: feature 002 supports this for the connection itself, but generates per-account SSH keys, not per-repo. Still safe; included as the alternate clone form per FR-014. The heredoc decision applies only to PAT-based clones.

---

## R-004: Slug uniqueness scope — per-server vs global

**Decision**: Per-server uniqueness. Mirrors feature 008's domain UNIQUE decision (`UNIQUE (server_id, domain) WHERE domain IS NOT NULL`, FR-001 there) — the same operational pattern: legitimate operators need the same name on different servers (staging vs prod), and a global unique would prevent that.

Concretely the constraint is enforced by the existing `applications` schema: `name` is not currently UNIQUE in any form, but feature 003's import flow already serialises by `(server_id, name)` collision check via `SELECT 1 FROM applications WHERE server_id = ? AND name = ?`. Bootstrap inherits that — the `validateSlug` helper has an `isSlugUniqueOnServer(serverId, slug, excludeAppId?)` companion that performs the same check before insert.

A hard `UNIQUE(server_id, name)` index would be cleaner but is out of scope here — it's a feature 003 cleanup. We're consistent with existing behaviour.

**Edge case** — collision with a soft-deleted (FR-021 default) app row: rejected at the form validation level. Operator must hard-delete the soft-deleted row first or pick a different slug. No automatic numeric suffix — that creates "invisible duplicates" per the spec's Edge Cases section.

**Rationale**: aligning with feature 008's per-server UNIQUE keeps operator mental model coherent — domains and slugs both scope to one server, both can repeat across servers (HA / DR scenarios).

**Alternatives considered**:

- **Global UNIQUE**: blocks the legitimate "same name, two servers" case. Ergonomic regression.
- **No UNIQUE, allow operators to typo a duplicate**: silently creates two `applications` rows with the same name, which then make `WHERE name = ?` queries undefined behaviour for downstream code (e.g. feature 003's dedup).
- **Cluster-wide UNIQUE with a "force" override**: extra column flag, extra UI, never used in practice.

---

## R-005: State machine persistence — single column + audit table vs per-step columns

**Decision**: Single column `applications.bootstrap_state TEXT NOT NULL` plus an append-only `app_bootstrap_events (from_state, to_state, occurred_at, metadata, actor)` table.

**Why not per-step columns** (`cloning_started_at`, `cloning_completed_at`, `compose_started_at`, ...): it scales linearly with step count, and the next minor schema change would need a fresh migration column. Worse, querying "show me all apps currently stuck at compose_up for >5 min" becomes a `WHERE compose_started_at IS NOT NULL AND compose_completed_at IS NULL AND compose_started_at < NOW() - INTERVAL '5 min'` mess across N columns.

**Why an audit table at all** (vs only the column): the column is the snapshot ("where are we right now?"). The audit table is the chain ("how did we get there?"). Two distinct read patterns:

- Wizard renders current state → `SELECT bootstrap_state FROM applications WHERE id = ?`. Single-row, indexed PK lookup.
- Debug "why did this app fail at proxy" → `SELECT * FROM app_bootstrap_events WHERE app_id = ? ORDER BY occurred_at`. Multi-row chain with metadata blob (error message, retry count, container ids).

Storage cost: ~7 transitions per successful bootstrap × 200 bytes/row × 1000 apps = 1.4 MB. Negligible. Retention: append-only, no prune.

**Indexable filters** justify the table:

- `idx_app_bootstrap_events_app_occurred(app_id, occurred_at DESC)` — chain reads.
- `idx_app_bootstrap_events_to_state` — admin query "how many apps failed at compose_up this week".

**Rationale**: column = present, table = past. Standard event-sourcing-lite pattern. Same shape as feature 008's `app_cert_events` (FR-020 there), so the codebase has one canonical "audit a state machine" template instead of two competing patterns.

**Alternatives considered**:

- **Per-step columns**: loses chain semantics, painful migrations, painful queries.
- **Single JSON `bootstrap_history JSONB[]`**: unindexed; admin queries become `jsonb_path_query` mess.
- **Reuse `script_runs` for bootstrap audit**: doable but conflates two abstractions — `script_runs` is "an SSH command was invoked", `app_bootstrap_events` is "a state machine transitioned". A cancelled retry is a state transition with no `script_runs` row; an admin clicking Retry on an `active` app is a state transition rejected before any run. Cleaner to keep them separate.

---

## R-006: Background reconciler scheduling — `setInterval` vs cron lib vs DB job queue

**Decision**: `setInterval(reconcile, 5 * 60_000).unref()` in `server/services/bootstrap-reconciler.ts`, started from `server/index.ts` after the existing scriptsRunner startup hooks. `unref()` ensures process exit isn't blocked.

Mirrors feature 005's pattern for `pruneOldRuns` (R-010 there): the dashboard is a long-running single-process Node server; introducing a separate cron container or a DB-backed job queue (BullMQ, pg-boss) is over-engineering for one job type with one schedule.

**Concurrency-safety**: the reconciler iterates failed-state rows sequentially. Each retry calls `orchestrator.retryFromFailedStep(appId, ...)` which acquires the deploy lock via feature 004 — concurrent retries on the same server are serialised at that layer. Cross-server retries proceed in parallel (each has its own lock).

**Ordering**: rows are processed in arbitrary order (no `ORDER BY` clause). Operationally fine — none of the reconciler's actions depend on inter-row ordering.

**Disable hatch**: `BOOTSTRAP_RECONCILER_INTERVAL_MS=0` skips the timer entirely. Useful for tests and for operators who prefer manual-only retries.

**Rationale**: simplest possible implementation that satisfies FR-022. Same shape as the `pruneOldRuns` timer; one more pattern instance, no new abstraction.

**Alternatives considered**:

- **`node-cron` lib**: adds a dependency for one scheduled job. Rejected — Standing Order #2.
- **pg-boss / BullMQ**: queues per-app jobs in DB. Justified only if we needed delayed retries (e.g. exponential backoff up to days). FR-022 specifies "every 5 minutes, stop after 3" — bounded; doesn't need queue infra.
- **Per-app `setTimeout`**: leaks memory if the dashboard restarts mid-cycle (timers vanish on restart, and the next cycle is N minutes away). The setInterval pattern recovers from a restart in ≤5 minutes.

---

## R-007: Retry idempotency for COMPOSE_UP

**Decision**: Always `docker compose -f <composePath> up -d --remove-orphans`. The `up -d` command is idempotent by design — Docker compose checks each service's desired vs actual state and only re-creates containers whose definition changed.

Edge cases verified against the live Docker compose v2 behaviour:

- **Containers already up + image unchanged**: compose prints "Container <name> Running" and exits 0. No-op.
- **Containers up + image tag changed (e.g. `:latest` re-pulled)**: compose recreates the container. Healthcheck restart cycle re-runs.
- **Containers down (exited, but `docker ps -a` rows exist)**: compose recreates and starts. No-op for definition-unchanged services.
- **Volume already exists with the right name**: compose attaches; no data loss.
- **Network already exists**: compose attaches.
- **Port conflict on host (host port already taken by another stack)**: `up -d` fails with `port is already allocated`. State `failed_compose`. Retry blocks until the operator fixes the conflict — this is the correct behaviour (the bootstrap is genuinely impossible, no auto-fix).

**`--remove-orphans` is critical**: feature 002's recent commit history (`8014813 chore(deploy): remove orphaned named containers before compose up`, `8f01281 fix(deploy): handle missing compose files gracefully in container cleanup`) shows this codebase already learned that lesson. Without it, a renamed service from a previous bootstrap leaves a zombie container that confuses subsequent `docker ps`.

**Rationale**: compose's own idempotency contract is the cheapest possible "retry policy". We don't reinvent.

**Alternatives considered**:

- **Detect "already up" and skip**: needs `docker compose ps --format json` parse; brittle across compose versions; offers no real win over letting compose decide.
- **Always `down` before `up`**: defeats the purpose of idempotency — every retry would cause a downtime window. Bad.
- **`up --force-recreate`**: recreates even unchanged services; wastes 30+ seconds on retries that don't need it. Only useful if we suspect drift, which we don't in the retry path.

---

## R-008: Path jail check via SSH `realpath`

**Decision**: Use `readlink -f` (preferred) with `realpath` fallback inside the same SSH command that will perform the `rm -rf`. The resolved path is captured to stdout, the dashboard parses it, and only proceeds with rm if the resolved path starts with `${jailRoot}/` (trailing-slash-aware).

```bash
# Single SSH session — TOCTOU window is one connection lifetime, not seconds
RESOLVED=$(readlink -f '<remotePath>' 2>/dev/null || realpath '<remotePath>' 2>/dev/null)
[[ "$RESOLVED" == "/home/deploy/apps/"* ]] || { echo "JAIL_ESCAPE: $RESOLVED" >&2; exit 1; }
rm -rf "$RESOLVED"
```

**Why on-target rather than dashboard-side**: a dashboard-side `path.resolve` resolves against the dashboard's filesystem, not the target's. Symlinks on the target wouldn't be followed. The check MUST happen where the target's filesystem is the canonical reality.

**Why both `readlink -f` and `realpath`**: BusyBox's `readlink` doesn't have `-f`; `realpath` exists on most modern systems but isn't POSIX. The OR fallback covers both Alpine and Debian.

**TOCTOU mitigation**: the resolution and the `rm` happen in the same SSH session via a chained command — the symlink can theoretically change between `readlink` and `rm` only if an attacker has root on the target during the millisecond window. That's an out-of-scope threat model (admin-on-admin compromise).

**Rationale**: defends against the realistic attack surface (operator manually edited `applications.remote_path` to point at `/etc`, or symlinked `apps/foo` → `/`). Doesn't try to defend against a compromised target.

**Alternatives considered**:

- **Hard-coded path comparison without resolving**: trivially defeated by `apps/../../../etc`. Insufficient.
- **Reject if `..` appears in the original path**: blocks legitimate edge cases (dashboard might generate paths with `..` after future migrations). Brittle.
- **Resolve dashboard-side via mocked filesystem**: requires the dashboard to know the target's filesystem topology including symlinks. Impossible without a full SSH+stat tree, which is what `readlink -f` already does in one call.

---

## R-009: GitHub Search API rate-limit accounting

**Decision**: 60-second LRU cache keyed by `(account_id, query_string)`, sized to 256 entries — bounded by `lru-cache` (already in `package.json`). Cache hits return immediately without an API call. Cache misses issue the GitHub Search API call, store the result, and return.

The Search API budget is 30 requests/minute (per FR-002a in spec). With a 300ms debounce (FR-002), an interactively-typing operator generates ~3 unique queries/second × 60 seconds = 180/minute IF every keystroke produced a unique query. With the cache, any backspaces/retypes hit the cache, not the API. Realistic usage: 5–10 unique queries per wizard invocation, well under budget.

**Per-account vs per-token vs global accounting**: per-account (the `github_connection` singleton). The dashboard has one connection at a time (FR-002 in feature 002), so the cache is effectively global to the dashboard. Future multi-tenant dashboard support would need to extend the cache key — out of scope for v1.

**Rate-limit error handling**: if the API returns 403 with `X-RateLimit-Remaining: 0`, the dashboard surfaces "GitHub Search API rate-limited; retry in <reset>" and disables the search input until the reset timestamp. Recent searches stay accessible from the LRU cache.

**Rationale**: matches feature 002's existing `searchRepos` LRU cache shape (5-min TTL there for the broader repo search; we tighten to 60s for the bootstrap wizard's search-as-you-type). One more LRU instance, zero new dependencies.

**Alternatives considered**:

- **No cache, pure debounce**: blows the 30/min budget for any operator typing fast.
- **Server-side cache only**: fine, but the wizard then can't show "previously searched" results during connection blips. Per-session client-side is also fine; we choose server-side because the cache state survives a wizard close-and-reopen.
- **GraphQL search with cursor pagination**: reduces round-trips but doesn't solve the rate-limit budget; same 30/min cap.

---

## R-010: WebSocket event contract for live wizard progress

**Decision**: Two WS event types broadcast from the orchestrator:

- `bootstrap.state-changed` — `{ appId, fromState, toState, occurredAt, metadata? }`. Fired on every transition.
- `bootstrap.step-log` — `{ appId, runId, stream: 'stdout' | 'stderr', line }`. Fired for every log line from the underlying `script_runs` of a bootstrap step.

Both reuse feature 001's existing WS broadcast infrastructure (`ws/broadcaster.ts`); no new transport, no new auth boundary. Channel is the same per-user channel as feature 005's run logs.

**Subscription model**: client opens a single WS connection on dashboard load (existing behaviour). The Bootstrap Wizard doesn't create a new connection — it filters incoming events by `appId`. This means:

- Closing the wizard does NOT unsubscribe (intentional — the WS keeps draining; the wizard just stops rendering).
- Opening the same wizard later replays state from `GET /api/applications/:id/bootstrap-state` (full snapshot) plus all subsequent WS events.

**Out-of-order / replay**: the WS contract is at-most-once delivery (fire-and-forget). The wizard's REST snapshot is the authority on state — if it shows `bootstrap_state = 'compose_up'` but a stale WS event arrives saying "transitioned to cloning", the wizard ignores the WS event. Each event carries `occurredAt`, and the wizard tracks "last applied event timestamp"; older events drop.

**Reconnect**: the existing WS reconnect logic (feature 001) re-establishes the connection. The wizard then re-fetches the snapshot via REST and replays from there.

**Rationale**: minimal. Reuses everything. No new event broker, no Redis streams. The "REST snapshot is authority, WS is an accelerant" pattern is the same one feature 006 uses for health probes.

**Alternatives considered**:

- **Server-Sent Events (SSE)**: same shape; we already have WS infrastructure; no advantage.
- **Long-polling on `GET /api/applications/:id/bootstrap-state`**: mentioned in FR-026 as a fallback. Already supported by the REST endpoint (the wizard polls every 2s when WS is unavailable). Not the primary path.
- **A dedicated Redis pub/sub or NATS**: distributed coordination overkill for a single-process Node server.

---

## R-011: Default branch detection — GitHub API vs git symbolic-ref

**Decision**: GitHub API at wizard time (`GET /repos/:owner/:repo` returns `default_branch`), then re-affirm via `git symbolic-ref refs/remotes/origin/HEAD` after clone IF the operator did not override.

The wizard prefills the Advanced "Branch" field with the GitHub default (FR-005). The operator can change it. After clone, the orchestrator's `bootstrap/clone` script verifies the fetched branch — if it's missing, the script exits with `failed_clone: branch '<x>' not found`.

**Edge case — empty repo**: GitHub returns `default_branch = null` for repos with no commits. Wizard refuses with "Repo has no commits / no default branch — push at least one commit before bootstrapping" (spec Edge Cases section).

**Edge case — non-`main`/`master` default**: GitHub API returns whatever the repo declares. We use that. No assumption that "default = main".

**Rationale**: GitHub API is the authoritative source for the repo's declared default. Asking git for `symbolic-ref` would require a clone first (chicken-and-egg in the wizard). Post-clone re-affirm is a sanity check, not a replacement.

**Alternatives considered**:

- **Hard-code `main` then `master` fallback**: breaks for repos that use `develop`, `trunk`, etc.
- **Ask the operator unconditionally**: bad UX; defeats "1 mandatory input" goal of FR-001.

---

## R-012: Reconciler vs WebSocket race — broadcast ordering

**Decision**: WS broadcasts fire AFTER the DB transition is committed. The orchestrator's transition flow is:

1. Validate `canTransition(from, to)` against the in-memory state-machine table.
2. `BEGIN TRANSACTION` → `UPDATE applications SET bootstrap_state = ?` + `INSERT INTO app_bootstrap_events ...` → `COMMIT`.
3. Broadcast `bootstrap.state-changed` over WS.
4. Dispatch the next step (e.g. `scriptsRunner.runScript`).

If the dashboard crashes between step 2 and step 3, the DB is consistent but no WS event fired — the wizard recovers on reconnect via the REST snapshot.

If the dashboard crashes between step 3 and step 4, the WS event was already broadcast — the wizard sees `bootstrap_state = 'compose_up'` but no underlying `script_runs` row. The reconciler picks this up on its next 5-min cycle (the row is in a non-failed state but no in-flight run exists; reconciler treats this as a stuck state and re-dispatches).

**Stuck-state detection**: the reconciler checks `applications WHERE bootstrap_state IN ('cloning', 'compose_up', 'healthcheck', 'proxy_applied', 'cert_issued')` AND no `script_runs` row exists with `script_id LIKE 'bootstrap/%'` AND `status = 'running'` for that app. Treated as stuck and re-dispatched.

**Rationale**: DB-first, WS-second matches the "DB is authority" principle from R-010. Crash recovery is bounded by the reconciler cycle (5 minutes — acceptable per FR-022).

**Alternatives considered**:

- **WS-first, DB-second**: trivially-broken — a successful broadcast followed by DB rollback (e.g. constraint violation) lies to all wizard clients.
- **Two-phase commit between DB and WS broker**: massive over-engineering.

---

## R-013: Compose path discovery when `docker-compose.yml` is absent

**Decision**: Two-attempt fallback per FR-003 — first `docker-compose.yml`, then `docker-compose.yaml`. If both 404, the wizard shows a Step 2 error: "No compose file at root. Provide composePath in Advanced if it lives elsewhere, or v1 only supports compose-based repos." No further recursive discovery.

The wizard offers a free-text `composePath` field in Advanced. Operator can type `services/api/docker-compose.yml`. The Contents API supports arbitrary paths (`GET /repos/:owner/:repo/contents/services/api/docker-compose.yml`); pre-fetch retries with the operator's path.

**Rationale**: keeping the fallback list to two known names matches what `docker compose` itself looks for by default. Recursive discovery (walk the repo tree via the Contents API) would burn API budget and produce ambiguous results — operators with monorepos should specify the path explicitly.

**Alternatives considered**:

- **Recursive discovery via Tree API**: `GET /repos/:owner/:repo/git/trees/:branch?recursive=1` returns the whole tree in one call. Cheap, but produces multi-match scenarios that need an additional UI choice — overkill for v1.
- **Probe via clone-and-walk**: defeats the no-clone-before-detect invariant.

---

## Summary of unknowns resolved

| Topic | Decision |
|----|----|
| Compose pre-fetch | GitHub Contents API; fallback `.yml` → `.yaml`; no fallback to clone (R-001) |
| YAML parser | `yaml ^2.6.0` — pending Standing Order #2 approval (R-002) |
| PAT injection | Env-var transport (feature 005) + heredoc reconstruction inside script (R-003) |
| Slug uniqueness | Per-server, mirrors feature 008's domain UNIQUE (R-004) |
| State persistence | Single column `bootstrap_state` + append-only `app_bootstrap_events` (R-005) |
| Reconciler scheduling | `setInterval(5 * 60_000).unref()` in dashboard process (R-006) |
| Compose-up retry | Always `docker compose up -d --remove-orphans`; idempotent by design (R-007) |
| Path jail | SSH-side `readlink -f`/`realpath` + jail-prefix check before rm (R-008) |
| Search rate-limit | 60s LRU cache `(account_id, query)`, 256 entries (R-009) |
| WS contract | `bootstrap.state-changed` + `bootstrap.step-log`; DB-first ordering (R-010, R-012) |
| Default branch | GitHub API `default_branch`; post-clone sanity-check optional (R-011) |
| Compose path discovery | Two-attempt extension fallback; explicit path in Advanced (R-013) |
