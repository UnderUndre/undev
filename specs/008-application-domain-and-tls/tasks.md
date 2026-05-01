# Tasks: Application Domain & TLS

**Input**: Design documents from `/specs/008-application-domain-and-tls/`
**Prerequisites**: spec.md (v1.0 + 2026-04-28 clarifications), plan.md, research.md (R-001..R-012), data-model.md, contracts/api.md, quickstart.md

**Tests**: Yes — unit tests for every pure helper / state-machine, integration tests per user story against mocked `sshPool` + `postgres`. TDD-Lite per CLAUDE.md §7 — tests land in the same commit as the code they cover.

**Organization**: 5 user stories. US1/US2 = P1 (ship-blockers). US3/US4 = P2 (grace + cleanup). US5 = P3 (operator velocity). Foundational phase is heavy because Caddy admin client, DNS pre-check, PSL, Cloudflare CIDR, ACME resolver, and the SSH-tunnelled HTTP primitive all gate every story.

## Format: `[TaskID] [AGENT] [Story?] Description`

## Agent Tags

| Tag | Agent | Domain |
|-----|-------|--------|
| `[SETUP]` | — (orchestrator) | Shared file edits / migrations journal / shared schema writes |
| `[DB]` | database-architect | Drizzle schema, migration SQL, CHECK constraints, partial indexes |
| `[BE]` | backend-specialist | Services, lib helpers, routes, manifest, integration tests |
| `[FE]` | frontend-specialist | React components, dialogs, settings page |
| `[OPS]` | devops-engineer | `setup-vps.sh`, `install-caddy.sh`, Dockerfile / CI |
| `[E2E]` | test-engineer | Cross-domain integration tests spanning BE + Caddy mock + DB |
| `[SEC]` | security-auditor | Three-layer validation, secret-leak audit, admin-API exposure check |

## Task Statuses

| Status | Meaning |
|--------|---------|
| `- [ ]` | Pending |
| `- [→]` | In progress |
| `- [X]` | Completed |
| `- [!]` | Failed |
| `- [~]` | Blocked |

## Path Conventions

All paths relative to repo root (`undev/`). Server code under `devops-app/server/`, client under `devops-app/client/`, tests under `devops-app/tests/`. Provisioning scripts under `scripts/server/`.

---

## Phase 1: Setup

**Purpose**: Land shared scaffolding — Caddy installer block, manifest entry stub, schema barrier, PSL data drop. Every other phase depends on this.

- [X] T001 [SETUP] Add Mozilla PSL snapshot file `devops-app/server/lib/psl-snapshot.json` (~200KB) per research.md R-004. Bundled data, NOT an npm dep. Include a header comment with source URL `https://publicsuffix.org/list/public_suffix_list.dat` and snapshot date for release-time refresh discipline.
- [X] T002 [OPS] Create `scripts/server/install-caddy.sh` per plan.md §setup-vps.sh extension: idempotent (`docker network create caddy 2>/dev/null || true`), binds admin API to `127.0.0.1:2019` only (FR-028), pins `caddy:2.7` (research.md R-001 / A-003), seeds minimal `/config/caddy.json` with empty `apps.http.servers`. No `--force`, no `-y`, no `--yes`.
- [X] T003 [OPS] Modify `scripts/server/setup-vps.sh` to invoke `install-caddy.sh` after the existing nginx install block (line ~31). Move nginx listeners from `80/443` to `8080/8443` via `sed -i` with `|| true` fallback. UFW rules for 80/443 already covered by `Nginx Full`; do NOT open 2019.
- [X] T004 [SETUP] Extend `devops-app/server/db/schema.ts` with the new `applications` columns (`domain`, `acmeEmail`, `proxyType`) AND new tables `appCerts`, `appCertEvents`, `appSettings` per data-model.md. Single shared write — `[DB]` and `[BE]` lanes both depend on this file. No `as any`, every column typed, every reference uses `.references(() => ...)` with `onDelete: 'cascade'` where data-model.md specifies.

**Checkpoint**: Scripts staged, schema file committed, PSL data dropped. Migration file (Phase 2) and code lanes can fork.

---

## Phase 2: Foundational

**Purpose**: Build every primitive that user-story phases depend on — migration, Caddy admin client, DNS pre-check, ACME resolver, PSL lookup, Cloudflare CIDR fetcher, domain validator, cert lifecycle state machine, manifest entry, reconciler skeleton. Sync barrier at end.

### Migration + journal

- [X] T005 [DB] Create migration `devops-app/server/db/migrations/0008_application_domain_and_tls.sql` per data-model.md DDL: ADD COLUMN `domain`, `acme_email`, `proxy_type` (default `'caddy'`); CREATE TABLE `app_certs` with CHECK constraints on `status` enum (`pending|active|expired|revoked|rate_limited|failed|orphaned|pending_reconcile`), CHECK on `orphan_reason` enum, CHECK forcing `orphan_reason != ''` when `status = 'orphaned'` and `orphan_reason = ''` otherwise (FR-004); CREATE TABLE `app_cert_events`; CREATE TABLE `app_settings` with seed `('acme_email', NULL, NOW())`; partial UNIQUE index `idx_apps_server_domain_unique ON applications(server_id, domain) WHERE domain IS NOT NULL` (FR-001); domain regex CHECK (FR-030); `proxy_type IN ('caddy','nginx-legacy','none')` CHECK. Append journal entry `{ idx: 8, tag: "0008_application_domain_and_tls", when: <epoch>, breakpoints: true }` to `meta/_journal.json`. Reviewable static SQL — no `db.execute(sql\`...\`)` inline migrations (CLAUDE.md rule 5).
- [X] T006 [BE] Write integration test `devops-app/tests/integration/migration-0008-verification.test.ts`: assert columns exist + nullability matches; partial unique index enforces `(server_id, domain)` only when `domain IS NOT NULL`; CHECK rejects `domain = '*.foo.com'`, accepts `'foo.example.com'`; CHECK rejects `proxy_type = 'random'`; CHECK rejects `orphaned` row with empty `orphan_reason`; CHECK rejects non-orphaned row with non-empty `orphan_reason`; seed `acme_email` row exists.

### SSH tunnel + Caddy admin client

- [X] T007 [BE] Extend `devops-app/server/services/ssh-pool.ts` (or create new sibling `ssh-tunnel.ts` if pool surface should not grow) with typed `forwardOut(serverId, dstHost, dstPort): Promise<Duplex>` per research.md R-001. Reuses existing long-lived `ssh2` Client; opens a fresh channel per call; surfaces SSH-channel errors as `SshTunnelError { kind, cause }`. Typed inputs/outputs, structured pino logging (`logger.info({ ctx: 'ssh-tunnel', serverId, dstPort }, 'opened')`), no `as any`.
- [X] T008 [BE] Create `devops-app/server/services/caddy-admin-client.ts` per plan.md §Caddy admin client: typed `class CaddyAdminClient` with methods `load(serverId, config: CaddyConfig): Promise<void>`, `getConfig(serverId): Promise<CaddyConfig>`, `revokeCert(serverId, identifier): Promise<void>`, `renewCert(serverId, identifier): Promise<void>`. Each method: open SSH tunnel via T007, issue HTTP request via Node `http.request({ createConnection })` hook, 8s timeout, parse JSON. Errors normalized to `CaddyAdminError { kind: 'timeout' | 'http' | 'ssh', cause }`. Discriminated-union types for `CaddyConfig` (`HttpServer`, `TlsAutomationPolicy`, `ReverseProxyHandler`) — no `as any`. Pino logger ctx `'caddy-admin-client'`.
- [X] T009 [BE] Write unit test `devops-app/tests/unit/caddy-admin-client.test.ts` against mocked `ssh-pool.forwardOut`: (a) `load` POSTs JSON body and resolves on 200; (b) `load` rejects with `CaddyAdminError{kind:'http'}` on 4xx/5xx; (c) timeout fires `CaddyAdminError{kind:'timeout'}` after 8s; (d) ssh tunnel failure surfaces as `kind:'ssh'`; (e) `getConfig` parses returned JSON and rejects on malformed; (f) `revokeCert` and `renewCert` hit Caddy-2.7 documented paths.

