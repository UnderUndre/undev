# Data Model: Application Health Monitoring & Post-Deploy Verification

**Phase 1 output** | **Date**: 2026-04-28

---

## New entity: `app_health_probes`

One row per probe execution (regardless of outcome). Container/HTTP/cert_expiry probes carry `app_id` non-null; `caddy_admin` probes carry `server_id` non-null with `app_id` NULL. Retention pruned by `HEALTH_PROBE_RETENTION_DAYS` (default 30).

```ts
interface AppHealthProbe {
  id: string;                                   // UUID PK
  appId: string | null;                         // FK → applications(id) ON DELETE CASCADE; NULL for caddy_admin probes
  serverId: string | null;                      // FK → servers(id)      ON DELETE CASCADE; non-NULL only for caddy_admin
  probedAt: string;                             // ISO 8601 (TEXT)
  probeType: "container" | "http" | "cert_expiry" | "caddy_admin";
  outcome: "healthy" | "unhealthy" | "warning" | "error";
  latencyMs: number | null;
  statusCode: number | null;                    // HTTP / caddy_admin only
  errorMessage: string | null;
  containerStatus: string | null;               // verbatim from `docker inspect ... .State.Health.Status`
}
```

### Lifecycle

```
(insert)                                            (no UPDATEs — append-only)
  outcome ∈ {healthy, unhealthy, warning, error}
  probedAt set on insert; row is immutable
  retention prune deletes WHERE probedAt < now - HEALTH_PROBE_RETENTION_DAYS
```

### Invariants

1. **`probedAt` monotonic per `(app_id, probe_type)`** — enforced by recursive setTimeout cadence; not a DB constraint.
2. **`outcome = "warning"` only valid for `probe_type = 'cert_expiry'`** (the 7d ≤ daysLeft ≤ 14d window per FR-006a). Container/HTTP probes never produce `warning`.
3. **`status_code` non-null requires `probe_type IN ('http', 'caddy_admin')`** — container/cert probes leave it NULL.
4. **XOR(app_id, server_id)**: every row has exactly one of `app_id` or `server_id` non-null. Enforced by CHECK constraint.

### DDL (migration `0007_app_health_monitoring.sql`)

Three changes in one migration (atomic): ALTER applications + CREATE table + indexes.

```sql
-- Feature 006: per-app health monitoring + cert/Caddy probes.
-- ADDITIVE migration: 8 new columns on applications + new app_health_probes table.
-- No backfill — health_status defaults to 'unknown', converges on first probe cycle.
--
-- DOWN migration (manual, operator-gated — destructive):
--   DROP TABLE "app_health_probes";
--   ALTER TABLE "applications" DROP COLUMN "alerts_muted",
--                              DROP COLUMN "monitoring_enabled",
--                              DROP COLUMN "health_debounce_count",
--                              DROP COLUMN "health_probe_interval_sec",
--                              DROP COLUMN "health_message",
--                              DROP COLUMN "health_last_change_at",
--                              DROP COLUMN "health_checked_at",
--                              DROP COLUMN "health_status",
--                              DROP COLUMN "health_url";

ALTER TABLE "applications"
  ADD COLUMN "health_url"                  TEXT,
  ADD COLUMN "health_status"               TEXT NOT NULL DEFAULT 'unknown',
  ADD COLUMN "health_checked_at"           TEXT,
  ADD COLUMN "health_last_change_at"       TEXT,
  ADD COLUMN "health_message"              TEXT,
  ADD COLUMN "health_probe_interval_sec"   INTEGER NOT NULL DEFAULT 60,
  ADD COLUMN "health_debounce_count"       INTEGER NOT NULL DEFAULT 2,
  ADD COLUMN "monitoring_enabled"          BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN "alerts_muted"                BOOLEAN NOT NULL DEFAULT FALSE;

-- FR-002 lower bound 10s; FR-007 minimum debounce 1.
ALTER TABLE "applications" ADD CONSTRAINT "applications_health_probe_interval_min"
  CHECK ("health_probe_interval_sec" >= 10);
ALTER TABLE "applications" ADD CONSTRAINT "applications_health_debounce_min"
  CHECK ("health_debounce_count" >= 1);

CREATE TABLE "app_health_probes" (
  "id"                TEXT PRIMARY KEY,
  "app_id"            TEXT REFERENCES "applications"("id") ON DELETE CASCADE,
  "server_id"         TEXT REFERENCES "servers"("id")      ON DELETE CASCADE,
  "probed_at"         TEXT NOT NULL,
  "probe_type"        TEXT NOT NULL,                  -- container | http | cert_expiry | caddy_admin
  "outcome"           TEXT NOT NULL,                  -- healthy | unhealthy | warning | error
  "latency_ms"        INTEGER,
  "status_code"       INTEGER,
  "error_message"     TEXT,
  "container_status"  TEXT,
  CONSTRAINT "app_health_probes_subject_xor"
    CHECK ((app_id IS NOT NULL AND server_id IS NULL) OR
           (app_id IS NULL AND server_id IS NOT NULL))
);

CREATE INDEX "idx_app_health_probes_app_probed"
  ON "app_health_probes" ("app_id", "probed_at" DESC);
CREATE INDEX "idx_app_health_probes_server_probed"
  ON "app_health_probes" ("server_id", "probed_at" DESC);
CREATE INDEX "idx_app_health_probes_app_type_outcome"
  ON "app_health_probes" ("app_id", "probe_type", "outcome");
CREATE INDEX "idx_app_health_probes_probed"
  ON "app_health_probes" ("probed_at" DESC);
```

