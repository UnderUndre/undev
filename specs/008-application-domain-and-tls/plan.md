# Implementation Plan: Application Domain & TLS

**Branch**: `main` (spec-on-main convention per features 005/006/007) | **Date**: 2026-04-28 | **Spec**: [spec.md](spec.md)

## Summary

Replace manual `nginx vhost + certbot` plumbing with a Caddy-fronted reverse proxy whose desired-state lives in the dashboard DB. Three new tables (`app_certs`, `app_cert_events`, `app_settings`) plus three new columns on `applications` (`domain`, `acme_email`, `proxy_type`) capture the binding between an app, its public domain, and its Let's Encrypt certificate. A reconciler PUTs the full Caddy config via the admin API at `localhost:2019` over an SSH tunnel; Caddy diffs it and reloads. A daily `cert_expiry` probe (owned by feature 006) writes `app_certs.expires_at` back into the DB; a 14/7/3/1-day windowed alerter fires Telegram when renewal stalls. DNS pre-check (Node `dns.resolve4/6` + Cloudflare CIDR) catches the most common operator mistake before it burns a Let's Encrypt rate-limit slot.

`scripts/server/setup-vps.sh` gains a Caddy-install block that runs Caddy as `caddy:2.7` in a `caddy` Docker network shared with managed apps; the legacy `setup-ssl.sh` stays operative for `proxy_type = 'nginx-legacy'` apps but is no longer the path for new domains. The dashboard ships nginx-Caddy port co-existence (Caddy on `:80/:443`, nginx on `:8080/:8443`) so existing nginx-legacy apps keep working until an operator opts to migrate.

The feature is the structural backbone for two other specs: 006 owns the periodic observation that detects cert drift (FR-006a, FR-006b), and 009's bootstrap wizard delegates `PROXY_APPLIED` and `CERT_ISSUED` steps to this feature's reconciler. The contract between 008 and those features is a thin reconciler interface, not deep coupling.

## Technical Context

**Existing stack** (inherited from 001–007):

- Express 5 + React 19 / Vite 8 / Tailwind 4, drizzle-orm + `postgres` (porsager) 3.4.x.
- `sshPool` (`ssh2` 1.17) with `exec`, `execStream`, plus 005's `executeWithStdin`.
- `jobManager` for in-memory job lifecycle + WS event fan-out.
- Pino logger with redact config.
- Feature 004 `deployLock` for serialised target-side ops.
- Feature 005 `scriptsRunner` + `scripts-manifest.ts` + `shQuote` helper.
- Feature 005 `script_runs` table (history dual-writes).
- Feature 006 `notifier` (Telegram), probe scheduler, `app_health_probes` retention pattern.
- Feature 007 `validateScriptPath` parity test pattern (single-validator-many-callers).

**New for this feature**:

- One new column trio on `applications` — `domain`, `acme_email`, `proxy_type`.
- Three new tables — `app_certs`, `app_cert_events`, `app_settings`.
- `caddyAdminClient` — SSH-tunnelled HTTP client for `localhost:2019`. Reuses `sshPool` long-lived connections (R-001).
- `caddyReconciler` — drift-detection cron (5 min) + on-write trigger; computes desired Caddy config from DB, PUTs `/load` idempotently.
- `dnsPrecheck` — `dns.resolve4/6` + Cloudflare CIDR classifier (R-003).
- `acmeEmailResolver` — pure function `(app, settings) → string | null`.
- `rateLimitGuard` — 7-day rolling counter on `app_certs` keyed by registered domain (PSL lookup, R-004).
- `domainValidator` — RFC-1035-light regex (FR-030) + wildcard rejection.
- `certLifecycle` — pure state-machine helpers: `transition(cert, event) → cert'` plus event-log writes.
- `orphanCleanupJob` — daily DELETE on `app_certs` where `orphan_reason` window elapsed.
- `caddyConfigBuilder` — pure function `(server, apps[]) → CaddyConfig` JSON.
- `psl` lookup (Mozilla PSL) — bundled snapshot, refreshed at release (R-004).
- New routes: `PATCH /api/applications/:id/domain`, `POST /api/applications/:id/certs/issue`, `POST /api/applications/:id/certs/:certId/renew`, `POST /api/applications/:id/certs/:certId/revoke`, `GET /api/applications/:id/certs`, `GET /api/settings/tls`, `PATCH /api/settings/tls`, `POST /api/settings/tls/test-caddy`.
- WS events: `cert.state-changed`, `caddy.unreachable`.
- `setup-vps.sh` extension — Caddy install block (apt + docker network + admin-API binding).
- New manifest entry: `server-ops/install-caddy` (locus: `target`, idempotent).
- UI: app-detail "Domain & TLS" section, Settings "TLS / ACME" page, cert event timeline.

