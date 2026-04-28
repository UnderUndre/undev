# Research: Application Domain & TLS

**Phase 0 output** | **Date**: 2026-04-28

---

## R-001: SSH tunnel lifetime to Caddy admin API

**Decision**: Per-request `ssh2` `forwardOut` over the existing long-lived `sshPool` connection. No dedicated long-lived port forward.

The Caddy admin API at `127.0.0.1:2019` on each managed target is reached from the dashboard via the same SSH connection that already serves `exec`, `execStream`, and `executeWithStdin` (feature 005). The `ssh2` library exposes `client.forwardOut(srcAddr, srcPort, dstAddr, dstPort, callback)` which opens a new SSH channel for each forward. We open a fresh channel per HTTP request, write the HTTP request bytes via Node's built-in `http.request({ createConnection })` hook, read the response, close the channel.

**Rationale**: Caddy admin API call volume is bounded — at most one request per 5 minutes per server (drift cron) plus on-write triggers (typically a handful per day). A dedicated long-lived port forward would burn one TCP socket and one ssh channel per managed server for ~99.99% idle time. Per-request forward adds ~50-100 ms of channel-open latency, negligible against Caddy's ~200-500 ms `/load` execution time.

**Alternatives considered**:

- **Long-lived `client.forwardIn` with a local listener**: simpler to plug into Node `http`, but burns FDs even when idle. Reconnection on dropped tunnels adds complexity that the existing `sshPool` already solves for `exec`-class operations.
- **Run Caddy admin API on a public port with mTLS**: surface area too wide; FR-028 hard-bans 2019 from public exposure. mTLS would also require shipping client certs to the dashboard — another secret to rotate.
- **HTTP over Unix socket**: Caddy supports `--admin unix://path` since 2.5; could bind admin to a Unix socket on the target and then forward via SSH `tcpip-forward` of that socket. Gains nothing over `127.0.0.1:2019` and adds one extra Caddy CLI flag operators must remember.

---

## R-002: Caddy config representation in DB

**Decision**: NOT persisted in the DB. Always derived on demand from `applications` rows + `app_settings` via `caddyConfigBuilder`.

The Caddy config JSON is the function `(server, apps[]) → CaddyConfig`. The dashboard DB is the source of truth for the inputs (domain, upstream, ACME email); Caddy is the derivative. Drift detection compares DB-derived desired against `GET /config/` actual.

**Rationale**:

- **Single source of truth**: persisting the config blob creates a sync problem (which is canonical, the blob or the derivation?). When operator edits domain via PATCH, we'd have to either rebuild the blob and write it twice or trust the blob and skip the rebuild — either way the derivation function becomes the authoritative path eventually, so persisting is dead weight.
- **Schema simplicity**: no `caddy_configs` table, no version column, no migrations when Caddy's config schema evolves between minor versions.
- **Test surface**: pure function = pure unit tests with snapshot fixtures. DB-roundtrip for Caddy config is unnecessary I/O during tests.

**Alternatives considered**:

- **Store full config JSON per server in `servers.caddy_config`**: useful for "preview before apply" UX, but that's not in scope per spec § Out of Scope. Defer to v2 if a "preview" feature ever ships.
- **Store partial diffs in an event log**: over-engineered; Caddy already does the diff server-side via `/load`.

---

## R-003: Cloudflare CIDR refresh strategy

**Decision**: Boot-time fetch from `https://www.cloudflare.com/ips-v4/` and `/ips-v6/`, fallback to a hardcoded snapshot baked into source. Cached in memory, no disk persistence.

```ts
// devops-app/server/lib/cloudflare-cidrs.ts
const HARDCODED_FALLBACK_V4 = [
  "173.245.48.0/20", "103.21.244.0/22", /* ... ~15 ranges as of 2026-04 ... */
];
const HARDCODED_FALLBACK_V6 = [
  "2400:cb00::/32", "2606:4700::/32", /* ... */
];

let cached: { v4: string[]; v6: string[] } | null = null;

export async function getCloudflareCidrs(): Promise<{ v4: string[]; v6: string[] }> {
  if (cached) return cached;
  try {
    const [v4, v6] = await Promise.all([
      fetch('https://www.cloudflare.com/ips-v4/').then(r => r.text()),
      fetch('https://www.cloudflare.com/ips-v6/').then(r => r.text()),
    ]);
    cached = {
      v4: v4.split('\n').filter(line => /^\d/.test(line)),
      v6: v6.split('\n').filter(line => /^[0-9a-f:]/i.test(line)),
    };
  } catch {
    cached = { v4: HARDCODED_FALLBACK_V4, v6: HARDCODED_FALLBACK_V6 };
  }
  return cached;
}
```