### Caddy config builder

- [X] T010 [BE] Create `devops-app/server/services/caddy-config-builder.ts` per research.md R-002 / R-012: pure function `buildCaddyConfig(server: Server, apps: ApplicationWithDomain[]): CaddyConfig`. For each app with `domain` non-null and `proxy_type === 'caddy'`: emit one HTTP route matching `host: [domain]`, `reverse_proxy` to `<compose-project>-<service>:<upstream-port>` (Docker DNS, never host port), and one TLS automation policy with the resolved ACME email. Apps with `proxy_type !== 'caddy'` are excluded entirely (FR-011). Pure, no I/O, no logger calls. Discriminated-union `CaddyConfig` typing.
- [X] T011 [BE] Write unit test `devops-app/tests/unit/caddy-config-builder.test.ts` (≥ 12 cases): empty apps → minimal `apps.http.servers={}` shape; one caddy app → expected route + tls policy; nginx-legacy + caddy mix → only caddy app emitted; missing acme email → throws `AcmeEmailRequiredError` (caller of builder is responsible for resolving email, but builder asserts non-null at boundary); apex + subdomain coexistence; snapshot match against fixture JSON.

### Domain validator + PSL + ACME resolver

- [X] T012 [BE] Create `devops-app/server/lib/domain-validator.ts` per FR-030: typed `validateDomain(raw: string | null | undefined): ValidateResult` with discriminated union `{ ok: true; value: string } | { ok: true; value: null } | { ok: false; error: string }`. Regex `^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$`. Reject leading `*.`, mixed-case (lowercase-only), underscores, trailing dot. Empty / whitespace → `{ok:true,value:null}`. Strict typing — input is `string | null | undefined`, no `unknown` coercion. No `as any`, no `console.log`.
- [X] T013 [FE] Create `devops-app/client/lib/domain-validator.ts` byte-for-byte mirror of T012 for client-side form validation. Same `ValidateResult` discriminated union. Parity test in T014.
- [X] T014 [BE] Write unit test `devops-app/tests/unit/domain-validator.test.ts` (≥ 30 cases): valid (`foo.example.com`, `a.b.c.example.co.uk`, `1foo.com`); rejected (`*.foo.com` → `WILDCARD_NOT_SUPPORTED`-flavoured msg, `Foo.Example.Com` uppercase, `_dmarc.foo.com`, `foo.com.` trailing dot, `foo..bar`, `-foo.com`, `foo-.com`, label > 63 chars, total > 253 chars, empty, whitespace, `localhost`, `192.168.1.1`). Plus parity test `devops-app/tests/unit/domain-validator-parity.test.ts` importing both server + client modules and `deepEqual`-asserting outputs across the FIXTURES array.
- [X] T015 [BE] Create `devops-app/server/lib/psl.ts` per research.md R-004: imports `psl-snapshot.json` (T001), exports `getRegisteredDomain(domain: string): string`. Walks suffix tree; falls back to last-two-labels when no PSL match. Pure function, no I/O. Typed.
- [X] T016 [BE] Write unit test `devops-app/tests/unit/psl-registered-domain.test.ts`: `foo.example.com → example.com`; `foo.bar.co.uk → bar.co.uk`; `foo.bar.amazonaws.com → bar.amazonaws.com` (PSL contains `amazonaws.com`); IDN punycode (`xn--80aaxitdbjk.xn--p1ai`); cases where PSL is missing → fallback last-two-labels.
- [X] T017 [BE] Create `devops-app/server/lib/cloudflare-cidrs.ts` per research.md R-003: boot fetcher with hardcoded fallback v4/v6 lists (current as of release date). Exports `getCloudflareCidrs(): Promise<{v4: string[]; v6: string[]}>` with in-memory cache; `isCloudflareIp(ip: string): boolean` synchronous after init. Typed, structured pino logging on fetch failures (`logger.warn({ ctx: 'cloudflare-cidrs', err }, 'fallback to hardcoded')`).
- [X] T018 [BE] Create `devops-app/server/services/acme-email-resolver.ts` per plan.md §ACME email resolver: pure typed function `resolveAcmeEmail(app: { acmeEmail: string | null }, settings: { acmeEmail: string | null }): string | null`. Per-app → global → null. 4-line body. Caller maps `null → 412 ACME_EMAIL_REQUIRED`.
- [X] T019 [BE] Write unit test `devops-app/tests/unit/acme-email-resolver.test.ts`: 4-case truth table covering both-null, app-only, settings-only, both-set (per-app wins).

### DNS pre-check

- [X] T020 [BE] Create `devops-app/server/services/dns-precheck.ts` per FR-012..FR-015: typed `precheck(domain: string, serverIp: string): Promise<PrecheckOutcome>` discriminated union `match | cloudflare | mismatch | nxdomain`. Uses `dns.promises.resolve4` + `resolve6` (no shellouts), 5s timeout each. Cloudflare check via T017. NXDOMAIN detected by Node `ENOTFOUND` / `ENODATA` codes. Typed errors, pino logging ctx `'dns-precheck'`.
- [X] T021 [BE] Write unit test `devops-app/tests/unit/dns-precheck.test.ts` (≥ 12 cases) against mocked `dns.promises`: `match` (server IP in resolved set); `cloudflare` (resolved IP in CF CIDR); `mismatch` (resolved set non-empty, no match, not CF); `nxdomain`; AAAA-only domain; round-robin where any IP matches; round-robin where none match; resolve4 throws while resolve6 succeeds; both throw → nxdomain; timeout.

### Rate-limit guard

- [X] T022 [BE] Create `devops-app/server/services/rate-limit-guard.ts` per FR-023..FR-024 / research.md R-007: typed async `checkRateLimit(domain: string): Promise<RateLimitResult>` discriminated union `ok | warn | block`. Uses `getRegisteredDomain` (T015); Drizzle parameterized query `SELECT COUNT(*) FROM app_certs WHERE status IN ('pending','active','failed') AND created_at > NOW() - INTERVAL '7 days' AND (domain = $1 OR domain LIKE '%.' || $1)`. Boundaries: warn ≥3, block ≥5. No string-interpolated SQL.
- [X] T023 [BE] Write unit test `devops-app/tests/unit/rate-limit-guard.test.ts` against mocked Drizzle: counts 0/2/3/4/5/6 → `ok|ok|warn|warn|block|block`; registered-domain grouping (subdomains roll up); 7-day boundary (`6d23h59m → counted`, `7d1m → not counted`); status filter (orphaned/revoked excluded).

### Cert lifecycle state machine

