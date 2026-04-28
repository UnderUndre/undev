# Feature Specification: Application Domain & TLS

**Version**: 1.0 | **Status**: Draft | **Date**: 2026-04-28

## Clarifications

### Session 2026-04-28 (initial)

- Q: Reverse proxy on managed targets — Caddy or nginx? → A: **Caddy, in the same Docker network as managed apps.** Auto-TLS removes ~200 lines of certbot orchestration; admin API on `localhost:2019` allows idempotent reconciliation (PUT desired config, Caddy diffs and reloads); default-secure cipher suites; native DNS-01 / TLS-ALPN-01 support for Cloudflare scenarios. nginx remains installed by `setup-vps.sh` for legacy ручных sites but moves to ports `8080/8443`; Caddy owns 80/443. Apps deployed before this feature retain `proxy_type = 'nginx-legacy'` and continue working until the operator opts to migrate.
- Q: How does a managed app expose its upstream to Caddy? → A: **Via Docker DNS, never via host port.** Caddy joins the same Docker network as the app's compose project; reverse_proxy target is `<compose-project>-<service>:<internal-port>`. Apps SHOULD remove `ports:` from their compose files for managed-app services — host ports become an attack surface and a port-conflict source. Detection logic falls back gracefully: if `ports:` exists, the right-hand side (container port) is parsed as the upstream.
- Q: ACME email — global setting or per-domain? → A: **Both. Global default in `app_settings`; per-app override in `applications.acme_email`.** Resolution order at issue time: per-app → global → fail with blocking error "Set ACME email in Settings before issuing certs". Mirrors the `healthProbeIntervalSec` global+per-app pattern from feature 006 — operators already know this shape.
- Q: Pre-issuance DNS validation — block or warn? → A: **Warn and allow override.** Resolve the domain's A-record (and AAAA if server has IPv6); compare with `servers.host`. NXDOMAIN → block. Mismatch → yellow warning with explicit "Try anyway (DNS may be propagating)" checkbox. Cloudflare CIDR detected → warning includes "looks like Cloudflare proxy; HTTP-01 may fail; disable orange cloud OR use DNS-01 (v2)". Caddy retries failed challenges automatically every ~10 minutes, so transient propagation lag self-heals.
- Q: Cert lifecycle on domain change / app deletion → A: **Soft retention with grace periods.** Domain change: old cert moves to `status = orphaned`, files held 7 days for rollback. App soft-delete: cert orphaned, files held 30 days (Let's Encrypt rate-limit window). App hard-delete (explicit "Remove everything from server"): immediate revoke + file removal + Caddy site removal, requires typed confirm. NEVER auto-revoke — revocation is operator-initiated.
- Q: Wildcard certs / DNS-01 challenge / private CA → A: **Out of scope v1.** v1 is HTTP-01 only via Caddy auto-TLS. Wildcard requires DNS-provider plugins (Cloudflare API token, Route53 IAM, etc.) — significant per-provider integration cost. Documented as v2 in Out of Scope.
- Q: Orphan-cleanup distinguishes 7-day (domain change) from 30-day (soft delete) windows — derive from JOIN with `applications.deleted_at`, or store reason explicitly? → A: **Explicit `orphan_reason` column on `app_certs`.** Computed-via-JOIN breaks when the parent app is hard-deleted (no `applications` row exists, no place to read `deleted_at` from), losing the reason audit trail. A typed enum column (`domain_change | app_soft_delete | manual_orphan`) costs one field, simplifies cleanup queries to a single `WHERE` clause, and preserves history through hard-delete cascades.
- Q: Caddy version pinning policy — full semver pin (`2.7.6`) or track latest? → A: **Pin major.minor (`caddy:2.7`); accept patch updates.** Full pin (`2.7.6`) freezes security fixes; latest (`caddy:2`) lets renewal/admin-API behaviour drift between dashboard releases. The `caddy:2.7` Docker tag receives patch fixes (CVE / bug) without minor-version surprises (admin API contract changes happen on minor bumps per Caddy's own versioning policy). Major.minor bump (`2.7 → 2.8`) is a deliberate dashboard release with changelog review.
- Q: UNIQUE domain constraint — per-server only, or cross-server? → A: **Hard `UNIQUE (server_id, domain) WHERE domain IS NOT NULL`. Cross-server collision: soft warning at write time, NOT a constraint.** A legitimate HA scenario (one domain on two servers via DNS round-robin or active/passive) is rare but valid; a hard cross-server constraint would prevent it. Operator-error ("typed the same domain twice on different servers") is caught by a `SELECT ... FROM applications WHERE domain = ? AND server_id != ?` advisory check that surfaces a confirmable warning. Operators with deliberate HA proceed; operators who fat-fingered get caught.

## Problem Statement

The dashboard manages applications, but every managed app today is reachable via either an IP+port URL or a manually-configured nginx vhost on the target server. The dashboard does not know:

- What domain (if any) an application should respond to.
- Whether that domain has a valid TLS certificate.
- When that certificate expires.
- Whether the reverse-proxy on the target actually routes the domain to the application.

Concretely, this leaves three operational gaps:

1. **Domain reconciliation is manual.** When an operator wants to give app `foo` the domain `foo.example.com`, today they SSH to the target, hand-edit `/etc/nginx/sites-enabled/foo.conf`, run `nginx -t && systemctl reload nginx`, then run `certbot --nginx -d foo.example.com`. The dashboard observes none of this — it has no record of the binding, cannot detect drift, cannot show "this app has no TLS".
2. **Cert renewal has no feedback loop.** `certbot.timer` is installed by `setup-vps.sh:31`, but if a renewal silently fails (rate-limit, DNS broken, port 80 blocked by a misconfigured firewall rule), the certificate expires without alert. Operator finds out from a customer-reported browser warning.
3. **First-deploy onboarding requires deep knowledge.** A new app needs (a) cloned repo, (b) compose stack up, (c) nginx vhost, (d) certbot issuance, (e) DNS pointed correctly. Today the dashboard helps with (a)+(b) only when the operator pre-clones — and steps (c)+(d) are entirely manual. The result: every new app is a 30-minute SSH session with `vim`.

This feature adds the missing model for domains and certificates: an `applications.domain` field, a `app_certs` table tracking issuance and expiry, a reverse-proxy reconciler that PUTs desired Caddy config via admin API, and pre-issue DNS validation that catches the most common operator mistake (forgot to update A-record) before it burns a Let's Encrypt rate-limit slot.

The deploy-time integration (auto-attach domain to a freshly-bootstrapped app) lives in feature 009. The renewal-failure detection (cert_expiry probe) lives in feature 006. This feature is the structural backbone both depend on.

## User Scenarios & Testing

### User Story 1 — Attach a domain to an existing application (Priority: P1)

As a dashboard admin who just deployed `foo` and wants users to reach it at `foo.example.com`, I want a single form to set the domain and issue a cert, so I never have to SSH into the box to configure nginx or run certbot manually.

**Acceptance**:

- The Application detail view has a "Domain & TLS" section with two inputs: "Domain" (text, e.g. `foo.example.com`) and "ACME Email" (text, optional, falls back to global setting).
- Clicking "Apply" runs DNS pre-check, then writes desired-state to the database, then triggers a Caddy reconciliation via admin API on the target.
- Within 60 seconds (Caddy auto-TLS time, network round-trips) the domain is reachable over HTTPS with a Let's Encrypt cert.
- The detail view shows a "Cert" widget: issuer (Let's Encrypt), `expires_at`, `status` (active/pending/failed), and a "Force renew" button.
- If DNS is wrong, the form shows a yellow warning before any attempt: "Domain X resolves to 1.2.3.4, server is 5.6.7.8 — update A-record or check 'Try anyway'".
- If issuance fails (rate-limit, validation error), the cert row is marked `failed` with `error_message`, and the operator sees the message inline.

### User Story 2 — Get an alert when a cert is close to expiring (Priority: P1)

As a dashboard admin, I want a Telegram alert at 14 days, 7 days, 3 days, and 1 day before a cert expires (if it has not auto-renewed), so I can investigate before users see a browser warning.

**Acceptance**:

- A daily background job re-resolves each active domain and reads its cert via TLS handshake (`openssl s_client -connect <domain>:443`). The parsed `notAfter` is written back to `app_certs.expires_at`.
- When `expires_at` enters one of the alert windows (≤14d, ≤7d, ≤3d, ≤1d) AND no alert has already fired for that window in this cert's lifecycle, Telegram receives a message: "🔒 Cert expiring: {domain} in {days} days. Status: {status}. Last renew: {ago}.".
- Each window fires once per cert renewal. Once a renewal succeeds and pushes `expires_at` past the window, the window unlocks for the next cycle.
- Recovery is silent — if a cert renews from "1 day left" to "89 days left", no recovery message (the original alert was already enough signal that the operator should look).

### User Story 3 — Change an app's domain without losing TLS (Priority: P2)

As an admin migrating `foo` from `foo-staging.example.com` to `foo.example.com`, I want the dashboard to keep the old cert valid for a grace period in case I need to roll back, so I don't end up with no TLS at either domain.

**Acceptance**:

- Editing the Domain field and saving creates a new cert lifecycle for the new domain, leaves the old domain's cert in `status = orphaned` for 7 days.
- Caddy config is updated to serve BOTH domains during the grace period (a 301 from old → new is configurable but not default).
- The detail view shows "Old domain `foo-staging.example.com` cert kept for rollback until {date}. Click to revoke now."
- A daily background job removes orphaned certs whose grace period has elapsed.

### User Story 4 — Remove an app and clean up its TLS state on the server (Priority: P2)

As an admin decommissioning an app, I want a single explicit "Remove everything from server" action that revokes the cert, removes the Caddy site, and stops touching that domain, so the next operator does not inherit ghost configuration.

**Acceptance**:

- The default app delete is soft: removes the app row and references, marks its cert `orphaned` (held 30 days for Let's Encrypt rate-limit window), leaves Caddy serving until orphaned-cleanup runs.
- A separate "Remove everything from server" action requires typing the app name to confirm; on confirm it: (1) ACME-revokes the cert, (2) deletes Caddy site config via admin API, (3) deletes cert files, (4) removes app row.
- The audit log records both states distinctly: "soft-deleted" vs "hard-deleted with server cleanup".

### User Story 5 — Force-renew a cert that's stuck (Priority: P3)

As an admin who sees a `failed` cert that did not auto-renew (rate-limit cleared, but Caddy didn't retry yet), I want a "Force renew" button that triggers an immediate issuance attempt without waiting for Caddy's next backoff window.

**Acceptance**:

- The button is enabled only when cert `status ∈ {failed, expired, rate_limited}` and `retry_after` (if set) is in the past.
- Clicking sends Caddy admin API the directive to retry; cert status moves to `pending`.
- If issuance succeeds, status → `active`. If it fails again, status → `failed` with refreshed `error_message`.

## Edge Cases

- **DNS not propagated yet**: pre-check warning, operator clicks "Try anyway", Caddy issues retry every ~10 minutes. No action from dashboard side. Cert stays `pending` until Caddy reports success or 24 hours elapse (Caddy default), then `failed`.
- **Domain behind Cloudflare proxy (orange cloud)**: HTTP-01 challenge sent to port 80 may be intercepted by Cloudflare's WAF, especially on free plans. Pre-check detects Cloudflare CIDR ranges (Caddy's `cloudflare_ip_ranges` list, refreshed at install) and warns. v1 has no DNS-01 fallback — operator must disable orange cloud OR wait for v2.
- **Multiple A-records (round-robin DNS)**: pre-check passes if **any** of the resolved IPs matches the server. Caddy's HTTP-01 challenge will land on whichever IP DNS resolves the validation request to — that may not be ours. Out of our control; document as known limitation.
- **AAAA-only domain (IPv6 only)**: server must have IPv6 enabled. Currently `setup-vps.sh` does not configure IPv6 explicitly. v1 emits hard error "Server has no IPv6, cannot serve IPv6-only domain"; v2 ships an IPv6 setup step.
- **Wildcard domain entered (`*.foo.com`)**: rejected at form validation with "Wildcard certs require DNS-01 challenge, not supported in v1".
- **Caddy admin API unreachable** (Caddy crashed, container down): reconciler retries with exponential backoff up to 5 minutes; after that the desired-state row is marked `pending_reconcile` and a Telegram alert fires. The cert status is unchanged — the desired state is captured, just not applied. On next successful health probe of Caddy (feature 006 extension), the reconciler retries automatically.
- **Two apps requesting the same domain**: rejected at write time. UNIQUE constraint on `applications.domain WHERE domain IS NOT NULL`. The form returns "Domain X is already used by app Y. Reassign there first."
- **Domain change while cert issuance is in flight**: form submit is blocked with "Cert issuance in progress, wait or cancel". Cancel sends Caddy admin API a directive to abandon the pending cert (no retry); state moves to `failed`.
- **Server's own Caddy serves the dashboard's own domain via the same admin API**: out of scope. The Caddy that fronts the dashboard itself runs on a separate host (per Spec 002 §184); managed-target Caddy is its own instance. No reflection / self-management.
- **Rate-limit clock**: Let's Encrypt allows 5 cert issuances per registered domain per week. Pre-issuance counter in `app_certs` (rows in `failed`/`pending`/`active` for the same effective registered domain over rolling 7d): warn at ≥3, block at ≥5 with "Rate limit reached. Next slot at {timestamp from response}". The operator can clear blocks manually after waiting (or by editing the domain to a different one).
- **Cert renewal happens during a deploy**: probe-pause logic from feature 006 (FR-011) does NOT apply to renewal — renewal is a Caddy internal action, transparent to deploy. If the deploy briefly takes the app down, the cert validation challenge may fail, Caddy retries. No coordination needed.
- **Operator deletes the global ACME email**: existing certs continue auto-renewing under their saved per-app email or the previously-registered ACME account. New cert issuance blocks until a global or per-app email is set.

## Functional Requirements

### Data model

- **FR-001**: The `applications` table MUST gain a column `domain TEXT NULL`. Empty string MUST be normalised to NULL at the API layer (mirrors the `scriptPath` normalisation pattern from feature 007). UNIQUE constraint scoped per-server: `UNIQUE (server_id, domain) WHERE domain IS NOT NULL`. Cross-server collision is NOT a hard constraint — see FR-001a.
- **FR-001a**: When an operator submits a domain that is already in use on a DIFFERENT server (`SELECT 1 FROM applications WHERE domain = ? AND server_id != ?`), the form MUST display a confirmable warning: "Domain X is already configured on server Y. Continuing creates an HA / round-robin setup. Confirm to proceed.". The submission proceeds only if the operator explicitly confirms. The warning is advisory — no DB constraint enforces it.
- **FR-002**: The `applications` table MUST gain a column `acme_email TEXT NULL` for per-app email override; NULL means "use global".
- **FR-003**: The `applications` table MUST gain a column `proxy_type TEXT NOT NULL DEFAULT 'caddy'` — one of `caddy`, `nginx-legacy`, `none`. Apps created before this feature get backfilled to `nginx-legacy` if their server has nginx vhost files referencing them, else `none`.
- **FR-004**: A new `app_certs` table MUST be introduced:
  ```
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  domain TEXT NOT NULL,
  issuer TEXT NOT NULL,            -- 'letsencrypt' | 'self-signed' | 'manual'
  status TEXT NOT NULL,            -- 'pending' | 'active' | 'expired' | 'revoked' | 'rate_limited' | 'failed' | 'orphaned' | 'pending_reconcile'
  issued_at TEXT NULL,             -- ISO
  expires_at TEXT NULL,            -- ISO
  last_renew_at TEXT NULL,         -- ISO
  last_renew_outcome TEXT NULL,    -- 'success' | 'failure'
  error_message TEXT NULL,
  retry_after TEXT NULL,           -- ISO; null unless rate_limited
  orphaned_at TEXT NULL,           -- ISO; null unless orphaned
  orphan_reason TEXT NOT NULL DEFAULT '',  -- '' | 'domain_change' | 'app_soft_delete' | 'manual_orphan'; populated only when status = 'orphaned'
  acme_account_email TEXT NULL,    -- the email that registered with Let's Encrypt
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  ```
- **FR-005**: A new `app_settings` row MUST exist for `acme_email` (key `acme_email`, value NULL by default). Settings table follows the existing key-value pattern from feature 003 if present, else introduces it.

### Reverse proxy reconciliation

- **FR-006**: The dashboard MUST treat `applications.domain + applications.upstream_service + applications.upstream_port` (introduced in feature 009) as desired-state for Caddy. A reconciler MUST be invoked on every domain change, every app deletion, every restart, and on a 5-minute drift-detection cron.
- **FR-007**: The reconciler MUST communicate with the target's Caddy via SSH-tunnelled admin API at `localhost:2019`. SSH tunnel reuses the existing `ssh-pool` (per feature 006 FR-031). No exposing Caddy admin API publicly.
- **FR-008**: The reconciler MUST PUT the full Caddy config (`POST /load`) idempotently. Diffs are computed by Caddy itself; the dashboard does not maintain partial-update endpoints. Source of truth is the dashboard DB; Caddy is a derivative.
- **FR-009**: When the reconciler cannot reach Caddy admin API for ≥5 minutes, the affected `app_certs` rows whose desired-state is not yet applied MUST be marked `status = 'pending_reconcile'` (a distinct status from `pending` — `pending` means "ACME issuance in progress", `pending_reconcile` means "dashboard's desired state could not be pushed to Caddy"). A Telegram alert MUST fire (channel: same notifier as feature 006). On next successful Caddy admin reach (per feature 006 `caddy_admin` probe), the reconciler auto-retries; on success the row transitions back to its prior status (`active`, `pending`, etc.).
- **FR-010**: Caddy site config MUST always include explicit `acme-challenge` location ahead of the reverse_proxy directive (relevant only if a future migration moves us back to nginx; Caddy handles this implicitly). Documented as Caddyfile invariant.
- **FR-011**: For apps with `proxy_type = 'nginx-legacy'`, the reconciler MUST be a no-op — it does NOT touch nginx config. Migration to Caddy is operator-driven via a "Migrate to Caddy" button (P3 feature, not in this spec — see Out of Scope).

### DNS pre-check

- **FR-012**: Before any cert issuance attempt, the dashboard MUST resolve the domain via the Node.js `dns.resolve4` and `dns.resolve6` APIs (not via target SSH — dashboard's own DNS is canonical for this check).
- **FR-013**: Pre-check MUST classify outcomes as: `match` (any resolved IP equals server.host), `cloudflare` (resolved IP in known Cloudflare CIDR), `mismatch` (resolved IPs do not include server.host and not Cloudflare), `nxdomain` (no record).
- **FR-014**: `nxdomain` MUST block issuance with hard error. `match` MUST proceed silently. `cloudflare` and `mismatch` MUST surface a warning in the form with an "I know, try anyway" checkbox. Without the checkbox, issuance does not start.
- **FR-015**: Cloudflare CIDR list MUST be sourced from `https://www.cloudflare.com/ips-v4/` and `/ips-v6/` at server boot, cached in memory, refreshed on dashboard restart. Failure to fetch falls back to a hardcoded snapshot baked into the source (manually updated on each release).

### Cert lifecycle

- **FR-016**: New cert issuance MUST resolve `acme_email` as: `applications.acme_email` (per-app) → `app_settings.acme_email` (global) → block with "Set ACME email in Settings".
- **FR-017**: When `applications.domain` changes, the existing `app_certs` row for the old domain MUST be marked `status = orphaned, orphaned_at = now, orphan_reason = 'domain_change'`, NOT deleted. A new `app_certs` row MUST be created for the new domain with `status = pending`.
- **FR-018**: Soft app delete (default) MUST mark all `app_certs` rows for that app as `orphaned` with `orphan_reason = 'app_soft_delete'`. Hard app delete (explicit "Remove from server") MUST: (1) ACME-revoke each cert (mechanism: Caddy admin API site removal + invocation of Caddy's revoke flow — exact endpoint shape determined in plan/research, NOT prescribed here as a literal path), (2) remove cert files from Caddy storage, (3) remove the Caddy site config, (4) DELETE `app_certs` rows, (5) DELETE app row. Order matters — revoke before file removal so the ACME server records the revocation.
- **FR-019**: A daily background job MUST DELETE `app_certs` rows according to `orphan_reason`:
  - `orphan_reason = 'domain_change'` AND `orphaned_at < now() - 7 days` → DELETE.
  - `orphan_reason = 'app_soft_delete'` AND `orphaned_at < now() - 30 days` → DELETE (matches Let's Encrypt rate-limit window).
  - `orphan_reason = 'manual_orphan'` AND `orphaned_at < now() - 7 days` → DELETE.
  Each delete also removes Caddy storage files for the cert via SSH + `rm` on `/var/lib/caddy/.../<domain>` (paths derived from Caddy storage layout).
- **FR-020**: The cert lifecycle MUST be observable in the UI: every state transition writes to an append-only `app_cert_events` table (or reuses `script_runs` semantics if the existing pattern fits) — `(id, cert_id, event_type, event_data, occurred_at)`.
- **FR-021**: Force-renew via UI MUST be enabled only when `status ∈ {failed, expired, rate_limited}` AND (`retry_after IS NULL` OR `retry_after < now()`).
- **FR-022**: The cert-expiry probe (defined in feature 006 FR-006a) MUST update `app_certs.expires_at` and `app_certs.last_renew_at` daily. The probe is the source of truth for `expires_at` AFTER first issuance — Caddy's `issued_at` is recorded once at issuance.

### Rate-limit guards

- **FR-023**: Before issuance, the dashboard MUST query `app_certs` for the count of rows in `(pending, failed, active)` status with the same effective registered domain (`*.foo.example.com → foo.example.com`) over the last 7 days. If count ≥ 5, issuance MUST block with "Let's Encrypt rate limit: 5 issuances per registered domain per week. Next slot estimated {timestamp}".
- **FR-024**: Effective registered domain calculation MUST use a public-suffix list lookup (Mozilla PSL — bundled or fetched). Caching: lookup is in-memory, refreshed on restart. Subdomain stripping examples: `foo.example.com → example.com`, `foo.bar.co.uk → bar.co.uk`.

### Settings UI

- **FR-025**: A "TLS / ACME" section in Settings MUST expose: `acme_email` (text input, validated as email regex `^\S+@\S+\.\S+$`), `caddy_admin_endpoint` (read-only display, defaults to `localhost:2019`), and a "Test Caddy connectivity" button that pings `/config/` and reports success/failure.

### Audit

- **FR-026**: Every cert-state transition (`pending → active`, `active → expired`, etc.) MUST be logged to `app_cert_events` with the actor (`system` for auto-renewal, `<userId>` for operator-triggered).
- **FR-027**: The "Hard delete app" action MUST require typing the app name in a confirmation dialog. Confirmation must be enforced server-side (don't trust the client) — the API MUST reject the destructive action without a matching `confirm_name` payload field.

### Safety

- **FR-028**: Caddy admin API endpoint MUST NEVER be exposed on a public interface. The `setup-vps.sh` Caddy install MUST bind admin API to `127.0.0.1:2019` only. UFW rule MUST NOT open 2019.
- **FR-029**: ACME account private keys MUST live on the target server only (Caddy storage at `/var/lib/caddy`). Dashboard MUST NOT copy them, MUST NOT log them, MUST NOT include them in error messages.
- **FR-030**: Domain input MUST be validated against a permissive but bounded regex (`^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$`, lowercase only). Wildcards (`*.`) explicitly rejected (caught by leading-char rule).

## Success Criteria

- **SC-001**: An operator who has just deployed an app via feature 009 can reach it over HTTPS at a chosen domain in ≤ 90 seconds end-to-end (form submit → DNS pre-check → Caddy reconcile → ACME challenge → cert installed).
- **SC-002**: Cert renewal failures (rate-limit, DNS broken, Caddy down) trigger Telegram within 24 hours of detection (probe runs daily; alert at first window crossed).
- **SC-003**: Zero certs silently expire in production over 30 days post-rollout (validated by inspecting `app_certs.expires_at < now()` and confirming each was alerted on).
- **SC-004**: Domain change preserves rollback: an operator who changes domain X→Y and then changes back X within 7 days has their original X cert un-orphaned and re-active without re-issuance (no new ACME request, no rate-limit slot consumed).
- **SC-005**: Hard-delete of an app removes ALL server-side state for it: no Caddy site, no cert files, no orphaned A-records-pointing-at-us — verifiable by SSH grep on `/var/lib/caddy` and `nginx -T` showing no match.
- **SC-006**: 100% of issuance attempts that fail due to "DNS not pointed" are caught by the pre-check warning before burning a Let's Encrypt rate-limit slot, validated by zero `failed` `app_certs` rows with `error_message LIKE '%DNS%'` in production for 30 days.

## Key Entities

### `applications` (modified — new columns)

- `domain TEXT NULL` — public domain, lowercase, no leading wildcard. UNIQUE where NOT NULL.
- `acme_email TEXT NULL` — per-app email override; NULL means use global setting.
- `proxy_type TEXT NOT NULL DEFAULT 'caddy'` — one of `caddy | nginx-legacy | none`.

### `app_certs` (new table)

One row per cert lifecycle (issuance, renewals, eventual orphan or revoke). See FR-004 for full schema.

### `app_cert_events` (new table)

Append-only event log for cert state transitions:

```
id TEXT PRIMARY KEY,
cert_id TEXT NOT NULL REFERENCES app_certs(id) ON DELETE CASCADE,
event_type TEXT NOT NULL,         -- 'issued' | 'renewed' | 'failed' | 'orphaned' | 'revoked' | 'rate_limited' | 'force_renew_requested'
event_data JSON NULL,             -- arbitrary payload (error message, retry_after, ACME response)
actor TEXT NOT NULL,              -- 'system' | userId
occurred_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
```

### `app_settings` (new or extended table)

Key-value store for global TLS settings. Adds key `acme_email`. If the table does not yet exist (verify against migrations), this feature introduces it with a minimal `(key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)` shape.

## Assumptions

- A-001: Managed-target servers run Linux with Docker. `setup-vps.sh` is the canonical installer; this feature extends it to install Caddy and run it in a `caddy` Docker network shared with managed apps.
- A-002: The dashboard has SSH access to all managed targets with NOPASSWD sudo (per CLAUDE.md / `setup-vps.sh:38`). SSH tunnels to Caddy admin API are within scope.
- A-003: Caddy version pinned at the **major.minor** level via Docker tag `caddy:2.7`. Patch updates (`2.7.x`) ride along automatically (security / bugfixes from upstream); minor bumps (`2.7 → 2.8`) require an explicit dashboard release with admin-API contract review. Caddy follows semver — minor bumps may shift admin-API config schema; patch bumps do not.
- A-004: One app row = one public domain. Multi-domain apps (apex + www) handled by Caddy's automatic domain-list expansion in v2; v1 supports a single domain per app.
- A-005: TLS only — HTTP-only apps are not a goal of this feature. An app with `domain` set is automatically HTTPS-with-redirect.
- A-006: The `notifier` from feature 006 is reused for cert alerts. Same Telegram bot, same chat id, new message types `cert-expiring`, `cert-issuance-failed`, `caddy-unreachable`.

## Dependencies

- **Feature 002 (gh-integration)**: shares the `app_settings` pattern if applicable.
- **Feature 005 (script runner)**: `setup-vps.sh` is dispatched via the script runner; this feature extends the manifest entry to optionally run the Caddy install step (`server/install-caddy.sh`).
- **Feature 006 (app-health-monitoring)**: cert-expiry probe is added there (FR-006a), updating `app_certs.expires_at`. Caddy reachability is added as a probe target (`probe_type = 'caddy_admin'`).
- **Feature 009 (bootstrap-deploy)**: when bootstrap creates a new app row, it MAY pass an initial domain → this feature handles the issuance flow.

## Out of Scope

- Wildcard certs / DNS-01 challenge (v2 — requires per-DNS-provider integration: Cloudflare API token, Route53 IAM, etc.).
- Multi-domain certs (apex + www, marketing domains pointing to same app) — v2.
- nginx-legacy migration UI (a "Migrate to Caddy" button) — separate feature, low priority.
- Custom CA / self-signed cert support beyond Caddy's automatic internal CA for `*.localhost` / IPs.
- TLS for the dashboard itself (already handled by external Caddy on dashboard host, per Spec 002 §184).
- Email notifications, webhook events for cert lifecycle (Telegram only in v1, mirrors feature 006 alert design).
- Visualisation of historical cert renewals beyond the event log table — no charts, no expiry forecast.

## Related

- Spec 006 `/specs/006-app-health-monitoring/spec.md`: adds the cert-expiry probe and Caddy admin probe.
- Spec 009 `/specs/009-bootstrap-deploy-from-repo/spec.md`: consumes domain attachment as part of first deploy.
- Existing `scripts/server/setup-vps.sh`: extended in this feature to install Caddy.
- Existing `scripts/server/setup-ssl.sh`: deprecated for new apps; remains operative for `proxy_type = 'nginx-legacy'`.
- CLAUDE.md rule 5 (no direct migrations): schema changes in FR-001..FR-005 ship as reviewable SQL files in `devops-app/server/db/migrations/`.

## Open Questions

_All initial open questions resolved in the 2026-04-28 clarifications session. New questions surfacing during plan/implementation phases will be added here._
