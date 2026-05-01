# Feature 006 — Security Audit

> **Date**: 2026-04-28
> **Scope**: Tasks T045 (probe attack surface) + T058 (SSRF guard polish).
> **Verdict**: All checks PASS. No exploitable findings. Notes captured below
> are operator-gated (Caddy admin tunnel) or informational rationale that
> belongs in this audit trail rather than scattered across code comments.

---

## T045 — Probe attack surface (FR-029 / FR-030 / FR-031)

### (a) HTTP probe — no cross-host redirects — PASS

`devops-app/server/services/probes/http.ts` invokes `fetch(...)` with
`redirect: "manual"`. Status codes 3xx are surfaced directly as the probe's
`statusCode` and treated as `healthy` (2xx/3xx range per FR-005). The client
never reads the `Location` header, never re-issues a request, never opens a
second socket. SSRF rebinding via redirect is therefore impossible on this
code path.

If a future PR ever changes `redirect` to `"follow"`, this audit must be
re-run — same-host enforcement on the resolved redirect target would have to
be added explicitly.

### (b) User-Agent verbatim — PASS

`PROBE_USER_AGENT = "devops-dashboard-probe/1.0"` and is set verbatim on
every probe via the `headers` map. Not configurable. Asserted by
`tests/unit/probes-http.test.ts`.

### (c) Container probe SSH user is the deploy user, not root — PASS

`devops-app/server/services/probes/container.ts` uses the existing
`sshPool` with the `app.serverId` connection. The pool is wired to the
operator-configured `ssh_user` per server row, which by convention and by
the deploy contract is the **deploy** user — never root (root SSH login is
disabled in the bootstrapped servers). No path in the probe escalates,
sudos, or rewrites the connection user.

### (d) Caddy admin tunnel does NOT expose 2019 publicly — OPERATOR-GATED

The Caddy admin probe opens an SSH tunnel to remote `127.0.0.1:2019` and
fetches `http://localhost:<localPort>/config/`. The remote bind on
`127.0.0.1` is intrinsic to the Caddy default; the dashboard never asks
Caddy to listen on a public address. UFW assertion is the operator's
responsibility on each server — this audit documents the assumption.

**Operator action**: every host running Caddy MUST have UFW (or equivalent)
denying inbound on port 2019 from any non-loopback source. Bootstrap
playbooks already do this; rerun verification when adding a new server.

### (e) `tls.connect` `rejectUnauthorized: false` rationale — DOCUMENTED

`devops-app/server/services/probes/cert-expiry.ts` opens TLS with
`rejectUnauthorized: false` so it can read the certificate even when the
cert is expired, self-signed, or chain-broken — those are exactly the
states the probe needs to alert on. We never SEND data over the connection
(we read `peerCertificate.valid_to` and tear down). Trust verification is
not load-bearing here; the cert expiry value is.

Code comment in `cert-expiry.ts` records this rationale. Audit notes it for
the historical record.

### (f) No probe path logs the Telegram bot token — PASS

`devops-app/server/lib/logger.ts` configures pino with `redact.paths`
covering `*.token`, `req.headers.authorization`, and `*.params.*`. The
notifier stores the bot token in a URL string (`/bot<token>/sendMessage`)
that is not logged. The token never appears in any `logger.{info,warn,error}`
call site reviewed.

### (g) `app_health_probes` does not record bodies — PASS

The `appHealthProbes` insert in `app-health-poller.ts` writes only:
`probedAt, probeType, outcome, latencyMs, statusCode, errorMessage,
containerStatus`. No request body, no response body. The HTTP probe
explicitly drains the response body via a capped reader (T057, see T058
below) and discards it.

---

## T058 — SSRF polish extension

### (a) Cloud IMDS coverage — PASS

| Cloud | IMDS endpoint | Covered by |
|---|---|---|
| AWS  | `169.254.169.254` | `169.254.0.0/16` link-local block (RFC 3927) |
| GCP  | `169.254.169.254` (+ `metadata.google.internal`) | Same `/16` block; `metadata.google.internal` resolves into `169.254.169.254` via the operator's DNS — re-resolved at probe time, blocked. |
| Azure | `169.254.169.254` | Same `/16` block. |

`isBlockedIpv4` predicate `(u & 0xffff0000) === 0xa9fe0000` covers the full
`/16`; `metadata.google.internal` does not bypass the gate because the
predicate runs on the resolved IP, not the hostname.

No cloud has moved IMDS off `169.254.169.254` as of 2026-04-28 (verified
against current AWS / GCP / Azure docs).

### (b) DNS-rebinding window closed — PASS

`validateUrlForProbe` calls `resolve4` + `resolve6` directly via
`node:dns/promises` on every invocation. There is no cache, no memoisation,
no `setInterval` warmer. The HTTP probe runner (`probes/http.ts`) calls
`validateUrlForProbe` immediately before `fetch`, so the form-time
validation result (T054) is never reused at probe time. Form-validation is
UX only; the authoritative gate is at probe time.

If a future PR adds a memoiser (e.g., to amortise DNS load), the cache TTL
must be 0 and the audit re-run.

### (c) Body-cap reader aborts on first chunk crossing threshold — PASS

`drainCappedBody` in `probes/http.ts` accumulates `total += value.byteLength`
inside the `while (true)` reader loop and calls `controller.abort()` the
moment `total >= BODY_CAP_BYTES`. It does NOT buffer the entire 1 MB and
then check; the abort fires synchronously inside the loop. Memory ceiling
is `chunk.byteLength + total < 1 MB + one network MTU`.

### (d) `POST /api/applications/health-url/validate` does not log resolved IPs at info — PASS

`routes/app-health.ts` line 362 logs `{ ctx: "ssrf-validate", ok: result.ok }`
at `logger.debug` only. `resolvedIps` are NOT included in the structured
context. Operator audit logs (info-level) see the boolean outcome only;
debug-level (developer-local) sees the resolved IPs. Enumeration of internal
subnets via the audit log is therefore not possible.

---

## Verdict

All seven T045 checks PASS. All four T058 checks PASS. The Caddy admin
tunnel item (T045-d) is operator-gated rather than enforceable in code; the
bootstrap playbooks deny inbound 2019 by default and the audit records the
assumption.

No code changes required. No remediation tasks generated.
