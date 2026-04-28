# Data Model: Application Domain & TLS

**Phase 1 output** | **Date**: 2026-04-28

Note: Postgres, not SQLite. Existing convention (verified at `devops-app/server/db/schema.ts`) uses `text("...").notNull()` for ISO-8601 timestamp strings, `jsonb(...)` for structured payloads, `text(...)` for enum-like fields without `pgEnum` (the codebase has chosen string literals over enum types throughout — keeps migrations straightforward). New tables follow the same conventions.

---

## Modified entity: `applications`

Three new columns. None back-populated with non-default values via the migration (per R-009 the reconciler corrects `proxy_type` post-restart).

```ts
// devops-app/server/db/schema.ts — additions inside the existing `applications` table definition
export const applications = pgTable("applications", {
  // ... existing columns unchanged ...
  domain: text("domain"),                                      // NEW — public domain, lowercase, no leading wildcard
  acmeEmail: text("acme_email"),                               // NEW — per-app ACME email override; null = use global
  proxyType: text("proxy_type").notNull().default("caddy"),    // NEW — 'caddy' | 'nginx-legacy' | 'none'
});
```

### DDL fragment (in migration `0008_*.sql`)

```sql
ALTER TABLE "applications" ADD COLUMN "domain" TEXT;
ALTER TABLE "applications" ADD COLUMN "acme_email" TEXT;
ALTER TABLE "applications" ADD COLUMN "proxy_type" TEXT NOT NULL DEFAULT 'caddy';

-- FR-001: per-server domain uniqueness, partial index ignoring NULLs.
-- Cross-server collision is intentionally NOT a constraint (FR-001a is an advisory check).
CREATE UNIQUE INDEX "idx_apps_server_domain_unique"
  ON "applications" ("server_id", "domain")
  WHERE "domain" IS NOT NULL;

-- FR-030: domain regex via CHECK constraint at the DB level. Defence-of-last-resort
-- against any codepath that bypasses the API layer's domainValidator.
ALTER TABLE "applications" ADD CONSTRAINT "applications_domain_format"
  CHECK ("domain" IS NULL OR "domain" ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$');

-- proxy_type enum-like guard
ALTER TABLE "applications" ADD CONSTRAINT "applications_proxy_type_valid"
  CHECK ("proxy_type" IN ('caddy', 'nginx-legacy', 'none'));
```

### Backfill strategy

| Existing state                                        | After migration | Further action                                         |
|-------------------------------------------------------|-----------------|--------------------------------------------------------|
| `domain IS NULL` (always — column is new)             | `domain = NULL` | None until operator sets via PATCH /domain.            |
| `acme_email IS NULL` (always — column is new)         | `acme_email = NULL` | None — falls back to global at issuance time.       |
| `proxy_type` (default `'caddy'`)                      | `proxy_type = 'caddy'` | First reconciler tick may flip to `'nginx-legacy'` per R-008 SSH probe. |

No bulk SQL backfill — every existing row is correct under the defaults. The R-008 probe is post-startup (in-memory), not migration-time.

---

## New entity: `app_certs`

One row per cert lifecycle. Survives app soft-delete via `orphan_reason`. Does NOT survive app hard-delete (CASCADE). Index on `(app_id, status)` for the rate-limit query and the per-app cert-list view.

```ts
// devops-app/server/db/schema.ts — new table
export const appCerts = pgTable(
  "app_certs",
  {
    id: text("id").primaryKey(),
    appId: text("app_id")
      .notNull()
      .references(() => applications.id, { onDelete: "cascade" }),
    domain: text("domain").notNull(),
    issuer: text("issuer").notNull(),                          // 'letsencrypt' | 'self-signed' | 'manual'
    status: text("status").notNull(),                          // pending | active | expired | revoked | rate_limited | failed | orphaned | pending_reconcile
    issuedAt: text("issued_at"),
    expiresAt: text("expires_at"),
    lastRenewAt: text("last_renew_at"),
    lastRenewOutcome: text("last_renew_outcome"),              // 'success' | 'failure' | null
    errorMessage: text("error_message"),
    retryAfter: text("retry_after"),
    orphanedAt: text("orphaned_at"),
    orphanReason: text("orphan_reason").notNull().default(""), // '' | 'domain_change' | 'app_soft_delete' | 'manual_orphan'
    acmeAccountEmail: text("acme_account_email"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    index("idx_app_certs_app_status").on(t.appId, t.status),
    index("idx_app_certs_status_created").on(t.status, t.createdAt),
    index("idx_app_certs_domain_created").on(t.domain, t.createdAt),
    index("idx_app_certs_orphaned").on(t.orphanReason, t.orphanedAt),
  ],
);
```