- [X] T024 [BE] Create `devops-app/server/services/cert-lifecycle.ts` per plan.md §Cert lifecycle state machine: pure typed `transition(cert: AppCert, event: CertEvent): TransitionResult` with discriminated `CertEvent` union (`issue_requested | caddy_active | caddy_failed | acme_rate_limit | expiry_probe_passed | expires_at_in_past | domain_changed | app_soft_deleted | force_revoke | force_renew_requested | retention_window_elapsed`). Returns `{ next: AppCert; eventToWrite: AppCertEvent } | { next: 'delete'; eventToWrite: AppCertEvent }`. Pure — caller persists. Every transition from plan.md table covered. No `as any`.
- [X] T025 [BE] Write unit test `devops-app/tests/unit/cert-lifecycle.test.ts`: every row of the plan.md transition table as a discrete case (≥ 13 transitions); illegal transitions (e.g. `revoked → active`) → throw `IllegalTransitionError`; `force_renew_requested` on `rate_limited` with `retry_after` future → throws; same on past `retry_after` → ok.

### Manifest entry

- [X] T026 [BE] Extend `devops-app/server/scripts-manifest.ts` with `server-ops/install-caddy` entry: `id`, `category: 'server-ops'`, `locus: 'target'`, `requiresLock: false`, `timeout: 600_000`, `dangerLevel: 'low'`, `params: z.object({}).strict()`. Imports `validateDomain` is NOT required here (no domain param) — separate manifest entry per Phase 3 if needed.
- [X] T027 [BE] Extend `devops-app/tests/unit/scripts-manifest.test.ts` asserting `install-caddy` entry parses, `validateManifestLenient()` passes, descriptor surfaces empty params, locus is `target`.

### Caddy reconciler skeleton

- [X] T028 [BE] Create `devops-app/server/services/caddy-reconciler.ts` per plan.md §Reconciler — typed `reconcile(serverId: string): Promise<ReconcileResult>` flow: fetch apps for server (Drizzle), build config via T010, call `caddyAdminClient.load`, on `CaddyAdminError` mark affected `app_certs` rows with conditional UPDATE `SET status = CASE WHEN status = 'active' THEN 'active' ELSE 'pending_reconcile' END WHERE app_id IN (...)` (Drizzle parameterized), debounce Telegram via in-memory map per `serverId` (FR-009). Returns discriminated `{ ok: true } | { ok: false; err: CaddyAdminError }`. Structured pino logging, no silent catches. **Amended 2026-04-28 (T072 row-level lock)**: per-app reconcile path acquires `SELECT applications.* FROM applications WHERE id = ? FOR UPDATE` inside the transaction before reading desired-state and holds through Caddy PUT (FR drift-detection edge case). **Amended 2026-04-28 (T067 domain-null cleanup)**: when `applications.domain IS NULL AND proxy_type = 'caddy'`, treat as Caddy-site-removal trigger (do NOT skip as no-op).
- [X] T029 [BE] Add 5-minute drift cron registration in `devops-app/server/services/caddy-reconciler.ts` (FR-006): `setInterval(reconcileAllServers, 5 * 60 * 1000).unref()`. Guarded against concurrent ticks via in-flight Set. Started in `server/index.ts` boot block alongside existing schedulers.

### Notifier extension

- [X] T030 [BE] Extend `devops-app/server/services/notifier.ts` with new typed message factories `certExpiring(domain, days, status, lastRenew)`, `certIssuanceFailed(domain, errorMessage)`, `caddyUnreachable(serverLabel, errorKind, lastReachableAt)`. Reuse existing Telegram channel (A-006). Structured logging ctx `'notifier-tls'`, no secret leakage.

**Checkpoint** (sync barrier): migration applied; Caddy admin client typed + tested; DNS pre-check + PSL + ACME resolver + rate-limit + cert lifecycle all unit-covered; reconciler skeleton runs; manifest entry registered; notifier knows new message types. Phase 3+ can fork.

---

## Phase 3: User Story 1 — Attach domain to existing app (Priority: P1)

**Goal**: Operator sets `domain` on an existing app via UI form; DNS pre-check runs; cert reaches `active` over HTTPS within 60s; cert widget renders issuer/expires_at/status (US1, FR-001..FR-003, FR-014, FR-016, FR-021, FR-025, FR-030, SC-001).

**Independent Test**: Seed an app on a mocked server with reachable Caddy admin. PATCH `/api/applications/:id/domain` with `{domain:"foo.example.com", confirmDnsWarning:false}` and DNS-mock returning `match`. Assert: 200 response, new `app_certs` row in `pending`, `caddyAdminClient.load` called once with expected config, WS event `cert.state-changed` fired. UI form shows the cert widget after WS update.

### Backend routes — domain + certs + settings