**No new npm dependencies** other than the bundled Mozilla PSL snapshot (a single ~200KB JSON file under `devops-app/server/lib/psl-snapshot.json`). The PSL is data, not code — A-006 carries the version bump cost.

**Unknowns resolved in research.md**:

- R-001: Caddy admin API SSH-tunnel lifetime.
- R-002: Caddy config representation (full JSON blob in memory; not persisted).
- R-003: Cloudflare CIDR refresh (boot fetch + hardcoded fallback).
- R-004: Public Suffix List dependency (bundled snapshot, not runtime fetch).
- R-005: Cert revocation API path (Caddy admin API).
- R-006: Domain validation regex sourcing.
- R-007: Rate-limit window calculation (rolling 7-day on local rows).
- R-008: nginx-legacy detection strategy.
- R-009: Migration backfill for `proxy_type`.
- R-010: TLS handshake probe library choice (Node `tls.connect`).
- R-011: ACME account email lifecycle on global-key change.
- R-012: Caddy upstream addressing (Docker DNS service name, not host port).

## Project Structure

```
undev/
├── scripts/
│   └── server/
│       ├── setup-vps.sh                # [MODIFIED — adds Caddy install block]
│       ├── setup-ssl.sh                # [unchanged — kept for nginx-legacy apps]
│       └── install-caddy.sh            # [NEW — idempotent Caddy install + admin-API bind]
└── devops-app/
    ├── server/
    │   ├── db/
    │   │   ├── schema.ts               # [MODIFIED — applications cols + 3 new tables]
    │   │   └── migrations/
    │   │       └── 0008_application_domain_and_tls.sql  # [NEW]
    │   ├── lib/
    │   │   ├── domain-validator.ts     # [NEW — RFC-1035 light + wildcard reject]
    │   │   ├── psl.ts                  # [NEW — registered-domain lookup]
    │   │   ├── psl-snapshot.json       # [NEW — Mozilla PSL bundled]
    │   │   └── cloudflare-cidrs.ts     # [NEW — boot fetcher + hardcoded fallback]
    │   ├── services/
    │   │   ├── caddy-admin-client.ts   # [NEW — SSH-tunnelled HTTP client]
    │   │   ├── caddy-config-builder.ts # [NEW — pure DB→Caddy JSON]
    │   │   ├── caddy-reconciler.ts     # [NEW — cron + on-write reconcile]
    │   │   ├── dns-precheck.ts         # [NEW — resolve4/6 + Cloudflare classify]
    │   │   ├── acme-email-resolver.ts  # [NEW — per-app → global → null]
    │   │   ├── rate-limit-guard.ts     # [NEW — 7-day rolling per registered domain]
    │   │   ├── cert-lifecycle.ts       # [NEW — state-machine helpers + event writes]
    │   │   ├── orphan-cleanup-job.ts   # [NEW — daily DELETE on retention window]
    │   │   ├── notifier.ts             # [MODIFIED — adds cert/Caddy message types]
    │   │   └── scripts-runner.ts       # [unchanged — Caddy install reuses runner]
    │   ├── scripts-manifest.ts         # [MODIFIED — adds server-ops/install-caddy]
    │   └── routes/
    │       ├── apps.ts                 # [MODIFIED — accept domain/acme_email/proxy_type]
    │       ├── certs.ts                # [NEW — issue/renew/revoke/list]
    │       ├── domain.ts               # [NEW — PATCH domain + DNS pre-check]
    │       └── settings.ts             # [MODIFIED — TLS section endpoints]
    ├── client/
    │   ├── components/
    │   │   ├── apps/
    │   │   │   ├── DomainTlsSection.tsx     # [NEW — app-detail Domain&TLS panel]
    │   │   │   ├── DomainEditDialog.tsx     # [NEW — DNS pre-check form]
    │   │   │   ├── CertEventTimeline.tsx    # [NEW — append-only event log render]
    │   │   │   └── HardDeleteWizard.tsx     # [NEW — typed-confirm + cleanup steps]
    │   │   └── settings/
    │   │       └── TlsAcmeSection.tsx       # [NEW — global ACME email + test Caddy]
    │   └── pages/
    │       ├── ApplicationDetail.tsx        # [MODIFIED — mount DomainTlsSection]
    │       └── SettingsPage.tsx             # [MODIFIED — mount TlsAcmeSection]
    └── tests/
        ├── unit/
        │   ├── domain-validator.test.ts          # [NEW — 30+ FR-030 cases]
        │   ├── psl-registered-domain.test.ts     # [NEW — co.uk / com / xn-- cases]
        │   ├── caddy-config-builder.test.ts      # [NEW — DB rows → JSON snapshot]
        │   ├── acme-email-resolver.test.ts       # [NEW — 4-case truth table]
        │   ├── rate-limit-guard.test.ts          # [NEW — boundary + reset cases]
        │   ├── dns-precheck.test.ts              # [NEW — match/cf/mismatch/nx]
        │   └── cert-lifecycle.test.ts            # [NEW — every transition table]
        └── integration/
            ├── caddy-reconciler.test.ts          # [NEW — drift detection round-trip]
            ├── certs-api.test.ts                 # [NEW — POST issue → DB row + WS event]
            ├── domain-change-grace-period.test.ts # [NEW — 7-day orphan retention]
            ├── hard-delete-cert-cleanup.test.ts   # [NEW — typed confirm + Caddy DELETE]
            ├── caddy-unreachable-pending.test.ts  # [NEW — pending_reconcile + Telegram]
            └── migration-0007-verification.test.ts # [NEW — backfill correctness]
```