### DDL

```sql
CREATE TABLE "app_certs" (
  "id" TEXT PRIMARY KEY,
  "app_id" TEXT NOT NULL REFERENCES "applications"("id") ON DELETE CASCADE,
  "domain" TEXT NOT NULL,
  "issuer" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "issued_at" TEXT,
  "expires_at" TEXT,
  "last_renew_at" TEXT,
  "last_renew_outcome" TEXT,
  "error_message" TEXT,
  "retry_after" TEXT,
  "orphaned_at" TEXT,
  "orphan_reason" TEXT NOT NULL DEFAULT '',
  "acme_account_email" TEXT,
  "created_at" TEXT NOT NULL
);

-- Index choices (Q1-Q5 from "Query catalogue" below):
CREATE INDEX "idx_app_certs_app_status"        ON "app_certs" ("app_id", "status");                -- per-app cert list
CREATE INDEX "idx_app_certs_status_created"    ON "app_certs" ("status", "created_at" DESC);      -- rate-limit window
CREATE INDEX "idx_app_certs_domain_created"    ON "app_certs" ("domain", "created_at" DESC);      -- registered-domain rate count
CREATE INDEX "idx_app_certs_orphaned"          ON "app_certs" ("orphan_reason", "orphaned_at");   -- orphan cleanup job

-- status enum-like guard
ALTER TABLE "app_certs" ADD CONSTRAINT "app_certs_status_valid"
  CHECK ("status" IN ('pending', 'active', 'expired', 'revoked', 'rate_limited', 'failed', 'orphaned', 'pending_reconcile'));

-- orphan_reason enum-like guard
ALTER TABLE "app_certs" ADD CONSTRAINT "app_certs_orphan_reason_valid"
  CHECK ("orphan_reason" IN ('', 'domain_change', 'app_soft_delete', 'manual_orphan'));

-- Cross-table invariant: orphan_reason non-empty ⇔ status = 'orphaned'.
ALTER TABLE "app_certs" ADD CONSTRAINT "app_certs_orphan_consistency"
  CHECK (
    ("status" = 'orphaned' AND "orphan_reason" <> '' AND "orphaned_at" IS NOT NULL)
    OR
    ("status" <> 'orphaned' AND "orphan_reason" = '' AND "orphaned_at" IS NULL)
  );
```

### Invariants

1. **Status progresses through the FR-defined transition table** (see plan.md §Cert lifecycle state machine). Direct DB writes that bypass the lifecycle helper are rejected by callers — there's no DB-level enforcement of legal transitions, only of valid status values.
2. **`orphan_reason` non-empty ⇔ `status = 'orphaned'`** — enforced by CHECK above.
3. **`orphaned_at` present ⇔ `status = 'orphaned'`** — enforced by same CHECK.
4. **`expires_at` is updated by the cert_expiry probe** (feature 006 FR-006a) post-issuance; `issued_at` is set once and never updated.
5. **`error_message` is preserved across status transitions** — when a `failed` row is force-renewed back to `pending`, the previous error stays for forensics.

### Retention rule (orphan cleanup job)

Daily background job per FR-019:

```sql
DELETE FROM "app_certs"
 WHERE "status" = 'orphaned'
   AND (
     ("orphan_reason" = 'domain_change'   AND "orphaned_at"::timestamptz < NOW() - INTERVAL '7 days')
     OR
     ("orphan_reason" = 'app_soft_delete' AND "orphaned_at"::timestamptz < NOW() - INTERVAL '30 days')
     OR
     ("orphan_reason" = 'manual_orphan'   AND "orphaned_at"::timestamptz < NOW() - INTERVAL '7 days')
   )
RETURNING id, app_id, domain;
```

Each returned row triggers an SSH cleanup pass: `rm -rf /var/lib/caddy/.local/share/caddy/certificates/acme.../<domain>` on the target. Best-effort — `rm -rf` non-existent path is fine. Caddy's storage layout is documented and stable across 2.x.

### Rate-limit window query (R-007)

```sql
SELECT COUNT(*) FROM "app_certs"
WHERE "status" IN ('pending', 'active', 'failed')
  AND "created_at"::timestamptz > NOW() - INTERVAL '7 days'
  AND ("domain" = $1 OR "domain" LIKE '%.' || $1);
```

Bound `$1` is the registered-domain output of `lib/psl.ts`. The index `idx_app_certs_domain_created` covers the ORDER BY-less prefix match.

---

## New entity: `app_cert_events`