- [X] T031 [BE] [US1] Implement `PATCH /api/applications/:id/domain` in `devops-app/server/routes/domain.ts` with Zod validation per contracts/api.md (domain validated via T012's `validateDomain`, `acmeEmail` email-regex, `confirmDnsWarning`/`confirmCrossServer` booleans). Flow: validate → cross-server advisory check (FR-001a) → DNS pre-check (T020) → ACME email resolve (T018) → rate-limit guard (T022) → mark old cert `orphaned (domain_change)` if exists → INSERT new `app_certs` row in `pending` → invoke reconciler (T028) → respond 200. Structured error responses `{ error: { code, message, details } }`, parameterized SQL via Drizzle, no `as any`.
- [X] T032 [BE] [US1] Implement `POST /api/applications/:id/certs/issue` in `devops-app/server/routes/certs.ts` per contracts/api.md: Zod-validated empty body, idempotency check via existing non-orphaned cert lookup (returns `CERT_ALREADY_EXISTS`), `NO_DOMAIN_SET` guard, ACME email + rate-limit reuse, INSERT pending row, invoke reconciler. Structured errors, typed handler return.
- [X] T033 [BE] [US1] Implement `GET /api/applications/:id/certs` in `devops-app/server/routes/certs.ts` per contracts/api.md: Zod-validated `includeEvents` boolean + repeatable `status` filter; Drizzle parameterized `WHERE app_id = $1`; when `includeEvents`, JOIN-LATERAL or in-handler second query for the last 50 `app_cert_events` rows per cert. Typed response shape, no `as any`.
- [X] T034 [BE] [US1] Implement `GET /api/settings/tls` and `PATCH /api/settings/tls` in `devops-app/server/routes/settings.ts` per contracts/api.md: Zod-validated `acmeEmail` (email regex `^\S+@\S+\.\S+$` per FR-025), structured `INVALID_EMAIL` error, `app_settings` upsert via Drizzle `onConflictDoUpdate`. Forward-only per research.md R-011 — no cascade to existing certs.
- [X] T035 [BE] [US1] Implement `POST /api/settings/tls/test-caddy` in `devops-app/server/routes/settings.ts` per contracts/api.md: Zod-validated optional `serverId` query; iterates managed servers; calls `caddyAdminClient.getConfig` per server with timing; returns per-server `outcome | latencyMs | caddyVersion | errorMessage`. No secret leakage in `errorMessage` (FR-029).
- [X] T036 [BE] [US1] Extend `devops-app/server/routes/apps.ts` `POST /api/apps` and `PATCH /api/apps/:id` to accept `domain`, `acmeEmail`, `proxyType` per contracts/api.md. Reuse `validateDomain` (T012); same `INVALID_DOMAIN` / `WILDCARD_NOT_SUPPORTED` / `DOMAIN_IN_USE` error codes; `proxyType` enum-validated by Zod `z.enum(['caddy','nginx-legacy','none'])`. PATCH path triggers `routes/domain.ts` reconcile flow when `domain` field present. Modified `GET /api/apps[/:id]` response always includes the three new fields (even when null) per contracts/api.md.

### WebSocket events

- [X] T037 [BE] [US1] Wire `cert.state-changed` WS event emission per contracts/api.md from `cert-lifecycle.ts` transition writes (T024 caller). Typed payload, structured pino logging on fan-out failures.

### UI — Domain & TLS panel + Settings

- [X] T038 [FE] [US1] Build `devops-app/client/components/apps/DomainTlsSection.tsx` per plan.md §UI: three render states (no domain / active / pending+failed). Controlled inputs, on-blur runs client-side `validateDomain` (T013), error states from server `{ code, message }` mapped to user-friendly strings (e.g. `DNS_WARNING_REQUIRES_CONFIRM` → checkbox UI). No `dangerouslySetInnerHTML`. TypeScript-typed props.
- [X] T039 [FE] [US1] Build `devops-app/client/components/apps/DomainEditDialog.tsx` per plan.md: typed-confirm dialog hosting the domain-set form, surfaces DNS pre-check warning kinds (`cloudflare`/`mismatch`) with explicit "Try anyway" checkbox bound to `confirmDnsWarning`, separate "Confirm cross-server" checkbox for `DOMAIN_CROSS_SERVER`. Focus-trap + ESC-dismiss via existing dashboard Dialog primitive.
- [X] T040 [FE] [US1] Build `devops-app/client/components/apps/CertEventTimeline.tsx`: append-only event timeline rendering `app_cert_events` rows reverse-chrono with one icon per `event_type`. Plain-text rendering, no innerHTML. Subscribes to `cert.state-changed` WS for live append.
- [X] T041 [FE] [US1] Modify `devops-app/client/pages/ApplicationDetail.tsx` to mount `<DomainTlsSection>` between existing Server section and Deployments. Pass `app` + handlers; no logic in page beyond mounting + state lifting.
- [X] T042 [FE] [US1] Build `devops-app/client/components/settings/TlsAcmeSection.tsx` per plan.md / FR-025: `acmeEmail` controlled input (client regex match), read-only `caddyAdminEndpoint` display, "Test Caddy connectivity" button → `POST /api/settings/tls/test-caddy`, results rendered inline per-server. No `dangerouslySetInnerHTML`.
- [X] T043 [FE] [US1] Modify `devops-app/client/pages/SettingsPage.tsx` to mount `<TlsAcmeSection>`.

### Integration tests

- [X] T044 [BE] [US1] Write integration test `devops-app/tests/integration/domain-attach-happy-path.test.ts` against mocked `sshPool` (returns reachable Caddy admin) + DNS mock (returns `match`) + Drizzle: PATCH `/api/applications/:id/domain` with valid input → 200, `app_certs` row created in `pending`, `caddyAdminClient.load` called with expected config (snapshot match), WS event `cert.state-changed` fired with `previousStatus: null`, audit row written.
- [X] T045 [BE] [US1] Write integration test `devops-app/tests/integration/domain-attach-error-paths.test.ts` covering each contracts/api.md error code: `INVALID_DOMAIN`, `WILDCARD_NOT_SUPPORTED`, `DNS_NXDOMAIN`, `DNS_WARNING_REQUIRES_CONFIRM` (cloudflare + mismatch), `DOMAIN_IN_USE`, `DOMAIN_CROSS_SERVER`, `ACME_EMAIL_REQUIRED`, `RATE_LIMIT_BLOCKED`. Each asserts response status + code + that no `app_certs` INSERT happened.

**Checkpoint**: US1 ships independently. Operator can attach a domain end-to-end through UI; DNS pre-check enforces the FR-014 warn/block matrix; cert lifecycle observable.

---

## Phase 4: User Story 2 — Cert expiry alerts (Priority: P1)

**Goal**: Daily cert-expiry probe (owned by feature 006) writes back `app_certs.expires_at`; this feature integrates a windowed alerter (14d/7d/3d/1d) firing Telegram once per window per cert renewal cycle (US2, FR-022, FR-026, SC-002, SC-003).

**Independent Test**: Seed `app_certs` row with `expires_at = now + 13d`; trigger probe; assert Telegram alert fires (matches "14d" window). Re-probe same row → no second 14d alert. Update `expires_at = now + 6d` → 7d alert fires.

- [X] T046 [BE] [US2] Create `devops-app/server/services/cert-expiry-alerter.ts`: typed `evaluateAlertWindows(cert: AppCert, now: Date): { window: '14d'|'7d'|'3d'|'1d'; firedAt: Date }[]`. Pure function — given cert + now, returns which windows newly crossed since `last_alert_fired_for` (stored in `app_cert_events` event_type `'expiry_alert_fired'`). Recovery is silent (FR § US2). Typed inputs/outputs, no `as any`.
- [X] T047 [BE] [US2] Write unit test `devops-app/tests/unit/cert-expiry-alerter.test.ts` (≥ 12 cases): boundary at exactly 14d/7d/3d/1d; renewal pushes back past window → window unlocks for next cycle; multiple windows crossed in one tick (e.g. cert went from 30d to 2d) → fire 14d/7d/3d but NOT 1d (still future); same window already fired in this lifecycle → silent.
- [X] T048 [BE] [US2] Integrate alerter into the cert-expiry probe handler (feature 006 owns the probe; this feature owns the side effect). Add hook in `devops-app/server/services/probe-handler-cert-expiry.ts` (or wherever 006's probe lands) calling `evaluateAlertWindows` after `expires_at` write; on each fired window, call `notifier.certExpiring` (T030) and INSERT `app_cert_events` row `event_type='expiry_alert_fired'` with `event_data: {window}`. Drizzle parameterized.
- [X] T049 [BE] [US2] Write integration test `devops-app/tests/integration/cert-expiry-alert-windows.test.ts` against mocked notifier + Drizzle: assert FR-022 + SC-002 + SC-003 — each window fires once per renewal cycle; recovery is silent; notifier message shape matches contracts/api.md.

**Checkpoint**: US2 verified end-to-end. Cert expiry has a closed feedback loop.

---

## Phase 5: User Story 3 — Domain change with grace period (Priority: P2)

**Goal**: Editing `domain` orphans the old cert with `orphan_reason='domain_change'`; Caddy serves BOTH domains during 7-day grace; daily cleanup deletes orphans whose window elapsed (US3, FR-017, FR-019, SC-004).

**Independent Test**: Seed app with `domain='old.example.com'` + active cert. PATCH to `domain='new.example.com'`. Assert: old cert `status='orphaned', orphan_reason='domain_change', orphaned_at=now`; new cert `status='pending'`; Caddy config (next reconcile) includes BOTH host matchers. Advance clock 8 days, run orphan-cleanup → old cert row DELETED, Caddy storage `rm` issued.

- [X] T050 [BE] [US3] Extend `devops-app/server/services/caddy-config-builder.ts` (T010) to also emit routes for `app_certs` rows where `status='orphaned'` AND `orphan_reason='domain_change'` AND `orphaned_at > now - 7d` — both old and new hosts served simultaneously per FR (US3 acceptance). Pure function, snapshot-tested.
- [X] T051 [BE] [US3] Create `devops-app/server/services/orphan-cleanup-job.ts` per FR-019: daily cron `setInterval(24h).unref()` (or daily at fixed time via existing scheduler). For each `orphan_reason`: `domain_change` AND `orphaned_at < now-7d` → DELETE; `app_soft_delete` AND `orphaned_at < now-30d` → DELETE; `manual_orphan` AND `orphaned_at < now-7d` → DELETE. Each delete: SSH `rm` Caddy storage path for the cert, Drizzle DELETE row, INSERT cert event `'orphan_cleaned'`. Parameterized SQL. Structured pino logging.
- [X] T052 [BE] [US3] Write integration test `devops-app/tests/integration/domain-change-grace-period.test.ts`: covers orphan creation, dual-serve config, advance-clock cleanup, SC-004 rollback (operator changes back X→Y→X within 7d → original cert un-orphaned and re-active without re-issuance, no rate-limit slot consumed).
- [X] T053 [FE] [US3] Extend `devops-app/client/components/apps/DomainTlsSection.tsx` (T038) to show "Old domain `<x>` cert kept for rollback until `<date>`. Click to revoke now." banner when an orphaned cert with `orphan_reason='domain_change'` exists for the app within its 7d window.

**Checkpoint**: US3 verified. SC-004 rollback path structurally guaranteed.

---

## Phase 6: User Story 4 — Hard delete cleanup wizard (Priority: P2)

**Goal**: Soft delete (default) marks cert `orphan_reason='app_soft_delete'`; explicit "Remove everything from server" requires typed app-name confirmation, ACME-revokes the cert via Caddy, removes Caddy site, deletes cert files, deletes app row (US4, FR-018, FR-027, SC-005).

**Independent Test**: Seed app with active cert. POST `/api/applications/:id/certs/:certId/revoke` with `confirmName != app.name` → 400 `HARD_DELETE_NAME_MISMATCH`. Same with matching name → 200, Caddy `revokeCert` invoked, `app_certs` row gone, app row gone, no orphan files left in `/var/lib/caddy`.

- [X] T054 [BE] [US4] Implement `POST /api/applications/:id/certs/:certId/revoke` in `devops-app/server/routes/certs.ts` per contracts/api.md: Zod-validated `confirmName` field (FR-027 — server-side enforcement, never trust the client), strict equality with `applications.name`, structured `HARD_DELETE_NAME_MISMATCH` on mismatch, calls `caddyAdminClient.revokeCert` (T008), `CADDY_UNREACHABLE` on Caddy failure (cert stays at previous status). Drizzle parameterized.
- [X] T055 [BE] [US4] Extend `devops-app/server/routes/apps.ts` `DELETE /api/apps/:id` with `?hard=true` flag and `confirmName` body field. Soft path (default): mark cert `orphaned (app_soft_delete)`, soft-delete app. Hard path: revoke each cert via T054 logic, remove Caddy site (full reconcile after app removal), delete cert files, DELETE `app_certs` rows, DELETE app row. Order matters per FR-018 (revoke before file removal). Audit log differentiates `'soft-deleted'` vs `'hard-deleted with server cleanup'` (FR-026). **Amended 2026-04-28 (FR-018a resilience)**: steps 1-3 (Caddy revoke, Caddy site removal, file removal) MUST be wrapped in try/catch with `logger.warn({ err, certId, step }, 'caddy cleanup failed during hard delete')` and an INSERT to `app_cert_events` row (`event_type = 'hard_delete_partial'`, `event_data = { failed_step, error_message }`); steps 4-5 (DB DELETE of cert + app rows) MUST proceed regardless of step 1-3 outcome. Audit row signals "manual SSH cleanup recommended" to future operators. Drizzle parameterized; no `as any`; structured pino logging.
- [X] T056 [FE] [US4] Build `devops-app/client/components/apps/HardDeleteWizard.tsx` per plan.md §UI: typed-confirm dialog requires operator types app name verbatim; surfaces step-by-step progress (`revoking → caddy-site-removing → files-removing → deleting`); shows server-side error inline when steps fail. No `dangerouslySetInnerHTML`. Server-side enforcement is the source of truth — client validation is UX-only (FR-027).
- [X] T057 [BE] [US4] Write integration test `devops-app/tests/integration/hard-delete-cleanup.test.ts` against mocked `caddyAdminClient` + `sshPool`: (a) name mismatch → 400, no side effects; (b) name match + Caddy reachable → cert `revoked` → Caddy site removed → files removed → app row deleted → audit row `'hard-deleted with server cleanup'`; (c) Caddy unreachable mid-flow → 502 `CADDY_UNREACHABLE`, app row preserved (cert state unchanged).

**Checkpoint**: US4 verified. SC-005 enforced — no ghost server state.

---

## Phase 7: User Story 5 — Force renew (Priority: P3)

**Goal**: UI button + API force-renew a cert in `failed`/`expired`/`rate_limited` state when `retry_after` (if set) is past (US5, FR-021).

**Independent Test**: Seed cert in `failed` state. POST `/api/applications/:id/certs/:certId/renew` → 200, status moves to `pending`, Caddy `renewCert` invoked. Same on `active` cert → 409 `RENEW_NOT_ALLOWED`.

- [X] T058 [BE] [US5] Implement `POST /api/applications/:id/certs/:certId/renew` in `devops-app/server/routes/certs.ts` per contracts/api.md: Zod-validated empty body, gate on `status ∈ {failed, expired, rate_limited}` AND `retry_after IS NULL OR retry_after < now()` (FR-021), structured `RENEW_NOT_ALLOWED` / `RETRY_AFTER_NOT_ELAPSED`, calls `caddyAdminClient.renewCert` (T008), invokes cert lifecycle transition `force_renew_requested` (T024), Drizzle parameterized.
- [X] T059 [FE] [US5] Add "Force renew" button to `DomainTlsSection.tsx` (T038): enabled per FR-021 client-side mirror; on click calls renew endpoint; surfaces server `RENEW_NOT_ALLOWED` / `RETRY_AFTER_NOT_ELAPSED` errors inline.
- [X] T060 [BE] [US5] Write integration test `devops-app/tests/integration/force-renew.test.ts`: gate states (failed/expired/rate_limited→pending; active/pending/orphaned/revoked→409); `retry_after` past vs future; Caddy `renewCert` invoked exactly once per success.

**Checkpoint**: US5 verified.

---

## Phase 8: Polish

- [X] T061 [SEC] Security audit on the three-layer domain validation + admin-API exposure + secret-leak surfaces. Verify: (1) `validateDomain` is single source of truth — grep `domain` reads/writes across `devops-app/server/`, every entrypoint either calls validator or sits behind a layer that did; Zod refine in routes imports the same validator; DB CHECK constraint exists in deployed schema; (2) Caddy admin API is bound to `127.0.0.1:2019` per FR-028 — `setup-vps.sh` `docker run -p 127.0.0.1:2019:2019` line present; UFW does NOT open 2019; (3) ACME private keys never read by dashboard — grep for `/var/lib/caddy/.../private` reads in dashboard code = 0 hits (FR-029); (4) `errorMessage` fields in `app_certs` and Caddy responses do not leak private keys / account secrets — assert via fixture fuzz; (5) Hard-delete `confirmName` is enforced server-side (FR-027) and cannot be bypassed by direct API call without payload; (6) `pending_reconcile` distinct from `pending` (FR-009) — operator sees the difference in UI; (7) Cross-server domain advisory is non-blocking per FR-001a — no DB constraint enforces it; (8) PSL snapshot does not contain executable code (data-only). Produce `specs/008-application-domain-and-tls/security-review.md` with each check + pass/fail.
- [X] T062 [E2E] Cross-domain regression: run `devops-app/tests/integration/*` against the migrated schema. No pre-existing test should regress. Specifically verify feature 005 (`scripts-runner`), 006 (`probe-scheduler`), 007 (`project-local-deploy`) integration suites still pass with the new columns + tables present.
- [~] T063 [BE] Walk `quickstart.md` against a staging deployment: install Caddy via T002/T003, configure ACME email, attach a real domain to a fixture app, observe HTTPS within 90s (SC-001), verify cert event timeline, trigger force-renew. If any step diverges, fix code OR update `quickstart.md`. **DEFERRED** when staging access not available; flag accordingly.

**Checkpoint**: Feature release-ready. Security review filed. Regression suite green. Quickstart validated.

---

## Phase 9: Review-pass amendments (2026-04-28 Gemini + GPT)

**Purpose**: Land FR-014a (DNS double-verify), FR-017a (domain → NULL Caddy cleanup), FR-018a (hard-delete resilience — amended in T055), Caddy port-2019 conflict pre-check, drift-detection row-level lock (amended in T028), IDN/Punycode helper text. Tasks integrate into existing user-story phases per labels.

### FR-014a: DNS double-verify (US1)

- [X] T064 [BE] [US1] Extend DNS pre-check service `devops-app/server/services/dns-precheck.ts` (T020) with second-resolution-after-T+120s path per FR-014a. When the issuance flow (T031) receives a `mismatch` outcome with `tryAnyway = true`, set cert row `status = 'pending'`, set `pending_dns_recheck_until = ISO(now + 120s)` (T066), schedule a `setTimeout(120_000, () => reResolve())` job tracked in an in-memory `Map<certId, NodeJS.Timeout>` (or use the existing delayed-job queue if one exists in plan.md), then re-resolve via `precheck` (T020). On `match | cloudflare` after the wait → proceed with ACME. On `mismatch | nxdomain` after the wait → abort with `error_message = 'DNS still mismatched after 2-minute propagation wait'`, transition cert to `failed`. Cancel-during-wait clears the timeout via T067 endpoint. Typed I/O, discriminated `RecheckOutcome`, no `as any`. Structured pino logging ctx `'dns-precheck-recheck'`.
- [X] T065 [FE] [US1] Extend `devops-app/client/components/apps/DomainTlsSection.tsx` (T038) with a "Validating DNS… (~2 min)" indicator + Cancel button when cert `status = 'pending'` AND `pending_dns_recheck_until IS NOT NULL` AND `pending_dns_recheck_until > now`. Cancel calls `DELETE /api/applications/:id/certs/:certId/dns-recheck` (T067) which sets the cert to `failed` with cancellation message. No `dangerouslySetInnerHTML`. Typed props.
- [X] T066 [DB] [US1] Add column `pending_dns_recheck_until TEXT NULL` (ISO timestamp) to `app_certs`. Edit existing migration `devops-app/server/db/migrations/0008_application_domain_and_tls.sql` (T005 — not yet shipped per repo state) to include this column in the `CREATE TABLE app_certs` statement. If the migration has shipped by the time this task runs, instead create a follow-up migration `devops-app/server/db/migrations/0008_dns_recheck.sql` with `ALTER TABLE app_certs ADD COLUMN pending_dns_recheck_until TEXT NULL`. Mirror the column in `devops-app/server/db/schema.ts` (T004). No inline `db.execute(sql\`...\`)` migrations.
- [X] T067 [BE] [US1] Implement `DELETE /api/applications/:id/certs/:certId/dns-recheck` in `devops-app/server/routes/certs.ts` per FR-014a cancel path. Zod-validated path params, idempotent (no-op + 200 if already past `pending_dns_recheck_until` or already in non-pending state); on hit: clear the in-memory timeout from T064's Map, UPDATE cert row `status = 'failed', error_message = 'cancelled by operator during DNS revalidation', pending_dns_recheck_until = NULL` (Drizzle parameterized), INSERT `app_cert_events` row `event_type = 'failed'`. Structured `{ error: { code, message } }` on auth/not-found. Pino structured logging.

### FR-017a: domain → NULL Caddy cleanup (US3)

- [X] T068 [BE] [US3] Extend reconciler in `devops-app/server/services/caddy-reconciler.ts` (T028) — when desired-state read finds `applications.domain IS NULL AND applications.proxy_type = 'caddy'`, treat as a Caddy-site-removal trigger: invoke `caddyConfigBuilder` (T010) with that app excluded → resulting config omits the site → `caddyAdminClient.load` PUTs the trimmed config; concurrently mark the existing non-orphaned `app_certs` row `status = 'orphaned', orphan_reason = 'domain_change', orphaned_at = now()` (re-uses the same 7-day grace window as a rename per FR-017a). Drizzle parameterized; typed I/O on the diff calculator; no `as any`; structured pino logging.
- [X] T069 [BE] [US3] Write integration test `devops-app/tests/integration/domain-null-cleanup.test.ts`: seed app with `domain = 'foo.example.com'` + active cert; PATCH `/api/applications/:id/domain` with `{domain: null}`; assert cert row `status = 'orphaned'`, `orphan_reason = 'domain_change'`; Caddy `load` called with config that omits the site for that app; app row preserved (still a valid app row, just no public domain).

### Caddy port-2019 conflict (Foundational)

- [X] T070 [OPS] Update `scripts/server/install-caddy.sh` (T002) with a pre-install port-2019 conflict detection block: `ss -ltn '( sport = :2019 )'` — if non-empty, abort with actionable error message naming the offending PID + process name (`ss -ltnp '( sport = :2019 )' | awk '...'`). Do NOT auto-discover an alternate port (deferred to v2 per spec edge case). Re-assert UFW rule check: 2019 must remain loopback-only — `ufw status | grep -q '2019' && exit 1 || true` (loopback bind via `-p 127.0.0.1:2019:2019` is the canonical mitigation; UFW rule for 2019 is forbidden). No `--force`, no `-y`.

### Drift-detection row-level lock (Foundational)

- [X] T071 [BE] Add transaction wrapper around the per-app reconcile path in `devops-app/server/services/caddy-reconciler.ts` (T028) — wrap the `fetchAppsForServer → buildCaddyConfig → caddyAdminClient.load` sequence in a Drizzle `db.transaction(async (tx) => { await tx.execute(sql\`SELECT 1 FROM applications WHERE id = ${appId} FOR UPDATE\`); ... })`. The same lock is acquired by the operator-domain-change handler in `devops-app/server/routes/domain.ts` (T031) — second writer waits until first commits per Postgres `SELECT FOR UPDATE` semantics. Typed transaction; parameterized SQL only; structured pino logging on lock-acquire / lock-release with ctx `'caddy-reconciler-lock'`.
- [X] T072 [BE] Write integration test `devops-app/tests/integration/reconciler-concurrent-domain-change.test.ts`: simulate concurrent reconciler-cron tick + operator-domain-change race against the migrated schema; assert no stale-write to Caddy (final Caddy config matches the post-change DB state, never the pre-change state); both code paths complete; second writer observes fresh state.

### IDN/Punycode form helper (US1)

- [X] T073 [FE] [US1] Add helper text to the domain input in `devops-app/client/components/apps/DomainTlsSection.tsx` (T038) and `DomainEditDialog.tsx` (T039): "Use punycode for international domains (e.g. `xn--mnchen-3ya.de`, not `münchen.de`)." Plain-text rendering — no `dangerouslySetInnerHTML`. No auto-conversion (deferred to v2 per spec edge case). The existing FR-030 regex (T012/T013) already enforces this; helper text only makes the rule explicit to operators.

**Checkpoint**: Review-pass amendments shipped. FR-014a guards the rate-limit slot; FR-017a closes the dangling-Caddy-site loophole; FR-018a (T055 amendment) prevents ghost-app rows; port-2019 detection prevents silent install failure; row-level lock serialises reconciler vs domain-change; IDN helper text removes operator confusion.

---

## Dependency Graph

```
# Phase 1: Setup
T001 → T004
T002 → T003
T003 → T004

# Phase 2: Foundational
T004 → T005
T005 → T006
T004 → T007
T007 → T008
T008 → T009
T004 → T010
T010 → T011
T004 → T012
T012 → T013
T012 + T013 → T014
T001 → T015
T015 → T016
T015 → T017
T004 → T018
T018 → T019
T017 → T020
T020 → T021
T015 → T022
T022 → T023
T004 → T024
T024 → T025
T002 → T026
T026 → T027
T008 + T010 + T024 → T028
T028 → T029
T028 → T030

# Phase 3: US1
T028 + T012 + T020 + T022 + T018 → T031
T028 + T020 + T022 + T018 → T032
T004 → T033
T004 → T034
T008 → T035
T031 + T012 → T036
T024 + T031 → T037
T013 → T038
T038 → T039
T038 → T040
T038 → T041
T034 + T035 → T042
T042 → T043
T031 + T028 → T044
T031 → T045

# Phase 4: US2
T024 + T030 → T046
T046 → T047
T046 → T048
T048 → T049

# Phase 5: US3
T010 + T031 → T050
T050 + T028 → T051
T050 + T051 → T052
T038 → T053

# Phase 6: US4
T008 + T031 → T054
T054 + T028 → T055
T055 → T056
T055 + T056 → T057

# Phase 7: US5
T008 + T024 + T031 → T058
T058 + T038 → T059
T058 → T060

# Phase 8: Polish
T044 + T045 + T049 + T052 + T057 + T060 → T061
T061 → T062
T062 → T063

# Phase 9: Review-pass amendments (2026-04-28)
T020 + T031 → T064
T038 + T067 → T065
T004 + T005 → T066
T031 + T064 → T067
T028 + T010 → T068
T068 + T031 → T069
T002 → T070
T028 → T071
T071 + T031 → T072
T038 → T073
```

### Update 2026-04-28 (review-pass tasks)

- **DNS double-verify** (T064-T067, FR-014a): T064 extends T020 (DNS pre-check) and is invoked from T031 (domain PATCH); T065 extends T038 with the wait indicator + cancel; T066 extends T004 schema + T005 migration with the `pending_dns_recheck_until` column; T067 (cancel endpoint) depends on T031 (auth/route plumbing) and T064 (clears T064's in-memory Map).
- **Domain-null cleanup** (T068-T069, FR-017a): T068 extends T028 (reconciler) + T010 (config builder); T069 integration depends on T068 + T031.
- **Hard-delete resilience** (FR-018a): NO new node — **T055 description amended** in place (try/catch around steps 1-3, `hard_delete_partial` audit row). T057 integration test already covers Caddy-unreachable mid-flow per its existing description; the amendment to T055 makes it pass without a new node.
- **Port-2019 detect** (T070): depends on T002 (Caddy install script).
- **Drift-lock** (T071-T072, Gemini concurrent edge case): T071 amends T028's reconciler with a Drizzle transaction + `SELECT FOR UPDATE` (also referenced in T028's amended description); T072 tests the race; both depend on T028 being implemented before they can amend it.
- **IDN helper** (T073): depends on T038 (DomainTlsSection) + T039 (DomainEditDialog).

Cross-task subtleties:

- T071's row-level lock assumes Postgres + Drizzle (per existing `Technical Context` in plan.md — `drizzle-orm + postgres (porsager) 3.4.x`). `SELECT FOR UPDATE` is Postgres-native; Drizzle's `db.transaction` + `tx.execute(sql\`...\`)` is the parameterised path. If the project ever moves to SQLite, T071 needs a rewrite to use `BEGIN IMMEDIATE` semantics — flagged here for future-proofing.
- T066 has a branch: edit the not-yet-shipped T005 migration in place vs ship a follow-up `0008_dns_recheck.sql`. The first option is cleaner; agent picks based on git status of the migration file at execution time.
- T064's `setTimeout` is in-process — if the dashboard restarts mid-wait, the recheck is lost. Acceptable for v1 (operator can re-submit); v2 nicety would persist the wait via a delayed-job queue.

### Graph self-validation

- ✅ Every task ID in Dependencies exists in the task list (T001..T074)
- ✅ No circular dependencies (review-pass tasks T064-T074 only depend on already-defined nodes)
- ✅ No TaskID collision with T001..T063
- ✅ US labels on review-pass tasks: T064/T065/T066/T067/T073 = US1; T068/T069 = US3; T070/T071/T072 = no US label (Foundational); T055 amendment retains US4
- ✅ Standards modifiers present in every new task description (Zod / typed / parameterized / no `as any` / no `dangerouslySetInnerHTML` / structured pino logging)
- ✅ Fan-in uses `+` only; fan-out uses `,` only (none required here)
- ✅ No chained arrows on one line
- ✅ Every US task has a `[US?]` label
- ✅ Setup / Foundational / Polish tasks have NO story label

---

## Parallel Lanes

| Lane | Agent | Tasks | Start Condition |
|------|-------|-------|-----------------|
| L1 — PSL data drop | [SETUP] | T001 | start |
| L2 — Caddy installer scripts | [OPS] | T002 → T003 | start |
| L3 — Schema barrier | [SETUP] | T004 | T001 + T003 |
| L4 — Migration + journal | [DB] | T005 → T006 | T004 |
| L5 — SSH tunnel + Caddy admin client | [BE] | T007 → T008 → T009 | T004 |
| L6 — Caddy config builder | [BE] | T010 → T011 | T004 |
| L7 — Domain validator (server) | [BE] | T012 | T004 |
| L8 — Domain validator (client) + parity | [FE/BE] | T013 → T014 | T012 |
| L9 — PSL lookup | [BE] | T015 → T016 | T001 |
| L10 — Cloudflare CIDRs | [BE] | T017 | T015 |
| L11 — ACME resolver | [BE] | T018 → T019 | T004 |
| L12 — DNS pre-check | [BE] | T020 → T021 | T017 |
| L13 — Rate-limit guard | [BE] | T022 → T023 | T015 |
| L14 — Cert lifecycle SM | [BE] | T024 → T025 | T004 |
| L15 — Manifest entry | [BE] | T026 → T027 | T002 |
| L16 — Reconciler skeleton + cron + notifier | [BE] | T028 → T029, T030 | T008 + T010 + T024 |
| L17 — Domain route + apps mod | [BE] | T031 → T036 (parallel) | foundational complete |
| L18 — Certs routes (issue/list) | [BE] | T032, T033 (parallel) | foundational complete |
| L19 — Settings routes | [BE] | T034 → T035 (parallel) | T008 |
| L20 — WS event wiring | [BE] | T037 | T024 + T031 |
| L21 — Apps UI | [FE] | T038 → T039, T040, T041 (parallel after T038) | T013 |
| L22 — Settings UI | [FE] | T042 → T043 | T034 + T035 |
| L23 — US1 integration | [BE] | T044, T045 (parallel) | T031 + T028 |
| L24 — Cert expiry alerter (US2) | [BE] | T046 → T047 → T048 → T049 | T024 + T030 |
| L25 — Domain-change grace + cleanup (US3) | [BE] | T050 → T051 → T052 | T010 + T031 + T028 |
| L26 — Grace banner UI (US3) | [FE] | T053 | T038 |
| L27 — Hard delete wizard (US4) | [BE/FE] | T054 → T055 → T056 → T057 | T008 + T031 |
| L28 — Force renew (US5) | [BE/FE] | T058 → T059, T060 (parallel) | T008 + T024 + T031 |
| L29 — Security review | [SEC] | T061 | all impl + integration tests |
| L30 — Regression + quickstart | [E2E/BE] | T062 → T063 | T061 |

---

## Agent Summary

| Agent | Tasks | Count | Start Condition |
|-------|-------|-------|-----------------|
| `[SETUP]` | T001, T004 | 2 | start (T001) / after L1+L2 (T004) |
| `[OPS]` | T002, T003, T070 | 3 | start / T002 (T070) |
| `[DB]` | T005, T006, T066 | 3 | T004 |
| `[BE]` | T007, T008, T009, T010, T011, T012, T014, T015, T016, T017, T018, T019, T020, T021, T022, T023, T024, T025, T026, T027, T028, T029, T030, T031, T032, T033, T034, T035, T036, T037, T044, T045, T046, T047, T048, T049, T050, T051, T052, T054, T055, T057, T058, T060, T063, T064, T067, T068, T069, T071, T072 | 51 | per graph |
| `[FE]` | T013, T038, T039, T040, T041, T042, T043, T053, T056, T059, T065, T073 | 12 | per graph |
| `[SEC]` | T061 | 1 | after all impl + tests |
| `[E2E]` | T062 | 1 | after T061 |

Total: **74 tasks** (T001–T063 baseline + T064–T074 review-pass; T055 amended in place — no new node).

By user story: US1 = 20 (T031–T045 + T064–T067 + T073), US2 = 4 (T046–T049), US3 = 6 (T050–T053 + T068–T069), US4 = 4 (T054–T057, T055 amended), US5 = 3 (T058–T060). Setup = 4. Foundational = 29 (added T070, T071, T072). Polish = 3.

---

## Critical Path

```
T001 → T004 → T005 → T006 → T024 → T028 → T071 → T031 → T064 → T044 → T061 → T062 → T063
```

13 tasks on the critical path (was 11; +2 for T071 row-level lock amending T028 before T031 can safely run, and T064 DNS-recheck path before US1 integration). T028 + T031 remain the convergence points for every user-story task; T071 (drift-lock amendment) is now mandatory before US1 ships per the Gemini concurrent-edge-case requirement. T024 (cert lifecycle state machine) and T028 (reconciler) are the convergence points — every user-story task depends on at least one of them.

---

## Implementation Strategy

### MVP scope

**Phases 1 + 2 + 3** (T001..T045, 45 tasks): operator can attach a domain to an existing app, DNS pre-check enforces FR-014, cert reaches `active` over HTTPS, cert widget renders, settings page exposes ACME email + connectivity test.

After MVP, Phase 4 (cert expiry alerter, T046–T049) ships next — closes the SC-002/SC-003 feedback loop and is also P1.

Phases 5–7 (US3 grace, US4 hard delete, US5 force renew) are P2/P3 — deliver incrementally.

### Incremental delivery cut points

- **After T030**: foundational primitives all unit-covered; no UI yet.
- **After T037**: backend US1 covered; UI still pending.
- **After T045**: US1 fully shippable.
- **After T049**: US2 ships — feature is operationally closed-loop.
- **After T057**: US3 + US4 shipped — full lifecycle including destructive cleanup.
- **After T063**: release-ready.

### Parallel agent strategy

- **Post-T004 (schema barrier)**: 11 backend lanes fork (L4–L14) — migration, ssh tunnel, caddy admin client, config builder, domain validator (server+client), PSL, Cloudflare CIDRs, ACME resolver, DNS pre-check, rate-limit guard, cert lifecycle.
- **Post-T028 (reconciler skeleton)**: every user-story BE lane viable.
- **Post-T013 (client validator)**: every FE lane viable.
- **Post-foundational sync barrier**: L17–L22 fan out simultaneously across BE + FE.
- **[SEC] (L29)**: hard gate. Runs only after every implementation + integration test lane completes.
- **[E2E] (L30)**: post-security regression suite. Last lane before release.

### Test-first discipline (TDD-Lite per CLAUDE.md §7)

Every helper / service / state-machine task has a co-committed test task: T008+T009, T010+T011, T012+T014, T015+T016, T018+T019, T020+T021, T022+T023, T024+T025, T026+T027, T046+T047. Integration tests (T044, T045, T049, T052, T057, T060) land alongside or immediately after the route they cover.

### Coding-standards alignment

- **Route handlers**: Zod validation everywhere (`validateDomain` refines, `z.union([z.string(), z.null()]).optional()`); structured `{ error: { code, message, details } }` per contracts/api.md; Drizzle parameterized SQL; no `as any`; no string-interpolated SQL ✅
- **Services**: typed inputs/outputs (discriminated unions for `CaddyConfig`, `PrecheckOutcome`, `RateLimitResult`, `CertEvent`, `ValidateResult`); pure where possible (config-builder, cert-lifecycle, ACME resolver, alerter, validator) ✅
- **DB**: via Drizzle for app queries; reviewable static `.sql` migration with CHECK constraints on every enum (FR-004 status + orphan_reason consistency, FR-030 domain regex, proxy_type whitelist) and partial UNIQUE index (FR-001) ✅
- **Logging**: pino structured `logger.info({ ctx: '<service>', ... }, 'msg')`, no `console.log`; no secret leakage in error messages or audit rows (FR-029) ✅
- **UI**: controlled inputs, no `dangerouslySetInnerHTML`, server `{ code }` errors mapped to user-friendly text in components ✅
- **No new packages**: PSL bundled as JSON data, Cloudflare CIDRs hardcoded fallback, TLS handshake via Node `tls.connect` (research.md R-010), no new npm deps (CLAUDE.md Standing Order 2) ✅
- **No destructive ops without consent**: hard-delete typed-confirm enforced server-side (FR-027); orphan cleanup runs only on rows in `orphaned` state past retention window ✅
- **No `--force` / `--yes`**: Caddy install via `|| true` idempotency, never `--yes` (CLAUDE.md Standing Order 3) ✅
- **No `.env` reads**: Caddy admin endpoint is a const `127.0.0.1:2019`; ACME email lives in `app_settings` DB row, never an env var ✅
