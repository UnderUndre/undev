# Data Model: Bootstrap Deploy from GitHub Repo

**Phase 1 output** | **Date**: 2026-04-28

---

## Modified entity: `applications`

Six new columns added by `0009_bootstrap.sql`. The existing columns (`id`, `serverId`, `name`, `repoUrl`, `branch`, `remotePath`, `currentCommit`, `currentVersion`, `envVars`, `githubRepo`, `scriptPath`, `skipInitialClone`, `createdAt`) remain unchanged.

| Column | Type | Default | Notes |
|----|----|----|----|
| `bootstrap_state` | TEXT NOT NULL | `'active'` | One of: `init`, `cloning`, `compose_up`, `healthcheck`, `proxy_applied`, `cert_issued`, `active`, `failed_clone`, `failed_compose`, `failed_healthcheck`, `failed_proxy`, `failed_cert`. Existing rows backfill to `active`. CHECK constraint enforces enum. |
| `bootstrap_auto_retry` | BOOLEAN NOT NULL | `FALSE` | Per-app opt-in for the 5-minute reconciler (FR-022). |
| `upstream_service` | TEXT NULL | `NULL` | Compose service name proxied by Caddy (FR-006 in spec). NULL when app has no proxy / no domain. |
| `upstream_port` | INTEGER NULL | `NULL` | Internal container port for the upstream service. CHECK enforces 1–65535 when not NULL. |
| `compose_path` | TEXT NOT NULL | `'docker-compose.yml'` | Relative path from `remote_path` to the compose file. |
| `created_via` | TEXT NOT NULL | `'manual'` | One of `manual`, `scan`, `bootstrap`. CHECK enforces enum. Read-only after creation (enforced at API layer per FR-032). |

### Backfill

Per FR-032:

```sql
UPDATE "applications" SET "created_via" = 'scan' WHERE "skip_initial_clone" = TRUE;
-- Default 'manual' covers all other existing rows; no second UPDATE.
```

`bootstrap_state` defaults to `'active'` for every existing row — they were created before bootstrap existed, so they're trivially "past the bootstrap state machine".

### Lifecycle (bootstrap-created rows only)

```
INSERT (status=init, created_via='bootstrap')
  │
  ├── orchestrator.start() → state=cloning
  │     │
  │     ├── exit 0 → state=compose_up
  │     ├── exit !=0 → state=failed_clone, app_bootstrap_events row inserted with metadata={ error_message }
  │     │
  │     ├── (compose_up) exit 0 → state=healthcheck
  │     │   exit !=0 → state=failed_compose
  │     │
  │     ├── (healthcheck) exit 0 → state=proxy_applied [if domain] OR active [if no domain]
  │     │   exit !=0 → state=failed_healthcheck
  │     │
  │     ├── (proxy_applied) exit 0 → state=cert_issued
  │     │   exit !=0 → state=failed_proxy
  │     │
  │     └── (cert_issued) exit 0 → state=active
  │         exit !=0 → state=failed_cert
  │
  └── retryFromFailedStep(fromStep) → state=<fromStep> (validated by canTransition table)
```

### Invariants

1. `bootstrap_state` is monotonic forward through the success chain. Backwards transitions (`active → cloning`) are rejected by `canTransition`.
2. `failed_<step> → <step>` (retry) is the only allowed backwards-into-the-chain transition.
3. `created_via` is immutable post-INSERT — the API rejects PATCHes that include this field.
4. `upstream_service` + `upstream_port` are EITHER both NULL OR both NOT NULL (no half-state). Enforced at API layer.

### Drizzle schema fragment

```ts
export const applications = pgTable("applications", {
  // ... existing fields ...
  bootstrapState: text("bootstrap_state").notNull().default("active"),
  bootstrapAutoRetry: boolean("bootstrap_auto_retry").notNull().default(false),
  upstreamService: text("upstream_service"),
  upstreamPort: integer("upstream_port"),
  composePath: text("compose_path").notNull().default("docker-compose.yml"),
  createdVia: text("created_via").notNull().default("manual"),
});
```

---

## New entity: `app_bootstrap_events`

Append-only log of state-machine transitions. One row per transition.

