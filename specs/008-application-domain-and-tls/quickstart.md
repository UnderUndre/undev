# Quickstart: Application Domain & TLS

**Date**: 2026-04-28

How to attach a domain to a managed app, watch Caddy issue a Let's Encrypt cert, and clean it up later.

---

## Prerequisites

Before any of the steps below work, the target server must have:

1. Caddy installed via the updated `setup-vps.sh` (Feature 008's install block).
2. SSH access from the dashboard with NOPASSWD sudo (existing requirement, per `setup-vps.sh:38`).
3. Caddy admin API bound to `127.0.0.1:2019` (the install script does this; verify with `ssh server "ss -tlnp | grep 2019"` — should show only the loopback bind).

If Caddy is missing — go to **Settings → Server → "Install Caddy"** which dispatches the `server-ops/install-caddy` manifest entry. Alternatively run `./scripts/server/setup-vps.sh` end-to-end on a fresh box.

---

## Step 1 — Set the global ACME email

Without an ACME email, Let's Encrypt won't issue any cert. The dashboard surfaces this as a hard block before any issuance attempt (FR-016).

**UI**: Sidebar → **Settings** → **TLS / ACME** section → **ACME email** field.

**API**:

```bash
curl -X PATCH https://dashboard/api/settings/tls \
  -H 'Content-Type: application/json' \
  -d '{"acmeEmail": "ops@example.com"}'
```

**DB state after**:

```sql
SELECT key, value FROM app_settings WHERE key = 'acme_email';
-- key       | value
-- acme_email | ops@example.com
```

The "Test Caddy connectivity" button (right-hand side of the same Settings section) pings `127.0.0.1:2019/config/` on each managed server via SSH tunnel. Green = ready to issue. Red = fix Caddy install before proceeding.

---

## Step 2 — Add a domain to an existing app

App is already deployed (e.g. via Feature 009 bootstrap or Feature 003 scan). Goal: make `foo.example.com` route to it over HTTPS.

**Pre-flight**: the domain's A-record (and AAAA if you have IPv6) must resolve to your server's public IP. Check with `dig +short foo.example.com` from your laptop. If it's not pointing yet, the dashboard's pre-check will warn before any ACME slot is consumed.

**UI**: App detail page → **Domain & TLS** section → **Add domain** button → enter `foo.example.com` → click **Apply**.

The dialog runs `dnsPrecheck` synchronously. Possible outcomes:

| DNS state                                | UI shows                                                                   | Action                                                           |
|------------------------------------------|----------------------------------------------------------------------------|------------------------------------------------------------------|
| A-record matches server                  | Green "DNS resolves correctly"                                             | Click **Apply** → proceeds without confirmation.                 |
| A-record points elsewhere                | Yellow warning "Domain X resolves to 1.2.3.4, server is 5.6.7.8"           | Tick **"Try anyway (DNS may be propagating)"** → click Apply.   |
| Cloudflare CIDR detected                 | Yellow warning "Looks like Cloudflare proxy; HTTP-01 may fail"             | Disable orange cloud OR tick "Try anyway".                       |
| NXDOMAIN                                 | Red error "No DNS record found"                                            | Hard block — fix DNS before retrying.                            |

**API** (with confirmation flag set):

```bash
curl -X PATCH https://dashboard/api/applications/app-123/domain \
  -H 'Content-Type: application/json' \
  -d '{"domain": "foo.example.com", "confirmDnsWarning": true}'
```

**Response** (HTTP 200):

```json
{
  "applicationId": "app-123",
  "domain": "foo.example.com",
  "newCertId": "cert-456",
  "orphanedCertId": null,
  "reconcileDispatched": true
}
```

**What happens server-side**:

1. Domain validated against the regex (FR-030).
2. DNS pre-check (`dns.resolve4/6` + Cloudflare CIDR check).
3. Cross-server collision check (FR-001a) — silent if no matches.
4. ACME email resolved (`applications.acme_email` → `app_settings.acme_email` → block).
5. Rate-limit guard queries `app_certs` for last 7 days by registered domain.
6. `applications.domain` UPDATEd; `app_certs` INSERTed with `status='pending'`.
7. `caddyReconciler.reconcile(serverId)` runs — builds full Caddy config, PUTs `/load` over SSH tunnel.
8. Caddy starts the ACME HTTP-01 challenge flow autonomously.
9. Within 30-60 seconds Caddy finishes; the dashboard's `cert_expiry` probe (feature 006) writes `expires_at` back at the next daily tick. For real-time feedback, Caddy's admin API events surface a `cert.state-changed` WS event when it transitions `pending → active`.

**DB state after** (assuming success):

```sql
SELECT id, domain, acme_email, proxy_type FROM applications WHERE id = 'app-123';
-- app-123 | foo.example.com | NULL | caddy

SELECT id, domain, status, issued_at, expires_at FROM app_certs WHERE app_id = 'app-123';
-- cert-456 | foo.example.com | active | 2026-04-28T12:00:00Z | 2026-07-27T12:00:00Z

SELECT event_type, actor, occurred_at FROM app_cert_events WHERE cert_id = 'cert-456' ORDER BY occurred_at;
-- force_renew_requested | <userId>  | 2026-04-28T11:59:00Z
-- issued                 | system    | 2026-04-28T12:00:00Z
```

---

## Step 3 — Watch the cert appear in app detail

The "Domain & TLS" section auto-refreshes via WS event `cert.state-changed`. After issuance:

- Domain row shows `foo.example.com` (clickable, opens `https://foo.example.com` in new tab).
- Issuer: `letsencrypt`.
- `Expires`: `Jul 27, 2026 (in 90 days)`.
- Status pill: green **active**.
- **Force renew** button: disabled (status is `active`, not `failed`/`expired`/`rate_limited`).
- **Change domain** button: enabled.
- **Revoke** button: enabled but typed-confirm protected.
- Below: "**Cert event timeline**" — `force_renew_requested → issued`, with timestamps + actor.

If issuance failed (rate-limit, validation error), the section instead shows yellow with the cert status + `error_message` + a **Force renew** button (enabled because status is `failed`).

---

## Step 4 — Change domain with grace period

Operator wants to migrate `foo` from `foo-staging.example.com` to `foo.example.com` without losing TLS at the staging URL during the cutover.

**UI**: App detail → Domain & TLS → **Change domain** button → enter new domain → click **Apply**.

**API**:

```bash
curl -X PATCH https://dashboard/api/applications/app-123/domain \
  -H 'Content-Type: application/json' \
  -d '{"domain": "foo.example.com", "confirmDnsWarning": false}'
```

**Server-side flow**:

1. The previous `app_certs` row (for `foo-staging.example.com`) UPDATEs:
   - `status: active → orphaned`
   - `orphaned_at: 2026-04-28T13:00:00Z`
   - `orphan_reason: 'domain_change'`
2. New `app_certs` row INSERTs for `foo.example.com` in `pending`.
3. `applications.domain` UPDATEs to `foo.example.com`.
4. `caddyReconciler` builds a config that serves BOTH domains during the grace period (per FR-017 — Caddy will keep the old cert valid until orphan cleanup deletes it after 7 days).
5. Caddy issues the new cert, transitions `pending → active`.

**DB state**:

```sql
SELECT id, domain, status, orphan_reason, orphaned_at FROM app_certs WHERE app_id = 'app-123' ORDER BY created_at;
-- cert-prev | foo-staging.example.com | orphaned | domain_change | 2026-04-28T13:00:00Z
-- cert-new  | foo.example.com         | active   | (empty)       | NULL
```

**UI shows** (top of the section): "Old domain `foo-staging.example.com` cert kept for rollback until **May 5, 2026**. **Click to revoke now.**"

If the operator decides to roll back within 7 days, changing the domain back to `foo-staging.example.com` un-orphans the original cert (the lifecycle helper recognises a re-attached domain and clears `orphaned_at` / `orphan_reason`, transitioning back to `active` if `expires_at` is still in the future). Per SC-004 — no new ACME request, no rate-limit slot consumed.

---

## Step 5 — Force renew when stuck

A cert that failed issuance (e.g. transient rate-limit, DNS hiccup) sits at `status='failed'` until either Caddy retries on its own (~10 min loop) or the operator force-renews.

**UI**: App detail → Domain & TLS → cert status row shows yellow with error message → **Force renew** button enabled.

**API**:

```bash
curl -X POST https://dashboard/api/applications/app-123/certs/cert-456/renew
```

**Response** (HTTP 200):

```json
{
  "certId": "cert-456",
  "previousStatus": "failed",
  "status": "pending",
  "reconcileDispatched": true
}
```

**Server-side flow**:

1. Validator checks status is `failed | expired | rate_limited` (FR-021). Returns `409 RENEW_NOT_ALLOWED` for any other state.
2. If status is `rate_limited`, checks `retry_after` is in the past — returns `409 RETRY_AFTER_NOT_ELAPSED` if not.
3. Cert UPDATEs to `pending`; event `force_renew_requested` written to `app_cert_events` with `actor: <userId>`.
4. Reconciler dispatched — calls Caddy admin API to retry issuance.
5. Caddy attempts ACME challenge; outcome flows back through `cert.state-changed` WS event.

If the underlying problem isn't fixed (e.g. DNS still wrong), the cert lands back in `failed` with a refreshed `error_message`. The operator iterates: fix the problem → **Force renew** again.

---

## Step 6 — Hard-delete cleanup wizard

Decommissioning an app for real — wants ALL server-side state removed (cert revoked, Caddy site removed, cert files deleted, app row gone). The default **Delete** is soft (keeps Caddy serving until orphan cleanup fires).

**UI**: App detail → ⋯ menu → **"Remove everything from server"** → opens `HardDeleteWizard`.

The wizard shows:

1. **Step 1: Confirmation** — type the app name (`ai-digital-twins`) into a text field. **Continue** button enables only when input matches `application.name` exactly.
2. **Step 2: Pre-flight checks** — runs four checks in parallel and shows green ticks:
   - Caddy reachable on target.
   - Cert exists and is in a revokable state.
   - SSH access works.
   - No active deploy lock.
3. **Step 3: Execute** — clicking **Remove** dispatches the four operations:
   - `POST /api/applications/:id/certs/:certId/revoke` with `confirmName` payload.
   - `caddyReconciler` removes the site from Caddy config (PUT /load with the site stripped).
   - SSH `rm -rf /var/lib/caddy/.local/share/caddy/certificates/.../foo.example.com` — best-effort; doesn't fail the workflow if files already gone.
   - `DELETE /api/apps/:id` — removes the app row (cascades `app_certs` and `app_cert_events`).
4. **Step 4: Verify** — wizard runs three readback checks:
   - `nginx -T && curl localhost:2019/config/` over SSH — confirms no Caddy site for the domain.
   - `find /var/lib/caddy -name '*foo.example.com*'` — confirms no cert files left.
   - DB `SELECT 1 FROM applications WHERE id = $1` — confirms row deleted.
5. **Step 5: Done** — green confirmation; redirects to Servers list.

**API call sequence** (the wizard issues these):

```bash
# 1. Revoke
curl -X POST https://dashboard/api/applications/app-123/certs/cert-456/revoke \
  -H 'Content-Type: application/json' \
  -d '{"confirmName": "ai-digital-twins"}'

# 2. Caddy site removal happens server-side as a side effect of the revoke (reconciler picks it up).

# 3. Cert file removal — internal, no public API.

# 4. App row deletion
curl -X DELETE https://dashboard/api/apps/app-123
```

**DB state after**: zero rows match the app id in `applications`, `app_certs`, `app_cert_events`. Audit log retains a `hard-delete` entry per FR-027.

If any step fails partway (e.g. Caddy revoke succeeded but cert file delete fails because SSH dropped), the wizard surfaces the failure and offers **Retry** — idempotent, picks up where it left off. Operator can also abort at any step; the system's state is consistent (every committed step left the system in a valid state).

---

## Cross-feature interactions

**With Feature 006 (health monitoring)**:

- Once a cert is `active`, Feature 006's daily `cert_expiry` probe (FR-006a) starts running for the domain. Updates `app_certs.expires_at` daily.
- Caddy reachability is monitored by Feature 006's `caddy_admin` probe (FR-006b) on the standard 60s cadence. Telegram alerts when Caddy goes unreachable (FR-015b). When Caddy is unreachable, this feature's reconciler marks affected certs `pending_reconcile` (FR-009) — surfaces in the cert event timeline.

**With Feature 009 (bootstrap)**:

- Feature 009's bootstrap wizard has an optional **Domain** field. If filled, after the bootstrap reaches `HEALTHCHECK` it dispatches this feature's domain-attachment flow (`PATCH /api/applications/:id/domain`) — same DNS pre-check, same reconcile, same ACME flow.
- If empty, bootstrap completes at `ACTIVE` without TLS. Operator can later **Add domain** via Step 2 above.

---

## Troubleshooting

**"My cert is stuck in `pending` for 30 minutes"** — Caddy's HTTP-01 challenge is failing. Check:

- DNS A-record points to your server (use `dig +short foo.example.com` from a third party, e.g. https://dnschecker.org).
- Port 80 is open on the firewall (`sudo ufw status`).
- No other service listening on port 80 (`sudo ss -tlnp | grep ':80 '` — should only show Caddy).
- Caddy logs: `ssh server "docker logs caddy --tail=50"`.

After fixing, click **Force renew** to retry without waiting for Caddy's next backoff window.

**"Hard delete left a Caddy site behind"** — the reconciler's POST /load may have been interrupted. Run `POST /api/settings/tls/test-caddy?serverId=<srv>` to confirm Caddy is reachable, then trigger any other domain change on the same server — the reconciler rebuilds desired state from the DB and PUTs it, which removes the orphan site.

**"Cert renewed but `expires_at` shows old date"** — Feature 006's `cert_expiry` probe runs once a day. Either wait 24h or trigger an out-of-cycle check via the cert detail's **Re-probe** button (which dispatches the probe immediately).

**"Telegram says 'Caddy unreachable' but the dashboard UI looks fine"** — the dashboard caches Caddy state for 5 minutes. The 5-min reconciler tick will show the right state on the next refresh. If it persists, restart the dashboard (`docker compose restart` on the dashboard host).

**"Two apps have the same domain on different servers — is that a bug?"** — No, intentional (FR-001a). Per spec, cross-server collision is an advisory warning, not a hard constraint, to support HA / round-robin deployments. The advisory check at write time gives the operator a chance to confirm "yes, this is HA, proceed".

---

## Constraints

- **HTTP-01 only in v1**. DNS-01 (required for wildcards and for domains behind Cloudflare orange-cloud) is out of scope.
- **One domain per app**. Multi-domain (apex + www) is v2 — Caddy supports it natively but our data model picks one per row.
- **Caddy `2.7` is the pinned version** (A-003). Patch updates ride along; minor bumps are deliberate dashboard releases with admin-API contract review.
- **ACME emails are public-key-binding metadata, not secrets** (RFC 8555). They appear in audit logs unredacted. Use a role mailbox if you don't want individual ops names visible.
- **The dashboard's own Caddy** (per Spec 002 §184) is NOT managed by this feature. It's external and self-managed; no reflection.