## Key Implementation Notes

### Caddy admin API client — `services/caddy-admin-client.ts`

SSH-tunnelled HTTP. Long-lived `sshPool` connection per server stays open; the client opens a fresh local TCP forward each request via `ssh2`'s `forwardOut`. R-001 chooses per-request forwarding because Caddy admin API is low-volume (≤1 req per reconcile cycle, ≤1 cycle per 5 minutes per server when idle) — keeping a dedicated long-lived port forward burns a file descriptor per server for no measurable latency win.

Public surface (idempotent by design — Caddy diffs server-side):

```ts
class CaddyAdminClient {
  // Idempotent — Caddy's admin API computes the diff and reloads only what changed.
  async load(serverId: string, config: CaddyConfig): Promise<void>;
  // Connectivity probe (FR-025 test button, FR-006b health probe).
  async getConfig(serverId: string): Promise<CaddyConfig>;
  // Targeted revoke for hard-delete (FR-018) — uses Caddy's PKI app endpoint.
  async revokeCert(serverId: string, identifier: string): Promise<void>;
  // Force a cert renewal attempt out-of-band (FR-021).
  async renewCert(serverId: string, identifier: string): Promise<void>;
}
```

Errors: timeout (8s), HTTP non-2xx, SSH tunnel failure → all surface as `CaddyAdminError` with `{ kind: 'timeout' | 'http' | 'ssh', cause }` so callers (`reconciler`, `routes/certs.ts`) can branch on the kind without parsing strings.

### Reverse-proxy reconciler — `services/caddy-reconciler.ts`

Three triggers:

1. **On-write** — `routes/domain.ts`, `routes/apps.ts` (when `domain` / `proxy_type` / `upstream_*` change), `routes/certs.ts` (revoke). Runs synchronously inside the request handler, returns success only after Caddy `/load` returns 200.
2. **5-minute drift cron** (`setInterval(5 * 60 * 1000).unref()`). Per server: fetch current Caddy config via `GET /config/`, compute desired via `caddyConfigBuilder`, deep-equal compare; if drift, `POST /load` with desired.
3. **Manual** — UI "Reconcile now" button (P3, behind `dangerLevel: low`).

Failure handling per FR-009:

```ts
async function reconcile(serverId: string): Promise<ReconcileResult> {
  const apps = await fetchAppsForServer(serverId);
  const desired = buildCaddyConfig(server, apps);
  try {
    await caddyAdminClient.load(serverId, desired);
    return { ok: true };
  } catch (err) {
    if (err instanceof CaddyAdminError) {
      // Mark every cert row whose app is on this server as pending_reconcile.
      await db.update(appCerts)
        .set({ status: sql`CASE WHEN status = 'active' THEN 'active' ELSE 'pending_reconcile' END` })
        .where(inArray(appCerts.appId, apps.map(a => a.id)));
      // Telegram once per "unreachable" transition, debounced via in-memory state.
      caddyUnreachableDebouncer.maybeFire(serverId, err);
    }
    return { ok: false, err };
  }
}
```

The `pending_reconcile` write deliberately preserves `active` certs unchanged (a drifted active cert is still a valid cert; only non-active states get the marker). The 5-minute backoff loop self-heals once Caddy reachability returns; on success, `pending_reconcile → active|pending|...` reverts.

### DNS pre-check — `services/dns-precheck.ts`

Pure-Node `dns.resolve4` + `dns.resolve6` (no shellouts). Cloudflare CIDR list loaded at boot from `https://www.cloudflare.com/ips-v4/` + `/ips-v6/` (R-003); falls back to a hardcoded snapshot in `lib/cloudflare-cidrs.ts` if the fetch fails (offline/test env). The snapshot is updated manually per release — A-001 says "refreshed at install" but for an installed dashboard the install moment is each restart, so the boot fetch covers ~99% of operators.

```ts
type PrecheckOutcome =
  | { kind: 'match'; resolvedIps: string[] }
  | { kind: 'cloudflare'; resolvedIps: string[]; cfRanges: string[] }
  | { kind: 'mismatch'; resolvedIps: string[]; serverIp: string }
  | { kind: 'nxdomain' };

async function precheck(domain: string, serverIp: string): Promise<PrecheckOutcome>;
```

Per FR-014: route handler maps `nxdomain → 400 DNS_NXDOMAIN`, `mismatch | cloudflare` → returns the warning shape and requires `confirmDnsWarning: true` in the request body to proceed. `match` → silent pass.

### Cert lifecycle state machine — `services/cert-lifecycle.ts`

Pure functions over the `app_certs.status` enum. The transition table:

| from              | event                    | to                  | side effect                                      |
|-------------------|--------------------------|---------------------|--------------------------------------------------|
| (none)            | `issue_requested`        | `pending`           | INSERT `app_certs`, INSERT event `pending`       |
| `pending`         | `caddy_active`           | `active`            | set `issued_at`, `expires_at`, event `issued`    |
| `pending`         | `caddy_failed`           | `failed`            | set `error_message`, event `failed`              |
| `pending`         | `acme_rate_limit`        | `rate_limited`      | set `retry_after`, event `rate_limited`          |
| `active`          | `expiry_probe_passed`    | `active`            | update `expires_at`                              |
| `active`          | `expires_at_in_past`     | `expired`           | event `expired`                                  |
| `active`          | `domain_changed`         | `orphaned`          | set `orphaned_at`, `orphan_reason='domain_change'`, event `orphaned` |
| `active`          | `app_soft_deleted`       | `orphaned`          | set `orphaned_at`, `orphan_reason='app_soft_delete'`, event `orphaned` |
| `active`          | `force_revoke`           | `revoked`           | call Caddy revoke, event `revoked`               |
| `failed`          | `force_renew_requested`  | `pending`           | event `force_renew_requested`                    |
| `expired`         | `force_renew_requested`  | `pending`           | event `force_renew_requested`                    |
| `rate_limited`    | `force_renew_requested`  | `pending` (if `retry_after < now()`) | event `force_renew_requested`        |
| `orphaned`        | `retention_window_elapsed` | (deleted)         | DELETE row, DELETE Caddy storage files           |

