# API Contract: Application Domain & TLS

**Version**: 1.0 | **Date**: 2026-04-28

## Scope

Eight new HTTP endpoints, two new WebSocket event types, plus the Caddy admin API contract (which endpoints WE call on the target Caddy). Three existing endpoints (`POST /api/apps`, `PATCH /api/apps/:id`, `GET /api/apps/:id`) gain new optional fields (`domain`, `acmeEmail`, `proxyType`).

All endpoints under `/api`, all require `requireAuth`, all subject to `auditMiddleware`. New error codes: `DNS_NXDOMAIN`, `DNS_WARNING_REQUIRES_CONFIRM`, `ACME_EMAIL_REQUIRED`, `RATE_LIMIT_BLOCKED`, `CADDY_UNREACHABLE`, `CERT_NOT_FOUND`, `INVALID_DOMAIN`, `DOMAIN_IN_USE`, `HARD_DELETE_NAME_MISMATCH`, `WILDCARD_NOT_SUPPORTED`.

---

## New HTTP endpoints

### `PATCH /api/applications/:id/domain`

Set, change, or clear the domain for an application. Triggers DNS pre-check, Caddy reconcile, and (if domain is being set/changed) creation of a new `app_certs` row in `pending`. If a previous domain was set, the old cert moves to `orphaned` with `orphan_reason = 'domain_change'`.

**URL params**: `:id` — application UUID.

**Request body**:

```jsonc
{
  "domain": "foo.example.com",          // string | null — null clears the domain
  "acmeEmail": "ops@example.com",       // optional override; omit to inherit global
  "confirmDnsWarning": false,           // required true to proceed past DNS pre-check warnings
  "confirmCrossServer": false           // required true if the same domain exists on another server (FR-001a)
}
```

**Response 200** — domain set/changed successfully, reconcile dispatched:

```jsonc
{
  "applicationId": "app-123",
  "domain": "foo.example.com",
  "acmeEmail": "ops@example.com",
  "newCertId": "cert-456",              // null when domain was cleared
  "orphanedCertId": "cert-prev",        // null when no previous domain existed
  "reconcileDispatched": true
}
```

**Response 400 `INVALID_DOMAIN`** — failed `domainValidator`:

```json
{
  "error": {
    "code": "INVALID_DOMAIN",
    "message": "Domain failed validation",
    "details": { "fieldErrors": { "domain": ["Domain must be lowercase alphanumeric with hyphens, no wildcards"] } }
  }
}
```

**Response 400 `WILDCARD_NOT_SUPPORTED`**:

```json
{
  "error": {
    "code": "WILDCARD_NOT_SUPPORTED",
    "message": "Wildcard certs require DNS-01 challenge, not supported in v1",
    "details": { "fieldErrors": { "domain": ["Wildcards (*.) are not supported in v1"] } }
  }
}
```

**Response 400 `DNS_NXDOMAIN`** — pre-check found no DNS record:

```json
{
  "error": {
    "code": "DNS_NXDOMAIN",
    "message": "Domain has no DNS record",
    "details": { "domain": "foo.example.com", "resolvedIps": [] }
  }
}
```

**Response 409 `DNS_WARNING_REQUIRES_CONFIRM`** — pre-check found `mismatch` or `cloudflare`:

```jsonc
{
  "error": {
    "code": "DNS_WARNING_REQUIRES_CONFIRM",
    "message": "DNS pre-check warning",
    "details": {
      "kind": "cloudflare",                     // 'cloudflare' | 'mismatch'
      "resolvedIps": ["104.21.50.10"],
      "serverIp": "203.0.113.7",
      "cfRanges": ["104.16.0.0/13"],
      "remediation": "Disable Cloudflare orange cloud OR use DNS-01 challenge (v2)."
    }
  }
}
```

The client retries with `confirmDnsWarning: true` to proceed.

**Response 409 `DOMAIN_IN_USE`** — same-server unique constraint violated:

```json
{
  "error": {
    "code": "DOMAIN_IN_USE",
    "message": "Domain already used by another app on this server",
    "details": { "conflictingAppId": "app-789", "conflictingAppName": "bar" }
  }
}
```