The four indexes support the four UI / runner query shapes:

- App detail sparkline (last 24h ordered by time) → `idx_app_health_probes_app_probed`
- Server-scoped Caddy history → `idx_app_health_probes_server_probed`
- Status filtering ("show only failing container probes for app X") → `idx_app_health_probes_app_type_outcome`
- Retention prune (delete by age) → `idx_app_health_probes_probed`

### Drizzle schema fragment

Added to `devops-app/server/db/schema.ts`:

```ts
export const appHealthProbes = pgTable(
  "app_health_probes",
  {
    id: text("id").primaryKey(),
    appId: text("app_id").references(() => applications.id, { onDelete: "cascade" }),
    serverId: text("server_id").references(() => servers.id, { onDelete: "cascade" }),
    probedAt: text("probed_at").notNull(),
    probeType: text("probe_type").notNull(),     // 'container' | 'http' | 'cert_expiry' | 'caddy_admin'
    outcome: text("outcome").notNull(),          // 'healthy' | 'unhealthy' | 'warning' | 'error'
    latencyMs: integer("latency_ms"),
    statusCode: integer("status_code"),
    errorMessage: text("error_message"),
    containerStatus: text("container_status"),
  },
  (t) => [
    index("idx_app_health_probes_app_probed").on(t.appId, t.probedAt),
    index("idx_app_health_probes_server_probed").on(t.serverId, t.probedAt),
    index("idx_app_health_probes_app_type_outcome").on(t.appId, t.probeType, t.outcome),
    index("idx_app_health_probes_probed").on(t.probedAt),
  ],
);
```

The XOR CHECK constraint is enforced at the DB level — the migration emits the SQL directly. Drizzle does not currently model multi-column CHECK constraints in TypeScript; the constraint exists in the DB and tests assert its presence (`tests/integration/migration-0007-verification.test.ts`).

---

## Modified entity: `applications`

Eight new columns. Existing columns unchanged.

```ts
// Drizzle schema additions (devops-app/server/db/schema.ts):
export const applications = pgTable("applications", {
  // ... existing columns ...
  // ── Feature 006: health monitoring ──────────────────────────────────────
  healthUrl: text("health_url"),                                                       // FR-004 — optional public URL for HTTP probe
  healthStatus: text("health_status").notNull().default("unknown"),                    // FR-013 — 'healthy' | 'unhealthy' | 'unknown'
  healthCheckedAt: text("health_checked_at"),                                          // updated every probe (R-011)
  healthLastChangeAt: text("health_last_change_at"),                                   // updated only on transition commit (R-011)
  healthMessage: text("health_message"),                                               // most recent failure reason
  healthProbeIntervalSec: integer("health_probe_interval_sec").notNull().default(60),  // FR-002 — per-app cadence override, ≥10s
  healthDebounceCount: integer("health_debounce_count").notNull().default(2),          // FR-007 — per-app debounce override, ≥1
  monitoringEnabled: boolean("monitoring_enabled").notNull().default(true),            // FR-001 — master switch
  alertsMuted: boolean("alerts_muted").notNull().default(false),                       // FR-018 — silence Telegram, keep tracking state
});
```

### Behaviour rules

- `health_status` defaults to `'unknown'`. Existing apps post-migration ALL show `'unknown'` until first probe cycle. Per FR-008, the `unknown → healthy` transition does NOT fire an alert — operators are not spammed at rollout.
- `health_checked_at` and `health_message` UPDATE on EVERY probe completion (R-011 freshness vs correctness split).
- `health_status` and `health_last_change_at` UPDATE ONLY on debounce-committed transitions.
- `monitoring_enabled = false` stops the probe scheduler from creating a tick for this app on next `start()` or `reloadApp()`. The poller checks this on every tick and exits the loop if the flag flipped.
- `alerts_muted = true` skips the Telegram notify call but preserves all probe persistence and state-machine commits — recovery alerts upon unmute will reflect the most recent transition.