Every transition writes to `app_cert_events` with `actor` (`'system'` for cron/probe, `userId` for operator). Side effects (Caddy calls, file deletion) are NOT inside the pure transition function — the orchestrator (`caddyReconciler`, `orphanCleanupJob`, route handlers) calls the side-effect-free `transition(cert, event)`, then dispatches based on the diff.

### ACME email resolver — `services/acme-email-resolver.ts`

```ts
function resolveAcmeEmail(
  app: { acmeEmail: string | null },
  settings: { acmeEmail: string | null },
): string | null {
  if (app.acmeEmail) return app.acmeEmail;
  if (settings.acmeEmail) return settings.acmeEmail;
  return null;
}
```

Pure, 4-line. Returns `null` to mean "block — set ACME email in Settings". Caller (`routes/certs.ts:POST /issue`) maps `null → 400 ACME_EMAIL_REQUIRED`.

### Rate-limit guard — `services/rate-limit-guard.ts`

Counts `app_certs` rows in `('pending', 'active', 'failed')` over the last 7 days, grouped by **registered domain** (FR-024). Registered domain via `lib/psl.ts` lookup. Boundary at 5 (block) and 3 (warn).

```ts
async function checkRateLimit(domain: string): Promise<RateLimitResult> {
  const registered = pslGetRegisteredDomain(domain);
  // SQL: SELECT COUNT(*) FROM app_certs
  //  WHERE status IN ('pending', 'active', 'failed')
  //    AND created_at > NOW() - INTERVAL '7 days'
  //    AND (domain = $1 OR domain LIKE '%.' || $1)
  const count = await countCertsForRegistered(registered);
  if (count >= 5) return { kind: 'block', count, registered };
  if (count >= 3) return { kind: 'warn', count, registered };
  return { kind: 'ok', count, registered };
}
```

R-007 keeps the window calculation local-DB-only; we don't query Let's Encrypt's actual API for slot availability (no public endpoint, can only infer from response headers on the next attempt). Our rolling 7-day on local rows is conservative — we may block at 5 when LE has >5 slots open if someone deleted rows manually, but we never under-block.

### Domain input validator — `lib/domain-validator.ts`

Per FR-030: regex `^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$`. Wildcards (`*.`) rejected by the leading-character rule. Returns `{ ok: true, value }` or `{ ok: false, error }`. Single source of truth — server route handler, manifest entry param schema, and the Drizzle Zod refine all share this.

R-006 picked the practical regex over RFC-1035 strict because RFC-1035 allows leading-digit labels (legal: `1foo.com`) and our regex matches that, while still rejecting underscore (`_dmarc.foo.com` is technically valid for SRV/TXT but not for HTTPS hosts, so reject is correct).

### `setup-vps.sh` Caddy install extension

Append a numbered section after the existing nginx install (line 31). The diff:

```bash
# 8. Caddy (Feature 008) — Docker-managed, on the `caddy` network
echo "▸ Installing Caddy via Docker..."
# Move nginx to fallback ports (8080/8443) so Caddy owns 80/443
sed -i 's/listen 80/listen 8080/g; s/listen 443/listen 8443/g' /etc/nginx/sites-enabled/* 2>/dev/null || true
systemctl reload nginx 2>/dev/null || true

docker network create caddy 2>/dev/null || true
docker volume create caddy_data 2>/dev/null || true
docker volume create caddy_config 2>/dev/null || true

# Run Caddy with admin API bound to localhost only (FR-028)
docker run -d --name caddy --restart unless-stopped \
  --network caddy \
  -p 80:80 -p 443:443 -p 443:443/udp \
  -p 127.0.0.1:2019:2019 \
  -v caddy_data:/data \
  -v caddy_config:/config \
  caddy:2.7 \
  caddy run --config /config/caddy.json --adapter json
```