**Response 409 `DOMAIN_CROSS_SERVER`** — FR-001a advisory; client retries with `confirmCrossServer: true`:

```jsonc
{
  "error": {
    "code": "DOMAIN_CROSS_SERVER",
    "message": "Domain already configured on another server",
    "details": {
      "otherServers": [
        { "serverId": "srv-2", "appId": "app-555", "appName": "foo-prod" }
      ],
      "remediation": "Confirm to proceed if you intentionally want HA / round-robin."
    }
  }
}
```

**Response 412 `ACME_EMAIL_REQUIRED`** — no per-app or global email set:

```json
{
  "error": {
    "code": "ACME_EMAIL_REQUIRED",
    "message": "Set ACME email in Settings before issuing certs",
    "details": { "settingsUrl": "/settings/tls" }
  }
}
```

**Response 429 `RATE_LIMIT_BLOCKED`**:

```jsonc
{
  "error": {
    "code": "RATE_LIMIT_BLOCKED",
    "message": "Let's Encrypt rate limit: 5 issuances per registered domain per week",
    "details": {
      "registeredDomain": "example.com",
      "count": 5,
      "nextSlotEstimate": "2026-05-05T12:00:00Z"
    }
  }
}
```

---

### `POST /api/applications/:id/certs/issue`

Explicit issuance trigger when no cert exists yet for the current domain (e.g. after a `domain_change` orphaned the old one and the operator wants to retry without changing the domain again). Idempotent — if a `pending` or `active` cert already exists for `(appId, domain)`, returns 409.

**Request body**: empty.

**Response 201**:

```jsonc
{
  "certId": "cert-789",
  "appId": "app-123",
  "domain": "foo.example.com",
  "status": "pending"
}
```

**Response 409 `CERT_ALREADY_EXISTS`** — there is already a non-orphaned cert for this app+domain:

```json
{
  "error": {
    "code": "CERT_ALREADY_EXISTS",
    "message": "Cert already exists for this domain",
    "details": { "certId": "cert-456", "status": "active" }
  }
}
```

**Response 400 `NO_DOMAIN_SET`** — application has no domain to issue against:

```json
{ "error": { "code": "NO_DOMAIN_SET", "message": "Application has no domain set" } }
```

Same `ACME_EMAIL_REQUIRED` / `RATE_LIMIT_BLOCKED` / `DNS_*` errors as `PATCH /domain`.

---

### `POST /api/applications/:id/certs/:certId/renew`

Force-renew a cert (FR-021). Enabled only when status is `failed`, `expired`, or `rate_limited` AND `retry_after` is in the past.

**Response 200**:

```jsonc
{
  "certId": "cert-456",
  "previousStatus": "failed",
  "status": "pending",
  "reconcileDispatched": true
}
```

**Response 409 `RENEW_NOT_ALLOWED`** — cert is in a state that disallows force-renew:

```json
{
  "error": {
    "code": "RENEW_NOT_ALLOWED",
    "message": "Cert cannot be force-renewed in current state",
    "details": { "currentStatus": "active", "allowedStates": ["failed", "expired", "rate_limited"] }
  }
}
```

**Response 409 `RETRY_AFTER_NOT_ELAPSED`** — rate-limited and `retry_after` is still in the future:

```json
{
  "error": {
    "code": "RETRY_AFTER_NOT_ELAPSED",
    "message": "Cert is rate-limited until 2026-05-05T12:00:00Z",
    "details": { "retryAfter": "2026-05-05T12:00:00Z" }
  }
}
```

---

### `POST /api/applications/:id/certs/:certId/revoke`

Explicit ACME-revoke a cert. Calls Caddy admin API `revokeCert` (R-005); transitions cert to `revoked`. Used during hard-delete (FR-018) and as a standalone operator action.

**Request body** (required for hard-delete path; ignored for standalone):

```jsonc
{
  "confirmName": "ai-digital-twins"     // must equal application.name (FR-027)
}
```