```ts
interface AppBootstrapEvent {
  id: string;                   // UUID PK
  appId: string;                // FK → applications(id) ON DELETE CASCADE
  fromState: string;            // bootstrap_state value before transition
  toState: string;              // bootstrap_state value after transition
  occurredAt: string;           // ISO 8601 (TEXT — matches existing convention)
  metadata: unknown | null;     // JSONB — step-specific context
  actor: string;                // 'system' (auto-retry / orchestrator) | userId
}
```

### `metadata` shapes per `to_state`

The `metadata` column is a free-form JSONB blob; the orchestrator writes a known shape per transition:

| `to_state` | `metadata` shape |
|----|----|
| `cloning` | `{ runId, repoUrl, branch }` (PAT NOT included — separate from logged params) |
| `compose_up` | `{ runId, composePath }` |
| `healthcheck` | `{ runId, hasComposeHealthcheck }` |
| `proxy_applied` | `{ runId, caddyConfigHash }` |
| `cert_issued` | `{ runId, certId, expiresAt }` |
| `active` | `{ currentCommit }` |
| `failed_<step>` | `{ runId, errorMessage, exitCode, retryCount, reason: 'auto_retry' \| 'manual_retry' \| 'first_attempt' }` |
| `hard_deleted` | `{ confirmedBy: userId, removedFrom: resolvedPath }` (terminal — never followed by another row) |

### Lifecycle

Append-only. Never UPDATEd. Cascaded delete on `applications.id` removal — when an app is hard-deleted, its event chain follows the row.

### Invariants

1. `from_state` of the first row for any `app_id` is always `'init'` (or in the "bootstrap row was created by some unusual path" case, the row is non-existent and the first row's `from_state` matches the row's current `bootstrap_state`).
2. `to_state` of row N matches `from_state` of row N+1 for the same `app_id` (chain consistency). Validated by `bootstrap-orchestrator-events.test.ts`.
3. `actor = 'system'` for orchestrator-driven transitions and reconciler auto-retries; `actor = userId` for manual operator actions (Retry button, Hard Delete).

### DDL (excerpt from `0009_bootstrap.sql`)

```sql
CREATE TABLE "app_bootstrap_events" (
  "id" TEXT PRIMARY KEY,
  "app_id" TEXT NOT NULL REFERENCES "applications"("id") ON DELETE CASCADE,
  "from_state" TEXT NOT NULL,
  "to_state" TEXT NOT NULL,
  "occurred_at" TEXT NOT NULL DEFAULT (NOW()::text),
  "metadata" JSONB,
  "actor" TEXT NOT NULL DEFAULT 'system'
);

CREATE INDEX "idx_app_bootstrap_events_app_occurred"
  ON "app_bootstrap_events" ("app_id", "occurred_at" DESC);
CREATE INDEX "idx_app_bootstrap_events_to_state"
  ON "app_bootstrap_events" ("to_state");
```

Two indexes support:

- Wizard's progress view (chain of transitions for one app, newest first) → `idx_app_bootstrap_events_app_occurred`.
- Admin queries ("how many apps failed at compose_up this week") → `idx_app_bootstrap_events_to_state`.

### Drizzle schema fragment

```ts
export const appBootstrapEvents = pgTable(
  "app_bootstrap_events",
  {
    id: text("id").primaryKey(),
    appId: text("app_id").notNull().references(() => applications.id, { onDelete: "cascade" }),
    fromState: text("from_state").notNull(),
    toState: text("to_state").notNull(),
    occurredAt: text("occurred_at").notNull(),
    metadata: jsonb("metadata"),
    actor: text("actor").notNull().default("system"),
  },
  (t) => [
    index("idx_app_bootstrap_events_app_occurred").on(t.appId, t.occurredAt),
    index("idx_app_bootstrap_events_to_state").on(t.toState),
  ],
);
```

---

## Migration

**File**: `devops-app/server/db/migrations/0009_bootstrap.sql`

Sequence: existing migrations on `main` are `0000_initial.sql` through `0006_project_local_deploy.sql`. Feature 006 (App Health Monitoring) lands `0007_app_health_monitoring.sql`. Feature 008 (Domain & TLS) lands `0008_application_domain_and_tls.sql`. This feature lands `0009_bootstrap.sql` — the next free slot.