UFW: ufw rules for `80`, `443` already covered by `Nginx Full`. Port `2019` is bound to `127.0.0.1` at the docker run level — UFW does not need a deny rule because Docker's userland proxy listens on `127.0.0.1` only.

The `caddy.json` initial config is a minimal `{ "admin": { "listen": "127.0.0.1:2019" }, "apps": { "http": { "servers": {} } } }` written to the volume on first run via `setup-vps.sh`. After that, the dashboard's reconciler owns the config.

Idempotency: every step uses `|| true` or pre-checks (`docker network create caddy 2>/dev/null || true`) so re-running `setup-vps.sh` does not error.

### UI: app-detail "Domain & TLS" section — `client/components/apps/DomainTlsSection.tsx`

Mounted from `ApplicationDetail.tsx` between the existing "Server" section and "Deployments". Renders one of three states:

1. **No domain** — single "Add domain" button → opens `DomainEditDialog`.
2. **Domain set, cert active** — shows: domain (clickable, opens HTTPS), issuer, `expires_at` (with "in 47 days" relative), "Force renew" button (disabled unless cert is `failed`/`expired`/`rate_limited`), "Change domain" button, "Revoke" button (typed-confirm).
3. **Domain set, cert pending/failed** — yellow banner with cert status + error_message + "Force renew" button.

Append-only `CertEventTimeline.tsx` below renders `app_cert_events` rows in reverse-chrono with icons per `event_type`.

### UI: Settings TLS / ACME — `client/components/settings/TlsAcmeSection.tsx`

Three controls per FR-025:

1. `acme_email` text input (validated client-side as `/^\S+@\S+\.\S+$/`).
2. `caddy_admin_endpoint` read-only display ("`localhost:2019` over SSH tunnel — managed automatically").
3. "Test Caddy connectivity" button → `POST /api/settings/tls/test-caddy?serverId=...` per server, renders results inline (`green: 200 OK in Xms` or `red: ssh tunnel failed`).

### Migration plan

Order (single migration file `0008_application_domain_and_tls.sql`):

1. `ALTER TABLE applications ADD COLUMN domain TEXT NULL`.
2. `ALTER TABLE applications ADD COLUMN acme_email TEXT NULL`.
3. `ALTER TABLE applications ADD COLUMN proxy_type TEXT NOT NULL DEFAULT 'caddy'`.
4. Backfill `proxy_type` per R-009: rows where any `app_certs`-equivalent indicator suggests pre-feature nginx (none today — the table is new), default to `'caddy'` for new apps; pre-feature apps with existing nginx vhost files on their server get migrated to `'nginx-legacy'` via a one-shot SSH probe at first reconciler tick (NOT in the migration — the probe needs SSH which the migration runner does not have).
5. `CREATE TABLE app_certs (...)` + indices.
6. `CREATE TABLE app_cert_events (...)` + index on `cert_id`.
7. `CREATE TABLE app_settings (...)` + seed row `('acme_email', NULL, NOW())`.
8. `CREATE UNIQUE INDEX idx_apps_server_domain_unique ON applications(server_id, domain) WHERE domain IS NOT NULL` — partial unique per FR-001.

Backfill of `proxy_type` for existing apps:

| existing state                                         | `proxy_type` after migration | further action                    |
|--------------------------------------------------------|------------------------------|-----------------------------------|
| New apps created post-feature (no `domain` yet)        | `'caddy'`                    | reconcile no-op until domain set  |
| Pre-feature apps (`domain IS NULL` because col is new) | `'caddy'`                    | first probe tick may flip to `'nginx-legacy'` |
| Pre-feature apps with manual nginx + cert              | `'caddy'` initially → `'nginx-legacy'` after probe detects `nginx -T` match | reconciler is no-op for nginx-legacy (FR-011) |

The probe is a one-shot per server, fires the first time the reconciler runs after restart. Caches the result in `servers.proxy_type_probed_at` (no schema change needed — could store in memory only if persistence is overkill; planning to keep memory-only for v1, see Open Questions).

### Audit & secrets