Append-only event log for cert state transitions. ON DELETE CASCADE from `app_certs` (when a cert is hard-deleted, its events go with it; orphan-cleanup deletes the events as a side effect).

```ts
export const appCertEvents = pgTable(
  "app_cert_events",
  {
    id: text("id").primaryKey(),
    certId: text("cert_id")
      .notNull()
      .references(() => appCerts.id, { onDelete: "cascade" }),
    eventType: text("event_type").notNull(),
    eventData: jsonb("event_data"),
    actor: text("actor").notNull(),                  // 'system' | userId
    occurredAt: text("occurred_at").notNull(),
  },
  (t) => [
    index("idx_app_cert_events_cert_occurred").on(t.certId, t.occurredAt),
    index("idx_app_cert_events_type_occurred").on(t.eventType, t.occurredAt),
  ],
);
```

### DDL

```sql
CREATE TABLE "app_cert_events" (
  "id" TEXT PRIMARY KEY,
  "cert_id" TEXT NOT NULL REFERENCES "app_certs"("id") ON DELETE CASCADE,
  "event_type" TEXT NOT NULL,
  "event_data" JSONB,
  "actor" TEXT NOT NULL,
  "occurred_at" TEXT NOT NULL
);

CREATE INDEX "idx_app_cert_events_cert_occurred"  ON "app_cert_events" ("cert_id", "occurred_at" DESC);
CREATE INDEX "idx_app_cert_events_type_occurred"  ON "app_cert_events" ("event_type", "occurred_at" DESC);

-- event_type enum-like guard
ALTER TABLE "app_cert_events" ADD CONSTRAINT "app_cert_events_type_valid"
  CHECK ("event_type" IN ('issued', 'renewed', 'failed', 'orphaned', 'revoked', 'rate_limited', 'force_renew_requested', 'pending_reconcile_marked', 'pending_reconcile_cleared'));
```

### Retention

Events live as long as their parent cert. When the orphan cleanup job DELETEs an `app_certs` row, the cascade removes events. No separate retention.

---

## New entity: `app_settings`

Key-value store for global TLS settings. v1 has one key (`acme_email`); future global settings (notification thresholds, default ACME directory, etc.) reuse the same shape.

```ts
export const appSettings = pgTable("app_settings", {
  key: text("key").primaryKey(),
  value: text("value"),                             // null is meaningful — "unset"
  updatedAt: text("updated_at").notNull(),
});
```

### DDL

```sql
CREATE TABLE "app_settings" (
  "key" TEXT PRIMARY KEY,
  "value" TEXT,
  "updated_at" TEXT NOT NULL
);

-- Seed required global keys at migration time.
INSERT INTO "app_settings" ("key", "value", "updated_at")
VALUES ('acme_email', NULL, NOW()::TEXT);
```

### Constraints

- `key` is plain text — no enum guard. New keys are added by code, not by user input. The route handler validates known keys before READ/WRITE.
- `value` may be NULL — meaning "unset, fall back to default" (R-011 confirms this is intended for `acme_email`).

---

## Migration file

**Path**: `devops-app/server/db/migrations/0008_application_domain_and_tls.sql`

Verified: existing migrations are `0000_initial.sql` through `0006_project_local_deploy.sql`. Feature 006 (App Health Monitoring) takes `0007_app_health_monitoring.sql` as its base-infra migration; this feature lands at `0008_*`. Feature 009 (Bootstrap) lands at `0009_*`.

Full migration listing (single atomic file):