```sql
-- Feature 009: bootstrap deploy from GitHub repo.
-- Adds six columns to `applications` and creates `app_bootstrap_events`.

ALTER TABLE "applications" ADD COLUMN "bootstrap_state" TEXT NOT NULL DEFAULT 'active';
ALTER TABLE "applications" ADD COLUMN "bootstrap_auto_retry" BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE "applications" ADD COLUMN "upstream_service" TEXT;
ALTER TABLE "applications" ADD COLUMN "upstream_port" INTEGER;
ALTER TABLE "applications" ADD COLUMN "compose_path" TEXT NOT NULL DEFAULT 'docker-compose.yml';
ALTER TABLE "applications" ADD COLUMN "created_via" TEXT NOT NULL DEFAULT 'manual';

-- Backfill (FR-032): scan-imported rows → 'scan'; everything else stays 'manual'.
UPDATE "applications" SET "created_via" = 'scan' WHERE "skip_initial_clone" = TRUE;

-- Enum CHECK constraints
ALTER TABLE "applications" ADD CONSTRAINT "applications_bootstrap_state_enum" CHECK (
  "bootstrap_state" IN (
    'init', 'cloning', 'compose_up', 'healthcheck',
    'proxy_applied', 'cert_issued', 'active',
    'failed_clone', 'failed_compose', 'failed_healthcheck',
    'failed_proxy', 'failed_cert'
  )
);
ALTER TABLE "applications" ADD CONSTRAINT "applications_created_via_enum"
  CHECK ("created_via" IN ('manual', 'scan', 'bootstrap'));
ALTER TABLE "applications" ADD CONSTRAINT "applications_upstream_port_range"
  CHECK ("upstream_port" IS NULL OR ("upstream_port" >= 1 AND "upstream_port" <= 65535));

CREATE TABLE "app_bootstrap_events" (
  "id" TEXT PRIMARY KEY,
  "app_id" TEXT NOT NULL REFERENCES "applications"("id") ON DELETE CASCADE,
  "from_state" TEXT NOT NULL,
  "to_state" TEXT NOT NULL,
  "occurred_at" TEXT NOT NULL DEFAULT (NOW()::text),
  "metadata" JSONB,
  "actor" TEXT NOT NULL DEFAULT 'system'
);

CREATE INDEX "idx_app_bootstrap_events_app_occurred"
  ON "app_bootstrap_events" ("app_id", "occurred_at" DESC);
CREATE INDEX "idx_app_bootstrap_events_to_state"
  ON "app_bootstrap_events" ("to_state");

-- DOWN migration (manual, operator-gated — destructive):
--   DROP TABLE "app_bootstrap_events";
--   ALTER TABLE "applications" DROP CONSTRAINT "applications_bootstrap_state_enum";
--   ALTER TABLE "applications" DROP CONSTRAINT "applications_created_via_enum";
--   ALTER TABLE "applications" DROP CONSTRAINT "applications_upstream_port_range";
--   ALTER TABLE "applications" DROP COLUMN "created_via";
--   ALTER TABLE "applications" DROP COLUMN "compose_path";
--   ALTER TABLE "applications" DROP COLUMN "upstream_port";
--   ALTER TABLE "applications" DROP COLUMN "upstream_service";
--   ALTER TABLE "applications" DROP COLUMN "bootstrap_auto_retry";
--   ALTER TABLE "applications" DROP COLUMN "bootstrap_state";
```

---

## Query catalogue

All queries the orchestrator + routes issue.

### Q1. Insert new bootstrap-state row (Step 5 of wizard "Bootstrap")

```sql
INSERT INTO applications (
  id, server_id, name, repo_url, branch, remote_path, github_repo,
  bootstrap_state, bootstrap_auto_retry, compose_path,
  upstream_service, upstream_port, created_via, skip_initial_clone, created_at
) VALUES (
  $1, $2, $3, $4, $5, $6, $7,
  'init', FALSE, $8,
  $9, $10, 'bootstrap', FALSE, NOW()::text
);
```

### Q2. Append state-transition event

```sql
INSERT INTO app_bootstrap_events (id, app_id, from_state, to_state, occurred_at, metadata, actor)
VALUES ($1, $2, $3, $4, NOW()::text, $5::jsonb, $6);
```

### Q3. Transition the app row

Done in the same transaction as Q2:

```sql
UPDATE applications SET bootstrap_state = $2 WHERE id = $1;
```