- ACME private keys NEVER leave the target — they live in Caddy's `/data` volume on the target host, never copied to dashboard, never logged (FR-029).
- ACME emails are plaintext (not secret per RFC 8555 — emails are public-key-binding metadata).
- `caddy_admin_endpoint` is `127.0.0.1:2019` — never exposed publicly (FR-028, enforced by `setup-vps.sh` docker run flags).

## Constitution / Guardrails Check

No `.specify/memory/constitution.md`. Applying CLAUDE.md AI-Generated Code Guardrails:

| Anti-pattern                                | Compliance in this feature                                                              |
|---------------------------------------------|-----------------------------------------------------------------------------------------|
| `process.env.X \|\| "fallback"`             | Caddy admin port read from a const `CADDY_ADMIN_PORT = 2019`, not an env. ACME email reads via `acmeEmailResolver` returning `null` on missing — caller throws `AppError.badRequest()`. |
| `as any`                                    | All Caddy config types declared as discriminated unions in `caddy-config-builder.ts`. PSL lookup return is `string | null`. |
| `throw new Error()`                         | Replaced by `CaddyAdminError`, `RateLimitBlockedError`, `DnsPrecheckBlockedError`, `AcmeEmailRequiredError`. Each has a code + 400/403/500 mapping in routes. |
| `console.log()`                             | All logs via pino logger with `ctx: 'caddy-reconciler'` / `'cert-lifecycle'` / etc.     |
| `catch (e) { }`                             | Reconciler catches Caddy errors, logs `logger.error({ err })`, marks rows `pending_reconcile`, debounces Telegram alert — never silent. |
| `dangerouslySetInnerHTML`                   | UI components render plain text + structured props; no innerHTML.                       |
| `req.body.field` without Zod                | All routes use `validateBody(schema)` middleware (existing pattern from 005/007).       |
| `if (x === y) return true` unconditional bypass | Rate-limit guard always queries DB; never short-circuits to "ok" in any code path. |
| Standing Order: no commits without ask      | Plan-only.                                                                              |
| Standing Order: no new packages             | Bundled PSL JSON is data, not a package; no new `npm i`.                                |
| Standing Order: no `--force` flags          | UFW reset uses `--force` (kept from existing `setup-vps.sh:60` pre-this-feature; not introduced here). Caddy admin API has no `--force` equivalent. |
| Standing Order: no secrets in code/logs     | Caddy storage paths logged at info, but contents (private keys) never read by dashboard. |
| Standing Order: no direct DB migrations     | `0008_*.sql` ships for admin review; no inline ORM `db.execute(sql\`...\`)` migrations. |
| Standing Order: no destructive ops without consent | Hard-delete cert REQUIRES typed `confirm_name` payload (FR-027); orphan cleanup runs daily on rows already `orphaned` for `>= 7d` — destructive on rows operator chose to abandon. |
| Standing Order: no `.env` reads             | `acme_email` lives in DB (`app_settings`), not env. Caddy admin URL is a const. |

The Caddy DELETE on hard-delete is destructive but operator-gated by typed-confirm — same pattern as feature 005's `dangerLevel: 'high'` scripts.

## Complexity Tracking