**Rationale**:

- Cloudflare publishes the list as a public, no-auth, plain-text endpoint — designed for exactly this kind of consumption.
- The list changes ~1-2 times per year; staleness of 6 months degrades the FR-013 `cloudflare` warning to a `mismatch` warning (still actionable, just wrong category). Not catastrophic.
- Boot fetch covers most operators (dashboards restart for any redeploy or container reload).
- Hardcoded fallback ensures tests can run offline and dashboards behind air-gapped networks still classify the bulk of CF traffic.

**Alternatives considered**:

- **Daily background refresh**: more complex, unnecessary given the boot-fetch already covers 99%+ of operator restart cadence.
- **Shipping a regularly-updated cidr list as a separate package on npm**: external dependency just for ~30 lines of CIDRs that change semi-annually.
- **Skip CF detection entirely**: FR-013 explicitly requires it.

---

## R-004: Public Suffix List dependency

**Decision**: Bundle a Mozilla PSL snapshot as JSON in `devops-app/server/lib/psl-snapshot.json` (~200KB). Refreshed manually on each dashboard release. NO runtime fetch, NO npm dependency.

The PSL parser is a 50-line in-house function that reads the snapshot JSON and walks the suffix tree by domain labels.

```ts
// devops-app/server/lib/psl.ts
import psl from './psl-snapshot.json' assert { type: 'json' };

export function getRegisteredDomain(domain: string): string {
  const labels = domain.toLowerCase().split('.');
  // Walk from longest suffix to shortest, find longest match in PSL.
  // 'foo.bar.co.uk' → check 'foo.bar.co.uk', 'bar.co.uk', 'co.uk' against PSL → 'co.uk' is a suffix.
  // Registered domain = label-before-suffix + suffix → 'bar.co.uk'.
  for (let i = 0; i < labels.length; i++) {
    const candidate = labels.slice(i).join('.');
    if (psl.suffixes[candidate]) {
      // found suffix at position i; registered = i-1 onwards
      return labels.slice(Math.max(0, i - 1)).join('.');
    }
  }
  // No PSL match → fall back to last two labels
  return labels.slice(-2).join('.');
}
```

**Rationale**:

- **Bundle is small** (200KB) compared to a typical Node container's 100MB+ baseline image. Negligible.
- **No runtime fetch** means rate-limit checks always work, even on first boot before any external connectivity.
- **No npm dep** because the available `psl` package on npm is a direct port of the same Mozilla list — bundling the data ourselves saves a transitive dependency tree we don't need.
- **Test isolation**: tests run with the snapshot, no mock setup, no flaky network.

The release-time refresh is a manual `curl https://publicsuffix.org/list/public_suffix_list.dat | node scripts/dev/build-psl-snapshot.js` step in the release runbook. Mistakes here are bounded — the regex check at FR-024 just becomes slightly conservative if the snapshot misses a recently-added registry suffix.

**Alternatives considered**:

- **`psl` npm package** (https://github.com/lupomontero/psl): introduces one more transitive dep tree to audit. The package itself is fine but our use case is read-only with a small surface, so bundling is simpler.
- **Runtime fetch on first rate-limit check**: latency on the first call (10s timeout); fragile when DNS to publicsuffix.org fails.
- **Skip PSL, just use last-two-labels**: breaks for `foo.bar.co.uk` (registered = `bar.co.uk`, not `co.uk`) — and `co.uk` IS a public suffix, so under-counting renders FR-024's rate-limit guard fundamentally wrong.

---

## R-005: Cert revocation API path

**Decision**: Caddy admin API `POST /pki/ca/local/...` for our local Caddy CA, and Caddy's automation app's revoke endpoint for ACME-issued certs. NOT a direct ACME `revoke-cert` call against Let's Encrypt.

Caddy's admin API exposes cert revocation via PATCH `/config/apps/tls/automation/policies/<idx>/issuers/<idx>/...` plus the revoke endpoint specifically. Caddy then performs the actual ACME `revoke-cert` call on its side, using the ACME account key it holds.

**Rationale**:

- **ACME account key lives on target** (FR-029). Calling Let's Encrypt's `revoke-cert` directly from the dashboard would require copying the account key — explicitly forbidden.
- **Caddy already has the relationship** with the ACME server, including any retry / rate-limit logic that the upstream library handles.
- **Symmetric with the rest of the integration**: we already use Caddy admin API for `/load`, so adding revoke through the same channel keeps the trust boundary at SSH-tunnel-to-localhost-2019.

**Alternatives considered**:

- **Direct ACME `revoke-cert` from the dashboard**: would need the account key on the dashboard (forbidden), or a wrapper that signs revoke requests on the target via SSH (re-implementing what Caddy already does).
- **Just delete the cert files and let Caddy re-issue**: leaves the cert valid at Let's Encrypt's CT log until natural expiry; FR-018 explicitly says "ACME-revoke" for hard-delete.

---

## R-006: Domain validation regex sourcing

**Decision**: Permissive but bounded RFC-1035-light regex: `^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$`. Lowercase only. Wildcards (`*.`) rejected by the leading-character rule.

This is per FR-030 verbatim. The regex enforces:

- Each label starts and ends with alphanumeric.
- Hyphens allowed inside labels but not at the boundaries.
- Each label between 1 and 63 chars.
- At least one dot (= no bare `localhost` or `internal`).
- No uppercase (we lowercase before the check; mixed-case input is rejected).
- No underscores (legal in some DNS records but not in HTTPS hosts).
- No wildcards (`*.foo.com` fails because `*` is not in the `[a-z0-9]` set).

**Rationale**: RFC-1035 strict is more permissive than what HTTPS hosts allow in practice. Our regex matches what a real-world cert can actually be issued for. Idiosyncratic but valid hostnames (uppercase, underscores) are rare; the failure mode is easy to explain ("lowercase letters and digits only").

**Alternatives considered**:

- **`is-fqdn` npm package**: uses a similar regex but adds a dep for ~50 lines of code.
- **Strict RFC-1035**: allows leading-digit labels (`1foo.com`) which our regex also allows; allows uppercase; doesn't reject wildcards. Wrong shape for our use case.
- **Defer to Caddy's own validation**: Caddy WILL reject a malformed domain at `/load` time, but the failure surfaces as a 400 from the admin API after we've already committed to the workflow. Front-loading validation gives a better operator experience.

---

## R-007: Rate-limit window calculation

**Decision**: Sliding 7-day window over local `app_certs` rows (statuses `pending`, `active`, `failed`), grouped by registered domain via PSL lookup. NO query against Let's Encrypt's API.

```sql
SELECT COUNT(*) FROM app_certs
WHERE status IN ('pending', 'active', 'failed')
  AND created_at::timestamptz > NOW() - INTERVAL '7 days'
  AND (domain = $1 OR domain LIKE '%.' || $1);
```

**Rationale**:

- Let's Encrypt's actual rate-limit endpoint is `https://acme-v02.api.letsencrypt.org/directory/...` and exposes slot information only via response headers on the next attempt — there's no public "how many slots have I used?" endpoint. So we cannot ASK; we can only infer.
- The local DB count is **conservative**: every cert row counts, even `failed` ones (correct — Let's Encrypt counts failed validations toward the rate limit too). We may block at 5 when LE has more slots open if rows were deleted manually, but we never under-block.
- The rolling 7-day window matches LE's published policy (5 cert issuances per registered domain per week).

**Alternatives considered**:

- **Sliding 168-hour window with second-precision**: adds query cost without benefit. 7-day at midnight boundaries vs sliding-second is operationally equivalent for this guard.
- **Per-request HEAD to Let's Encrypt**: introduces external dependency on every issue attempt; some LE response headers do convey rate-limit info but not deterministically.
- **Hardcode 5/week without DB query**: ignores existing pending issuances that haven't completed yet; allows blast attempts.

---

## R-008: nginx-legacy detection on existing servers

**Decision**: Auto-detect via SSH file probe at first reconciler tick post-feature-rollout. Cache result in memory only; no schema change.

The reconciler runs per server. On its first run for a given server (per-process bootup), it shells `ssh server "test -d /etc/nginx/sites-enabled && nginx -T 2>/dev/null | grep -E 'server_name.*\.'"` to check whether nginx is actively serving any vhost matching a managed app's name pattern.

Logic:

```ts
async function detectNginxLegacy(serverId: string): Promise<{ apps: string[] }> {
  const out = await sshPool.exec(serverId, 'nginx -T 2>/dev/null | grep -E "^[[:space:]]*server_name " || true');
  // Parse "server_name foo.example.com bar.example.com;" lines, return all host names found.
  const hosts = parseServerNames(out.stdout);
  // Match against applications.name patterns or known prefixes.
  return { apps: matchHostsToApps(hosts, await fetchAppsForServer(serverId)) };
}
```

For matched apps, the reconciler calls `db.update(applications).set({ proxy_type: 'nginx-legacy' }).where(eq(applications.id, app.id))`. From that point forward the reconciler skips those apps (FR-011).

**Rationale**:

- **No DB column for "did we probe yet"** — we trust the migration's default of `'caddy'` plus the in-memory probe to settle within minutes of dashboard restart.
- **One-shot per server-process**: the probe is cheap (sub-second SSH exec); running it once per dashboard boot is fine.
- **Self-healing**: if the probe misses a vhost (operator added a new nginx site between detections), the next 5-minute reconciler tick re-probes if the in-memory cache is stale (TTL 1 hour).

**Alternatives considered**:

- **Operator-provided `proxy_type` field at app creation**: requires the operator to know what their server has, which is the entire problem this probe is solving.
- **Shell out to a dedicated bash script**: same data, more files. The SSH `exec` is sufficient.
- **Persist probe result in DB**: useful if we want history, but for v1 the in-memory cache is enough; persistence can be added trivially later.

---

## R-009: Migration strategy for `applications.proxy_type` backfill

**Decision**: Default `'caddy'` for every existing row at migration time. Per-app correction to `'nginx-legacy'` happens at first reconciler tick via R-008 probe. NO bulk SQL backfill in the migration file.

```sql
-- Migration 0007:
ALTER TABLE applications ADD COLUMN proxy_type TEXT NOT NULL DEFAULT 'caddy';
-- No backfill UPDATE — every existing row gets 'caddy' by default.
-- Reconciler probe (R-008) flips affected rows to 'nginx-legacy' post-restart.
```

**Rationale**:

- Migration runner has no SSH access — it cannot probe target servers. Therefore the migration cannot know which apps are actually nginx-fronted.
- Defaulting to `'caddy'` is the correct behaviour for new apps post-feature; for existing apps it's wrong **only for those with active nginx vhosts**, and the reconciler corrects those within minutes.
- The "wrong for a few minutes" window is harmless because the reconciler is idempotent and Caddy's `/load` for a domain with no upstream service simply 502s — no cert issuance attempt fires until the operator explicitly sets `domain` via the UI.

**Alternatives considered**:

- **Backfill query against all servers via SSH inside the migration runner**: violates the "migrations are reviewable SQL files" rule (CLAUDE.md rule 5).
- **Default `'none'` and require operator opt-in**: requires every operator to click through every app to change to `'caddy'` post-feature — friction without benefit since most operators want Caddy.
- **Two-step migration**: first add column nullable, then run a separate Node script to populate, then re-migrate to NOT NULL. Adds complexity for a problem the reconciler solves naturally.

---

## R-010: TLS handshake probe library

**Decision**: Node native `tls.connect({ servername, port: 443 })` plus `cert.valid_to` parsing. NO `openssl s_client` shellout.

```ts
import tls from 'node:tls';

async function probeCertExpiry(domain: string): Promise<{ expiresAt: Date } | { error: string }> {
  return new Promise((resolve) => {
    const socket = tls.connect({
      host: domain,
      port: 443,
      servername: domain,
      timeout: 8000,
    }, () => {
      const cert = socket.getPeerCertificate();
      socket.end();
      if (cert?.valid_to) resolve({ expiresAt: new Date(cert.valid_to) });
      else resolve({ error: 'No peer cert' });
    });
    socket.on('error', (err) => resolve({ error: err.message }));
    socket.on('timeout', () => { socket.destroy(); resolve({ error: 'Timeout' }); });
  });
}
```

**Rationale**:

- **Node TLS API gives us structured cert data** without parsing PEM strings.
- **No external binary dependency** on target or dashboard hosts. The `cert_expiry` probe runs from the dashboard against the public domain (per spec 006 FR-006a "via TLS handshake"), so dashboard side has Node and that's enough.
- **Cross-platform**: works the same on Linux dashboard hosts, dev macOS laptops, and CI runners. `openssl s_client` differs in flags between LibreSSL (macOS default) and OpenSSL (Linux default).

**Alternatives considered**:

- **`openssl s_client -connect <domain>:443`** (mentioned in spec 006 FR-006a): the spec snippet is illustrative; the actual implementation can use whatever produces the same `notAfter` value. Native TLS is cleaner.
- **`@peculiar/x509` parser**: fine library but adds a dep for what `getPeerCertificate()` already returns structured.

---

## R-011: ACME account email lifecycle on global-key change

**Decision**: Operator changing the global ACME email does NOT trigger automatic re-registration of existing certs. New cert issuances after the change use the new email; existing certs continue auto-renewing under their original ACME account.

Per the spec § Edge Cases ("Operator deletes the global ACME email"): existing certs continue auto-renewing under their saved per-app email or the previously-registered ACME account. New issuance blocks until a global or per-app email is set. Symmetrically, **changing** the global email is a forward-only operation — it affects the next new issuance, not existing renewals.

**Rationale**:

- Caddy stores ACME account state in `/data/caddy/acme/...` keyed by ACME directory URL. The account is bound to its email at registration. Changing the email globally without reaching into Caddy's storage to deregister-and-reregister would be a no-op for renewals.
- Re-registering existing accounts on every email change risks burning ACME registration rate limits (Let's Encrypt accounts per IP: 10/3h, certs per registered domain: 5/week — a re-register could cascade into the latter via certbot semantics).
- Operator who genuinely wants to migrate accounts can hard-delete + re-issue per cert, with explicit consent.

**Alternatives considered**:

- **Auto-trigger re-registration on email change**: invasive, surprising, no operator consent for what is effectively a destructive operation against ACME state.
- **Block email change while certs exist**: too restrictive; the new email is correct for the next issuance even if existing certs keep their old email.

---

## R-012: Caddy upstream addressing

**Decision**: Use Docker DNS hostname `<compose-project>-<service>` (default Docker Compose v2 naming). NO host-port mappings.

Caddy joins the same `caddy` Docker network as managed apps. The reverse-proxy upstream is therefore resolvable by Docker's embedded DNS:

```json
{
  "handle": [
    {
      "handler": "reverse_proxy",
      "upstreams": [{ "dial": "ai-twins-app-1:3000" }]
    }
  ]
}
```

The upstream values come from `applications.upstream_service` (e.g. `app`) + `applications.upstream_port` (e.g. `3000`) — fields introduced in feature 009. The compose-project prefix is derived from `applications.remote_path` slug or `applications.name` slug (consistent with Docker Compose's default project naming).

**Rationale**:

- **No port conflicts**: apps don't expose `ports:` on the host; only the Caddy container does (80/443).
- **No firewall surface**: managed apps are reachable only through Caddy, never via direct `host:port` URLs.
- **Simpler reconciliation**: `compose-project-service` is a stable identifier the dashboard already knows from its compose-aware features (003 scan, 009 bootstrap).

**Alternatives considered**:

- **Bind apps to host ports, Caddy proxies to `127.0.0.1:<port>`**: requires Caddy to use host networking or a host-port forward — both complicate the simple "Caddy in caddy network" topology.
- **Use container IPs directly**: containers get new IPs on every restart; would require dynamic Caddy reconfiguration on every container event. Docker DNS solves this for free.

The fallback path described in spec § Clarifications "if `ports:` exists, the right-hand side (container port) is parsed as the upstream" handles the legacy case where a compose file still has `ports:` mappings — we still use Docker DNS for the host, but read the container-port from the compose file instead of from `applications.upstream_port`.

---

## Summary of Unknowns Resolved

| Topic                                        | Decision                                                                                       |
|----------------------------------------------|------------------------------------------------------------------------------------------------|
| Caddy admin API SSH tunnel                   | Per-request `forwardOut` over existing `sshPool` — low call volume, no FD pinning (R-001)      |
| Caddy config representation                  | Derived on demand by `caddyConfigBuilder`, never persisted (R-002)                             |
| Cloudflare CIDR list                         | Boot-time fetch + hardcoded fallback, in-memory cache (R-003)                                  |
| Public Suffix List                           | Bundled JSON snapshot, manual refresh per release (R-004)                                       |
| Cert revocation                              | Caddy admin API only — never direct ACME call (R-005)                                          |
| Domain validation regex                      | Permissive RFC-1035-light, lowercase, no wildcards (R-006)                                     |
| Rate-limit window                            | Local 7-day rolling on `app_certs` rows by registered domain (R-007)                           |
| nginx-legacy detection                       | First-tick SSH probe, in-memory cache, self-healing (R-008)                                    |
| Migration backfill                           | Default `'caddy'`, reconciler corrects `'nginx-legacy'` (R-009)                                |
| TLS handshake probe                          | Node native `tls.connect`, no openssl shellout (R-010)                                         |
| ACME account email change                    | Forward-only — affects next issuance, not existing renewals (R-011)                            |
| Caddy upstream addressing                    | Docker DNS service-name, never host port (R-012)                                               |