### Q4. Read current state for the wizard's poll endpoint (`GET /api/applications/:id/bootstrap-state`)

```sql
SELECT
  a.id,
  a.name,
  a.bootstrap_state,
  a.created_via,
  a.upstream_service,
  a.upstream_port,
  a.compose_path,
  a.domain,                       -- feature 008 column
  e.events                        -- aggregated subquery
FROM applications a
LEFT JOIN LATERAL (
  SELECT JSONB_AGG(
    JSONB_BUILD_OBJECT(
      'id', id, 'fromState', from_state, 'toState', to_state,
      'occurredAt', occurred_at, 'metadata', metadata, 'actor', actor
    ) ORDER BY occurred_at ASC
  ) AS events
  FROM app_bootstrap_events
  WHERE app_id = a.id
) e ON TRUE
WHERE a.id = $1;
```

### Q5. Reconciler — find auto-retry candidates

```sql
SELECT id, bootstrap_state, server_id
FROM applications
WHERE bootstrap_state LIKE 'failed_%'
  AND bootstrap_auto_retry = TRUE;
```

### Q6. Reconciler — count recent auto-retries for backoff (FR-022, 3-strike rule)

```sql
SELECT COUNT(*) FROM app_bootstrap_events
WHERE app_id = $1
  AND metadata->>'reason' = 'auto_retry'
  AND occurred_at::timestamptz > NOW() - INTERVAL '1 hour';
```

### Q7. Stuck-state detection (R-012 — DB-first ordering recovery)

```sql
SELECT a.id, a.bootstrap_state, a.server_id
FROM applications a
WHERE a.bootstrap_state IN ('cloning', 'compose_up', 'healthcheck', 'proxy_applied', 'cert_issued')
  AND NOT EXISTS (
    SELECT 1 FROM script_runs sr
    WHERE sr.deployment_id IS NULL
      AND sr.script_id LIKE 'bootstrap/%'
      AND sr.status = 'running'
      AND sr.params->>'appId' = a.id           -- orchestrator includes appId in params metadata
  )
  AND a.bootstrap_state != 'active';
```

(The `params->>'appId'` lookup requires `bootstrap-orchestrator` to include `appId` in the `params` JSONB it passes to `scriptsRunner.runScript` — call out in implementation.)

### Q8. Hard-delete cascade (run in single transaction)

```sql
-- Step 6 of FR-021 ordering — proxy/cert removal happens via feature 008 hard-delete (out-of-band)
-- and the on-target rm happens via SSH (out-of-band). The DB row removal is the LAST step:
DELETE FROM applications WHERE id = $1;
-- ON DELETE CASCADE clears app_bootstrap_events; feature 008's app_certs FK clears certs;
-- feature 005's script_runs.deployment_id FK uses SET NULL (preserves run history).
```

### Q9. List apps with `created_via` filter (FR-033 dropdown)

```sql
SELECT id, name, server_id, bootstrap_state, created_via, ...
FROM applications
WHERE server_id = $1
  AND ($2::text = 'all' OR created_via = $2);
```

All parameter bindings use Drizzle or `postgres` tagged-template — no raw string interpolation.

---

## Retention rules

- `app_bootstrap_events` rows: **append-only, no prune**. Volume calculation: 7–10 transitions per bootstrap × 1000 bootstraps × 200 bytes = 1.4 MB. Negligible. Cascaded delete on parent `applications` row.
- `applications.bootstrap_state`: never null, transitions through CHECK-validated values.

---

## Cross-feature schema dependencies

| Feature | What we read | What we write |
|----|----|----|
| 002 (gh-integration) | `github_connection.token` (PAT) | none |
| 005 (script-runner) | `script_runs.status`, `script_runs.error_message` | `script_runs` rows tagged `script_id = 'bootstrap/*'` (via runner) |
| 006 (health-monitoring) | none directly — feature 006 reads our compose-defined healthcheck via SSH | none |
| 008 (domain-and-tls) | `app_certs.status` (orchestrator polls during CERT_ISSUED step) | feature 008's reconciler reads our `applications.domain` + `upstream_service` + `upstream_port` |

No other feature MUTATES our two tables (`app_bootstrap_events` is private to this feature; `applications` mutations from other features touch different columns).

Proceed to `contracts/api.md`.