---

## Cross-feature contract: `app_certs` (owned by feature 008)

Feature 006's `cert_expiry` probe WRITES `app_certs.expires_at` and `app_certs.last_renew_at` per FR-006a / FR-022 of feature 008.

```sql
-- Read by 006 (every cert_expiry probe):
SELECT id, app_id, domain, status, issued_at, expires_at, last_renew_at
  FROM app_certs WHERE app_id = $1 AND domain = $2 AND status IN ('active', 'pending');

-- Written by 006 on successful TLS handshake:
UPDATE app_certs SET
  expires_at      = $2,                         -- parsed from cert.valid_to
  last_renew_at   = $3,                         -- now() if expires_at moved forward
  last_renew_outcome = 'success'
WHERE app_id = $1 AND domain = $4 AND status IN ('active', 'pending');
```

`app_cert_events` (also feature 008) is READ by 006 for windowed-once-per-lifecycle dedupe (R-007):

```sql
-- Read before firing a window alert:
SELECT 1 FROM app_cert_events
 WHERE cert_id = $1 AND event_type = 'expiry_alert'
   AND event_data->>'window_days' = $2
   AND occurred_at > $3;                        -- $3 = MAX(issued_at, last_renew_at) for this cert

-- Written by 006 after firing a window alert:
INSERT INTO app_cert_events (id, cert_id, event_type, event_data, actor, occurred_at)
VALUES ($1, $2, 'expiry_alert', jsonb_build_object('window_days', $3, 'days_left', $4), 'system', $5);
```

Bidirectional contract per spec § Dependencies: 008 owns the table schema and the cert state machine; 006 owns the periodic observation that maintains `expires_at` freshness and the windowed alert dispatch.

---

## Cross-feature contract: `deploy_locks` (owned by feature 004)

FR-011 — probe loop READS the row to check for active deploy on this app:

```sql
-- Read at start of every per-app probe tick:
SELECT app_id FROM deploy_locks WHERE app_id = $1;
```

Probe NEVER writes to `deploy_locks`. Deploy NEVER reads probe state. One-way coordination per R-010.

---

## Manifest extension contract: `waitForHealthy` / `healthyTimeoutMs`

Feature 005's `scripts-manifest.ts` `ScriptManifestEntry` type gains two optional fields:

```ts
interface ScriptManifestEntry<TParams extends z.ZodObject<z.ZodRawShape> = z.ZodObject<z.ZodRawShape>> {
  // ... existing fields ...
  // ── Feature 006: post-deploy health gate ────────────────────────────────
  waitForHealthy?: boolean;          // FR-024 — default false
  healthyTimeoutMs?: number;         // FR-024 — default 180_000
}
```

These are entry-level (per-manifest-entry) flags, NOT runtime params. The deploy entry `deploy/server-deploy` is the obvious candidate to add them to:

```ts
{
  id: "deploy/server-deploy",
  // ... existing fields ...
  waitForHealthy: true,                                          // opt in for the canonical deploy entry
  healthyTimeoutMs: 180_000,
  params: z.object({ /* ... */ }),
}
```

The manifest descriptor served at `GET /api/scripts/manifest` (feature 005) MUST include these fields when present — UI may surface "this entry will wait for healthy" in the Run dialog.

---

## Query catalogue

All queries the poller / routes issue.

### Q1. Insert a probe result

```sql
INSERT INTO app_health_probes
  (id, app_id, server_id, probed_at, probe_type, outcome,
   latency_ms, status_code, error_message, container_status)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10);
-- Either app_id or server_id non-null per XOR constraint
```

### Q2. Fetch app current state + last 50 probes (for `GET /api/applications/:id/health`)

```sql
SELECT id, health_url, health_status, health_checked_at, health_last_change_at,
       health_message, health_probe_interval_sec, health_debounce_count,
       monitoring_enabled, alerts_muted
  FROM applications WHERE id = $1;

SELECT id, probed_at, probe_type, outcome, latency_ms, status_code,
       error_message, container_status
  FROM app_health_probes
  WHERE app_id = $1
  ORDER BY probed_at DESC
  LIMIT 50;
```

### Q3. Fetch sparkline data (24h, ordered ASC for left-to-right rendering)

```sql
SELECT probed_at, probe_type, outcome
  FROM app_health_probes
  WHERE app_id = $1
    AND probed_at::timestamptz > NOW() - INTERVAL '24 hours'
  ORDER BY probed_at ASC;
```