**Response 200**:

```jsonc
{
  "certId": "cert-456",
  "previousStatus": "active",
  "status": "revoked",
  "caddyRevokeOutcome": "success"
}
```

**Response 400 `HARD_DELETE_NAME_MISMATCH`** — typed-confirm validation failed:

```json
{
  "error": {
    "code": "HARD_DELETE_NAME_MISMATCH",
    "message": "Application name does not match confirmation",
    "details": { "expected": "ai-digital-twins", "got": "ai-twins" }
  }
}
```

**Response 502 `CADDY_UNREACHABLE`** — Caddy admin API failed during revoke:

```json
{
  "error": {
    "code": "CADDY_UNREACHABLE",
    "message": "Failed to reach Caddy admin API on target",
    "details": { "kind": "ssh", "cause": "Connection refused" }
  }
}
```

---

### `GET /api/applications/:id/certs`

List all `app_certs` rows for an application, including orphaned and revoked, with their event timeline.

**Query params**:

- `includeEvents` — `true | false` (default `false`); when true, embeds the last 50 events per cert.
- `status` — optional filter, repeatable.

**Response 200**:

```jsonc
{
  "certs": [
    {
      "id": "cert-456",
      "appId": "app-123",
      "domain": "foo.example.com",
      "issuer": "letsencrypt",
      "status": "active",
      "issuedAt": "2026-04-15T08:00:00Z",
      "expiresAt": "2026-07-14T08:00:00Z",
      "lastRenewAt": "2026-04-15T08:00:00Z",
      "lastRenewOutcome": "success",
      "errorMessage": null,
      "retryAfter": null,
      "orphanedAt": null,
      "orphanReason": "",
      "acmeAccountEmail": "ops@example.com",
      "createdAt": "2026-04-15T07:55:00Z",
      "events": [                          // present iff includeEvents=true
        { "id": "evt-1", "eventType": "issued", "occurredAt": "2026-04-15T08:00:00Z", "actor": "system", "eventData": null }
      ]
    }
  ]
}
```

---

### `GET /api/settings/tls`

Read global TLS settings.

**Response 200**:

```jsonc
{
  "acmeEmail": "ops@example.com",       // null when unset
  "caddyAdminEndpoint": "127.0.0.1:2019", // read-only display value
  "updatedAt": "2026-04-15T07:00:00Z"
}
```

---

### `PATCH /api/settings/tls`

Update global ACME email. Per R-011, this is forward-only — does NOT trigger re-registration of existing certs.

**Request body**:

```jsonc
{
  "acmeEmail": "ops@example.com"        // string | null — null clears
}
```

**Response 200**: same shape as GET.

**Response 400 `INVALID_EMAIL`**:

```json
{
  "error": {
    "code": "INVALID_EMAIL",
    "message": "ACME email failed validation",
    "details": { "fieldErrors": { "acmeEmail": ["Must be a valid email address"] } }
  }
}
```

---

### `POST /api/settings/tls/test-caddy`

Connectivity probe for FR-025 — pings each managed server's Caddy admin API and reports per-server status.

**Query params**: `serverId` — optional; when set, probes only that server. When omitted, probes ALL managed servers.

**Response 200**:

```jsonc
{
  "results": [
    {
      "serverId": "srv-1",
      "serverLabel": "prod-1",
      "outcome": "ok",                    // 'ok' | 'unreachable' | 'invalid_response'
      "latencyMs": 187,
      "caddyVersion": "2.7.6",            // populated when outcome=ok
      "errorMessage": null
    },
    {
      "serverId": "srv-2",
      "serverLabel": "prod-2",
      "outcome": "unreachable",
      "latencyMs": null,
      "caddyVersion": null,
      "errorMessage": "SSH tunnel: Connection refused"
    }
  ]
}
```

---

## Modified endpoints

### `POST /api/apps` and `PATCH /api/apps/:id`

**Request body — new optional fields**:

```jsonc
{
  // ... existing fields ...
  "domain": "foo.example.com",       // string | null | undefined; rejected if invalid; uniqueness checked per-server
  "acmeEmail": "ops@example.com",    // string | null | undefined; standard email regex
  "proxyType": "caddy"               // 'caddy' | 'nginx-legacy' | 'none'; default 'caddy'
}
```

**Behaviour notes**:

- Setting `domain` here triggers the same DNS pre-check + reconcile flow as `PATCH /domain`. The reason `PATCH /domain` exists as a separate endpoint is to keep the domain-set workflow distinct in the audit log (FR-026) and to provide a clean place for the `confirmDnsWarning` / `confirmCrossServer` flow that `POST /apps` would otherwise overload.
- When the operator wants atomic "create app + set domain", the recommended client flow is `POST /apps` (without domain) → wait for response → `PATCH /domain`.
- Both endpoints emit the same `INVALID_DOMAIN`, `WILDCARD_NOT_SUPPORTED`, `DOMAIN_IN_USE` errors as the dedicated `PATCH /domain`.

### `GET /api/apps/:id`, `GET /api/apps`

Response shape gains the three new fields. Always present (even when null) for consistent client branching.

---

## WebSocket events

### `cert.state-changed`

Fires after every cert state transition. Subscribed by the app-detail UI for live cert-status updates.

```jsonc
{
  "type": "cert.state-changed",
  "payload": {
    "certId": "cert-456",
    "appId": "app-123",
    "domain": "foo.example.com",
    "previousStatus": "pending",
    "status": "active",
    "expiresAt": "2026-07-14T08:00:00Z",
    "errorMessage": null,
    "actor": "system",
    "occurredAt": "2026-04-15T08:00:00Z"
  }
}
```

### `caddy.unreachable`

Fires once per server per "unreachable" transition (debounced via in-memory state in the reconciler). Pairs with the standard `caddy_admin` health probe from feature 006 FR-006b.

```jsonc
{
  "type": "caddy.unreachable",
  "payload": {
    "serverId": "srv-1",
    "serverLabel": "prod-1",
    "lastReachableAt": "2026-04-28T11:00:00Z",
    "errorKind": "ssh",
    "errorMessage": "Connection refused"
  }
}
```

A subsequent `caddy.reachable` event (recovery) is NOT a separate WS event in v1 — the standard `health.changed` from feature 006 covers that path.

---

## Caddy admin API contract (outbound — what WE call on the target)

The dashboard calls Caddy's admin API at `127.0.0.1:2019` over the SSH tunnel established per R-001. These are NOT our endpoints; they're Caddy's, listed here for clarity on what the integration depends on.

### `POST /load`

Idempotent full-config replace. Caddy diffs server-side and reloads only what changed.

**Body**: full Caddy JSON config built by `caddyConfigBuilder`.

**Example body** (one app, one domain, automatic TLS):

```json
{
  "admin": { "listen": "127.0.0.1:2019" },
  "apps": {
    "http": {
      "servers": {
        "srv0": {
          "listen": [":80", ":443"],
          "routes": [
            {
              "match": [{ "host": ["foo.example.com"] }],
              "handle": [
                {
                  "handler": "reverse_proxy",
                  "upstreams": [{ "dial": "ai-twins-app-1:3000" }]
                }
              ],
              "terminal": true
            }
          ]
        }
      }
    },
    "tls": {
      "automation": {
        "policies": [
          {
            "subjects": ["foo.example.com"],
            "issuers": [
              { "module": "acme", "email": "ops@example.com" }
            ]
          }
        ]
      }
    }
  }
}
```

Response 200 → success. Caddy's response body is empty on success.

### `GET /config/`

Read current Caddy config — used by the drift-detection cron and the FR-025 connectivity probe.

Response 200 → JSON config (same shape as `POST /load` body).

### `POST /pki/ca/local/...` / `POST /load/apps/tls/...`

Cert revocation. Exact Caddy admin path varies by version; the wrapper `caddyAdminClient.revokeCert(serverId, identifier)` encapsulates the version-specific path. v1 targets `caddy:2.7` whose revoke endpoint is documented at `https://caddyserver.com/docs/api#post-stoprevocation`.

