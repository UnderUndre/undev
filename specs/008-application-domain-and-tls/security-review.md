# Feature 008 Security Review (T061)

**Date**: 2026-04-28 | **Reviewer**: security-auditor agent (autonomous, post-impl)

## Scope

Three-layer domain validation, Caddy admin-API exposure, ACME secret-handling, hard-delete enforcement, `pending_reconcile` distinction, cross-server advisory non-blocking, PSL data integrity.

## Checks

| # | Check | Result | Notes |
|---|---|---|---|
| 1 | `validateDomain` is single source of truth | ✅ PASS | Imported by `routes/apps.ts` (POST/PATCH), `routes/domain.ts` (PATCH /domain). DB CHECK constraint `applications_domain_format` mirrors the regex (defence-in-depth at the deepest layer). Client mirror in `client/lib/domain-validator.ts` with parity test (T014). |
| 2 | Caddy admin API loopback-only (FR-028) | ✅ PASS | `install-caddy.sh` binds Docker port mapping `127.0.0.1:2019:2019` only. UFW invariant check rejects any rule for port 2019. T070 pre-install conflict detection bails on existing listeners. |
| 3 | ACME private keys never read by dashboard (FR-029) | ✅ PASS | No code path under `devops-app/server/` reads `/var/lib/caddy/.../private`. Cert revocation goes through `caddyAdminClient.revokeCert` — Caddy-side operation; account key never traverses SSH back to dashboard. |
| 4 | `errorMessage` does not leak secrets | ✅ PASS | `CaddyAdminError.message` is sliced to first 256 chars in `routes/settings.ts /tls/test-caddy`; the response body's `errorMessage` field carries `${kind}: ${msg}` only. Logger redact list (`logger.ts`) covers `*.token`, `*.password`, `*.sshPrivateKey` — defence-in-depth. |
| 5 | Hard-delete server-side typed-confirm (FR-027) | ✅ PASS | `routes/certs.ts POST /revoke` requires `confirmName` matching `applications.name`. `routes/apps.ts DELETE /:id?hard=true` validates header `X-Confirm-Name` against the same. Mismatch → `400 HARD_DELETE_NAME_MISMATCH`. Direct API call without payload also rejected. |
| 6 | `pending_reconcile` distinct from `pending` (FR-009) | ✅ PASS | Status enum CHECK constraint includes both. Reconciler `CASE WHEN status='active' THEN 'active' ELSE 'pending_reconcile' END` preserves active certs and only marks transitional ones. UI `StatusPill` renders both with different colour classes. |
| 7 | Cross-server domain advisory non-blocking (FR-001a) | ✅ PASS | No DB constraint on `(domain)` alone. The partial UNIQUE index is `(server_id, domain) WHERE domain IS NOT NULL` — same-server only. `routes/domain.ts` issues an advisory check that returns `409 DOMAIN_CROSS_SERVER` only when `confirmCrossServer = false`. |
| 8 | PSL snapshot is data-only | ✅ PASS | `psl-snapshot.json` is a JSON map of suffixes; no executable code. Loaded via `import ... with { type: 'json' }`. Refreshed manually at release per release runbook (R-004). |

## Risks accepted

- **In-memory DNS recheck timer (T064)**: a dashboard restart mid-wait loses the recheck job. Cert stays in `pending` with `pending_dns_recheck_until` populated — the operator can re-submit via Force renew. v2 nicety: persist via a delayed-job queue.
- **Hard-delete CASCADE during soft delete**: the schema cascades `app_certs` on app row deletion. The plan's "soft delete keeps cert orphaned 30 days" semantics require a `applications.deleted_at` column to be added — out of scope for v1. Current behaviour: soft delete marks cert orphaned then DELETEs the app row (cascade-removes the cert). Documented as known v1 limitation in `routes/apps.ts` DELETE handler comment.
- **Caddy storage path assumptions**: orphan-cleanup `rm -rf /var/lib/caddy/.local/share/caddy/certificates/*/<domain>` assumes Caddy 2.7's filesystem layout. Stable across 2.7.x patch updates per Caddy semver policy. A minor bump (2.8) requires re-validation of the path glob.
- **PSL snapshot staleness**: missing a recently-added registry suffix renders the rate-limit guard slightly conservative — never under-blocks. Worst case: an operator with an unusual TLD gets a false `block` after 5 issuances, which they can clear by waiting 7 days.

## Test surface

- Unit tests cover every primitive (validator, PSL, ACME resolver, DNS pre-check, rate-limit guard, cert lifecycle SM, config builder, alerter, Caddy admin client).
- Integration smoke tests are DATABASE_URL-gated (run in CI / manual `npm run test:integration`).
- Migration verification (T006) asserts CHECK constraints exist + seed row landed.
- Drift-lock invariant verified by static source grep (T072).

## Outcome

**PASS** — feature 008 ships ready for staging walk-through (T063). No critical or high-severity findings. Three documented v1 limitations (in-memory recheck timer, soft-delete cascade, PSL staleness) are acceptable risks with documented v2 mitigations.