```sql
-- Feature 008: Application Domain & TLS.
--
-- Adds the missing data model for domains and certificates:
--   - applications.domain / acme_email / proxy_type (FR-001, FR-002, FR-003).
--   - app_certs (FR-004) — one row per cert lifecycle.
--   - app_cert_events (FR-020) — append-only state-transition log.
--   - app_settings (FR-005) — key-value store for global TLS settings; seeded with NULL acme_email.
--
-- This migration is ADDITIVE: no destructive changes, no row mutations beyond
-- the SETTINGS seed insert. Existing rows get default proxy_type='caddy'; the
-- reconciler corrects rows on nginx-legacy servers post-restart (R-008).
--
-- DOWN migration (manual, operator-gated — destructive):
--   DROP TABLE "app_settings";
--   DROP TABLE "app_cert_events";
--   DROP TABLE "app_certs";
--   ALTER TABLE "applications" DROP CONSTRAINT "applications_proxy_type_valid";
--   ALTER TABLE "applications" DROP CONSTRAINT "applications_domain_format";
--   DROP INDEX "idx_apps_server_domain_unique";
--   ALTER TABLE "applications" DROP COLUMN "proxy_type";
--   ALTER TABLE "applications" DROP COLUMN "acme_email";
--   ALTER TABLE "applications" DROP COLUMN "domain";

-- 1. applications additions
ALTER TABLE "applications" ADD COLUMN "domain" TEXT;
ALTER TABLE "applications" ADD COLUMN "acme_email" TEXT;
ALTER TABLE "applications" ADD COLUMN "proxy_type" TEXT NOT NULL DEFAULT 'caddy';

CREATE UNIQUE INDEX "idx_apps_server_domain_unique"
  ON "applications" ("server_id", "domain")
  WHERE "domain" IS NOT NULL;

ALTER TABLE "applications" ADD CONSTRAINT "applications_domain_format"
  CHECK ("domain" IS NULL OR "domain" ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$');

ALTER TABLE "applications" ADD CONSTRAINT "applications_proxy_type_valid"
  CHECK ("proxy_type" IN ('caddy', 'nginx-legacy', 'none'));

-- 2. app_certs
CREATE TABLE "app_certs" (
  "id" TEXT PRIMARY KEY,
  "app_id" TEXT NOT NULL REFERENCES "applications"("id") ON DELETE CASCADE,
  "domain" TEXT NOT NULL,
  "issuer" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "issued_at" TEXT,
  "expires_at" TEXT,
  "last_renew_at" TEXT,
  "last_renew_outcome" TEXT,
  "error_message" TEXT,
  "retry_after" TEXT,
  "orphaned_at" TEXT,
  "orphan_reason" TEXT NOT NULL DEFAULT '',
  "acme_account_email" TEXT,
  "created_at" TEXT NOT NULL
);

CREATE INDEX "idx_app_certs_app_status"        ON "app_certs" ("app_id", "status");
CREATE INDEX "idx_app_certs_status_created"    ON "app_certs" ("status", "created_at" DESC);
CREATE INDEX "idx_app_certs_domain_created"    ON "app_certs" ("domain", "created_at" DESC);
CREATE INDEX "idx_app_certs_orphaned"          ON "app_certs" ("orphan_reason", "orphaned_at");

ALTER TABLE "app_certs" ADD CONSTRAINT "app_certs_status_valid"
  CHECK ("status" IN ('pending', 'active', 'expired', 'revoked', 'rate_limited', 'failed', 'orphaned', 'pending_reconcile'));

ALTER TABLE "app_certs" ADD CONSTRAINT "app_certs_orphan_reason_valid"
  CHECK ("orphan_reason" IN ('', 'domain_change', 'app_soft_delete', 'manual_orphan'));

ALTER TABLE "app_certs" ADD CONSTRAINT "app_certs_orphan_consistency"
  CHECK (
    ("status" = 'orphaned' AND "orphan_reason" <> '' AND "orphaned_at" IS NOT NULL)
    OR
    ("status" <> 'orphaned' AND "orphan_reason" = '' AND "orphaned_at" IS NULL)
  );

-- 3. app_cert_events
CREATE TABLE "app_cert_events" (
  "id" TEXT PRIMARY KEY,
  "cert_id" TEXT NOT NULL REFERENCES "app_certs"("id") ON DELETE CASCADE,
  "event_type" TEXT NOT NULL,
  "event_data" JSONB,
  "actor" TEXT NOT NULL,
  "occurred_at" TEXT NOT NULL
);

CREATE INDEX "idx_app_cert_events_cert_occurred"  ON "app_cert_events" ("cert_id", "occurred_at" DESC);
CREATE INDEX "idx_app_cert_events_type_occurred"  ON "app_cert_events" ("event_type", "occurred_at" DESC);

ALTER TABLE "app_cert_events" ADD CONSTRAINT "app_cert_events_type_valid"
  CHECK ("event_type" IN ('issued', 'renewed', 'failed', 'orphaned', 'revoked', 'rate_limited', 'force_renew_requested', 'pending_reconcile_marked', 'pending_reconcile_cleared'));

-- 4. app_settings
CREATE TABLE "app_settings" (
  "key" TEXT PRIMARY KEY,
  "value" TEXT,
  "updated_at" TEXT NOT NULL
);

INSERT INTO "app_settings" ("key", "value", "updated_at")
VALUES ('acme_email', NULL, NOW()::TEXT);
```

---

## Query catalogue

All queries the runner / routes / cron jobs issue.

### Q1. Insert new pending cert (issuance request)