| Addition                          | Why Needed                                                                 | Simpler Alternative Rejected                                                                               |
|-----------------------------------|----------------------------------------------------------------------------|------------------------------------------------------------------------------------------------------------|
| Bundled Mozilla PSL JSON snapshot | FR-024 requires effective-registered-domain lookup; PSL is the only correct source | Runtime fetch — adds boot-time network dependency + cache invalidation complexity for a static-ish dataset |
| 5-minute drift cron + on-write reconcile | FR-006 demands "every 5-minute drift-detection"; on-write is best-effort latency | On-write only — drift from manual SSH edits goes undetected; cron only — write-to-active latency 0..5 min |
| `pending_reconcile` distinct from `pending` | FR-009 — operator must know a cert's desired state is captured but unapplied | Conflate with `pending` — loses the distinction between "Caddy will retry soon" and "we couldn't even reach Caddy" |
| `app_cert_events` append-only table | FR-020/026 — cert lifecycle is a forensics surface + UI timeline           | Inline columns on `app_certs` — loses history; transitions are lossy                                        |
| `orphan_reason` enum column         | OQ resolved 2026-04-28: need post-hard-delete audit trail                  | Compute via JOIN with `applications.deleted_at` — breaks when app row is hard-deleted (no row to JOIN)     |
| `app_settings` table                | FR-005 + future global settings; key-value shape                           | Hard-code `acme_email` env var — defeats FR-016's per-app override + global default flow                   |
| Caddy admin API SSH-tunnel per request | R-001 — admin API low-volume, dedicated long-lived port forward burns FDs | Long-lived forward — no measurable latency saving for ≤1 req per 5 min per server                          |
| Boot-fetched Cloudflare CIDRs       | R-003 — list changes 1-2x per year; freshness matters for FR-013          | Hardcoded only — operator detection of CF proxy degrades 6-12 months post-release without redeploy         |
| Per-app + global ACME email split   | FR-016 — multi-tenant scenarios; mirrors 006 healthProbeIntervalSec        | Single global only — operator with 2 apps under different ACME accounts forced to merge (not always desired) |

## Out of Plan

Mirrors spec § Out of Scope:

- Wildcard certs / DNS-01 challenge (v2 — needs per-DNS-provider integration).
- Multi-domain certs (apex + www).
- nginx-legacy → Caddy migration UI ("Migrate to Caddy" button — separate feature).
- Custom CA / self-signed cert support.
- TLS for the dashboard itself (handled by external Caddy on dashboard host per Spec 002 §184).
- Email / webhook notifications for cert lifecycle.
- Historical cert renewal charts / forecast UI.
- Multi-server cert-pinning HA orchestration beyond the FR-001a soft warning.
- Rate-limit clock that queries Let's Encrypt's actual response headers — local rolling counter only.

## Cross-Spec Contract Surface

Feature 008 owns the **state**; features 006 and 009 own thin slices that touch it.

| 008 owns                                  | 006 reads/writes                              | 009 reads                            |
|-------------------------------------------|-----------------------------------------------|--------------------------------------|
| `app_certs` lifecycle (pending → active → expired → revoked / orphaned) | writes `expires_at` via `cert_expiry` probe (FR-006a) | reads cert state to gate `CERT_ISSUED` step |
| `app_cert_events` table                   | writes events via probe outcomes              | reads to populate bootstrap-progress UI |
| `caddyReconciler`                         | reports drift via `caddy_admin` probe (FR-006b) | calls `reconcile()` during `PROXY_APPLIED` step |
| `app_settings.acme_email`                 | (none)                                        | (none — bootstrap inherits via this feature's resolver) |
| `applications.domain / proxy_type`        | reads to know whether to run cert_expiry probe | writes initial `domain` if operator filled the optional field |

Contract: 006 NEVER writes `app_certs.status` or events — only `expires_at`. 009 NEVER mutates Caddy directly — only invokes 008's reconciler.

## Post-design Constitution Re-check

| Principle                                | Re-check | Note                                                                                  |
|------------------------------------------|----------|---------------------------------------------------------------------------------------|
| No commits/pushes without request        | OK       | Plan-only.                                                                            |
| No new packages                          | OK       | Bundled PSL JSON is data; no new dependency.                                          |
| No secrets in code/logs                  | OK       | ACME private keys stay on target; emails are non-secret per RFC 8555.                 |
| Plan-first >3 files                      | OK       | 25+ files listed.                                                                     |
| No destructive ops without consent       | OK       | Hard-delete typed-confirm; orphan cleanup runs only on rows already orphaned for retention window. |
| No raw string interpolation in SQL       | OK       | Drizzle for app queries; partial-unique index uses parameterised template tag.        |
| No `any`, no `console.log`               | OK       | Plan notes enforce; tests assert.                                                     |
| Three-layer validation parity            | OK       | `domain-validator` shared between route handler, manifest Zod refine, and DB trigger via CHECK constraint. |

Proceed to `/speckit.tasks`.