---

## Wire format (camelCase / snake_case mapping)

All API fields use **camelCase**. DB columns use **snake_case** per existing convention. The route handler performs the conversion. Per-field mapping for new fields:

| Layer                | Name                                           |
|----------------------|------------------------------------------------|
| DB column            | `applications.domain`                          |
| Drizzle schema field | `applications.domain`                          |
| API request/response | `domain`                                       |
| DB column            | `applications.acme_email`                      |
| API field            | `acmeEmail`                                    |
| DB column            | `applications.proxy_type`                      |
| API field            | `proxyType`                                    |
| DB column            | `app_certs.expires_at`                         |
| API field            | `expiresAt`                                    |
| DB column            | `app_certs.orphan_reason`                      |
| API field            | `orphanReason`                                 |

---

## Failure modes — table

| Path                                  | Scenario                                       | HTTP    | Code                            | Notes |
|---------------------------------------|------------------------------------------------|---------|----------------------------------|-------|
| `PATCH /domain`                       | Invalid domain regex                           | 400     | `INVALID_DOMAIN`                |       |
| `PATCH /domain`                       | Wildcard input                                 | 400     | `WILDCARD_NOT_SUPPORTED`        |       |
| `PATCH /domain`                       | NXDOMAIN at pre-check                          | 400     | `DNS_NXDOMAIN`                  | Hard block, no override. |
| `PATCH /domain`                       | Cloudflare / mismatch at pre-check             | 409     | `DNS_WARNING_REQUIRES_CONFIRM`  | Retry with `confirmDnsWarning: true`. |
| `PATCH /domain`                       | Same domain on same server                     | 409     | `DOMAIN_IN_USE`                 | Hard block — UNIQUE index violation. |
| `PATCH /domain`                       | Same domain on other server                    | 409     | `DOMAIN_CROSS_SERVER`           | Retry with `confirmCrossServer: true`. |
| `PATCH /domain` / `POST /issue`       | No ACME email                                  | 412     | `ACME_EMAIL_REQUIRED`           | Pre-condition failed. |
| `PATCH /domain` / `POST /issue`       | LE rate limit                                  | 429     | `RATE_LIMIT_BLOCKED`            | Local rolling counter (R-007). |
| `POST /issue`                         | App has no domain                              | 400     | `NO_DOMAIN_SET`                 |       |
| `POST /issue`                         | Cert already exists                            | 409     | `CERT_ALREADY_EXISTS`           |       |
| `POST /renew`                         | Cert in disallowed state                       | 409     | `RENEW_NOT_ALLOWED`             |       |
| `POST /renew`                         | retry_after future                             | 409     | `RETRY_AFTER_NOT_ELAPSED`       |       |
| `POST /revoke` (hard-delete)          | Confirm name mismatch                          | 400     | `HARD_DELETE_NAME_MISMATCH`     |       |
| `POST /revoke`                        | Caddy admin API down                           | 502     | `CADDY_UNREACHABLE`             | Cert stays at previous status. |
| Any                                   | Cert ID not on this app                        | 404     | `CERT_NOT_FOUND`                |       |
| `PATCH /api/settings/tls`             | Bad email                                      | 400     | `INVALID_EMAIL`                 |       |

---

## Summary

- **8 new HTTP endpoints** (`/domain`, `/certs/issue`, `/certs/:id/renew`, `/certs/:id/revoke`, `/certs` (list), `/settings/tls` (GET, PATCH), `/settings/tls/test-caddy`).
- **2 new WS event types** (`cert.state-changed`, `caddy.unreachable`).
- **3 modified endpoints** (POST /apps, PATCH /apps, GET /apps[/:id]) — new optional fields.
- **10 new error codes** above.
- **3 outbound Caddy admin API endpoints** consumed (`POST /load`, `GET /config/`, `POST /pki/.../revoke`).

Three-layer validation: route handler `domainValidator` + Zod refine in manifest entries + DB CHECK constraint. Any bypass at one layer caught at the next.

Proceed to `quickstart.md`.