```sql
INSERT INTO "app_certs" (id, app_id, domain, issuer, status, created_at)
VALUES ($1, $2, $3, 'letsencrypt', 'pending', NOW()::TEXT);
INSERT INTO "app_cert_events" (id, cert_id, event_type, actor, occurred_at)
VALUES ($4, $1, 'force_renew_requested', $5, NOW()::TEXT);
```

Wrapped in a transaction.

### Q2. Transition cert to active (after Caddy reports issued)

```sql
UPDATE "app_certs"
   SET "status" = 'active',
       "issued_at" = $2,
       "expires_at" = $3,
       "acme_account_email" = $4
 WHERE id = $1 AND status IN ('pending', 'pending_reconcile');
INSERT INTO "app_cert_events" (id, cert_id, event_type, event_data, actor, occurred_at)
VALUES ($5, $1, 'issued', $6, 'system', NOW()::TEXT);
```

The `WHERE status IN (...)` guards against double-writes from concurrent reconciler ticks.

### Q3. Transition cert to failed

```sql
UPDATE "app_certs"
   SET "status" = 'failed',
       "error_message" = $2
 WHERE id = $1 AND status = 'pending';
INSERT INTO "app_cert_events" (id, cert_id, event_type, event_data, actor, occurred_at)
VALUES ($3, $1, 'failed', $4, $5, NOW()::TEXT);
```

### Q4. List certs for an app

```sql
SELECT * FROM "app_certs" WHERE app_id = $1 ORDER BY created_at DESC;
```

Index `idx_app_certs_app_status` doesn't help here (no status filter); a plain seqscan + sort works fine for typical N=1-10 rows per app.

### Q5. Rate-limit count for registered domain

```sql
SELECT COUNT(*) FROM "app_certs"
WHERE status IN ('pending', 'active', 'failed')
  AND created_at::timestamptz > NOW() - INTERVAL '7 days'
  AND (domain = $1 OR domain LIKE '%.' || $1);
```

`idx_app_certs_domain_created` covers the prefix match on domain + range on created_at.

### Q6. Cross-server domain advisory check (FR-001a)

```sql
SELECT id, server_id, name FROM "applications"
WHERE domain = $1 AND server_id <> $2;
```

Returns rows = "warn the operator about HA / round-robin"; empty = silent pass.

### Q7. Orphan cleanup (daily cron, FR-019)

```sql
DELETE FROM "app_certs"
 WHERE status = 'orphaned'
   AND (
     (orphan_reason = 'domain_change'   AND orphaned_at::timestamptz < NOW() - INTERVAL '7 days')
     OR
     (orphan_reason = 'app_soft_delete' AND orphaned_at::timestamptz < NOW() - INTERVAL '30 days')
     OR
     (orphan_reason = 'manual_orphan'   AND orphaned_at::timestamptz < NOW() - INTERVAL '7 days')
   )
RETURNING id, app_id, domain;
```

Caller iterates returned rows, ssh-rms each Caddy storage path. Cascade removes `app_cert_events`.

### Q8. Read global setting

```sql
SELECT value FROM "app_settings" WHERE key = $1;
```

### Q9. Update global setting

```sql
INSERT INTO "app_settings" (key, value, updated_at)
VALUES ($1, $2, NOW()::TEXT)
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at;
```

### Q10. Resolve effective ACME email for issuance (FR-016)

```sql
SELECT
  COALESCE(
    (SELECT acme_email FROM applications WHERE id = $1),
    (SELECT value FROM app_settings WHERE key = 'acme_email')
  ) AS effective_email;
```

Returns NULL → caller blocks issuance with `400 ACME_EMAIL_REQUIRED` per FR-016.

### Q11. List certs needing the daily cert_expiry probe (feature 006 cross-reference)

```sql
SELECT a.id, a.domain
  FROM applications a
 WHERE a.domain IS NOT NULL
   AND a.proxy_type = 'caddy';
```

Feature 006's `cert_expiry` probe scheduler reads this list once per day and probes each domain. Result writes back via Q12.

### Q12. cert_expiry probe writes expires_at (cross-feature contract with 006)

```sql
UPDATE "app_certs"
   SET "expires_at" = $2,
       "last_renew_at" = $3,
       "last_renew_outcome" = $4
 WHERE id = (
   SELECT id FROM app_certs
    WHERE app_id = $1 AND status = 'active'
    ORDER BY created_at DESC
    LIMIT 1
 );
```

Feature 006 ONLY writes these three fields. Status transitions stay this feature's responsibility.

---

All parameter bindings use Drizzle or `postgres` tagged-template — no raw string interpolation. The migration is the only file with literal SQL, and that's reviewed by the operator before apply (CLAUDE.md rule 5).