Index `idx_app_health_probes_app_probed` covers (app_id, probed_at desc) — Postgres scans backwards then sorts in-memory for the 1440-row max result set. Acceptable.

### Q4. Update freshness columns (every probe)

```sql
UPDATE applications
   SET health_checked_at = $2,
       health_message = $3
 WHERE id = $1;
```

### Q5. Commit transition (debounce satisfied)

```sql
UPDATE applications
   SET health_status = $2,
       health_last_change_at = $3
 WHERE id = $1;
```

### Q6. Read deploy lock for FR-011 interlock

```sql
SELECT app_id FROM deploy_locks WHERE app_id = $1;
```

### Q7. Retention prune (startup + periodic)

```sql
DELETE FROM app_health_probes
  WHERE probed_at::timestamptz < NOW() - INTERVAL '30 days';
```

The `30 days` is the default; the actual interval is parameterised via `HEALTH_PROBE_RETENTION_DAYS` env var read at startup. Pattern matches feature 005's `script_runs` prune (R-010 of feature 005).

### Q8. List apps that need monitoring (start of poller)

```sql
SELECT id, server_id, name, repo_url, branch, remote_path,
       health_url, health_status, health_probe_interval_sec, health_debounce_count,
       monitoring_enabled, alerts_muted, container_name, service_name, domain
  FROM applications
  WHERE monitoring_enabled = TRUE
  ORDER BY id;
```

(`container_name`, `service_name` are columns introduced as part of the override-allowance discussion in R-012; if v1 ships without them, the derivation falls back to defaults.)

### Q9. List servers needing caddy_admin probe

```sql
SELECT DISTINCT s.id, s.label, s.host
  FROM servers s
  JOIN applications a ON a.server_id = s.id
 WHERE a.domain IS NOT NULL AND a.monitoring_enabled = TRUE;
```

### Q10. Daily cert_expiry sweep

```sql
SELECT id, server_id, name, domain
  FROM applications
  WHERE monitoring_enabled = TRUE AND domain IS NOT NULL
  ORDER BY id;
```

### Q11. Read cert event log for window dedupe (FR-015a)

```sql
-- Find this cert's most recent renewal/issuance moment to bound the lifecycle
SELECT MAX(occurred_at) AS lifecycle_start FROM app_cert_events
 WHERE cert_id = $1 AND event_type IN ('issued', 'renewed');

-- Check if the window has already alerted in this lifecycle
SELECT 1 FROM app_cert_events
 WHERE cert_id = $1 AND event_type = 'expiry_alert'
   AND event_data->>'window_days' = $2
   AND occurred_at > $3;     -- $3 = lifecycle_start
```

All parameter bindings use Drizzle or `postgres` tagged-template — no raw string interpolation.

---

## Retention policy

`HEALTH_PROBE_RETENTION_DAYS` env var (default `30`) read at startup by `appHealthPoller.start()`. Two prune triggers:

1. **Startup**: blocking before HTTP listen (matches feature 005 R-010 pattern).
2. **Periodic**: `setInterval(24 * 3600 * 1000, () => appHealthPoller.pruneOldProbes()).unref()` — `.unref()` ensures it doesn't block process exit.

```ts
async pruneOldProbes(): Promise<{ deletedRows: number }> {
  const days = parseInt(process.env.HEALTH_PROBE_RETENTION_DAYS ?? "30", 10);
  if (!Number.isFinite(days) || days < 1) {
    logger.warn({ ctx: "app-health-prune", days }, "Invalid retention value; skipping prune");
    return { deletedRows: 0 };
  }
  const result = await db.execute(sql`
    DELETE FROM app_health_probes
     WHERE probed_at::timestamptz < NOW() - INTERVAL '1 day' * ${days}
  `);
  return { deletedRows: result.rowCount ?? 0 };
}
```

A-005 storage projection: 10 apps × 2 probe types × 1/min × 60 × 24 × 30 = 864K rows at 30d retention. With 100 apps and 4 probe types (container, http, cert_expiry once daily, caddy_admin per server) the projection is ~12M rows. At ~80 bytes/row that's <1 GB — well within Postgres's comfort zone. v2 hourly aggregation deferred until 100+ apps in production.

---

## Migration file path

`devops-app/server/db/migrations/0007_app_health_monitoring.sql`

Sequence rationale: feature 006 was specced 2026-04-22, before features 007/008/009 — but the migration is being written 2026-04-28 after feature 007 already shipped its `0006_project_local_deploy.sql`. The migration sequence reflects WRITE ORDER, not SPEC ORDER. Next available slot is `0007`. Feature 008's migration will be `0008` regardless of whether 008 ships before or after 006 in calendar terms — sequence numbers are append-only IDs, not authoring deadlines.
