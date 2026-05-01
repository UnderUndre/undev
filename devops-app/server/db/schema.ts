import {
  pgTable,
  text,
  integer,
  real,
  index,
  jsonb,
  boolean,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// ── Server ──────────────────────────────────────────────────────────────────
export const servers = pgTable("servers", {
  id: text("id").primaryKey(),
  label: text("label").notNull(),
  host: text("host").notNull(),
  port: integer("port").notNull().default(22),
  sshUser: text("ssh_user").notNull(),
  sshAuthMethod: text("ssh_auth_method").notNull().default("key"), // key | password
  sshPrivateKey: text("ssh_private_key"), // PEM key content (for auth_method=key)
  sshPassword: text("ssh_password"), // password (for auth_method=password)
  scriptsPath: text("scripts_path").notNull(),
  status: text("status").notNull().default("unknown"), // online | offline | unknown
  lastHealthCheck: text("last_health_check"),
  scanRoots: jsonb("scan_roots")
    .$type<string[]>()
    .notNull()
    .default(sql`'["/opt","/srv","/var/www","/home"]'::jsonb`),
  createdAt: text("created_at").notNull(),
});

// ── Application ─────────────────────────────────────────────────────────────
export const applications = pgTable("applications", {
  id: text("id").primaryKey(),
  serverId: text("server_id")
    .notNull()
    .references(() => servers.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  repoUrl: text("repo_url").notNull(),
  branch: text("branch").notNull(),
  remotePath: text("remote_path").notNull(),
  currentCommit: text("current_commit"),
  currentVersion: text("current_version"),
  envVars: jsonb("env_vars").notNull().default({}),
  githubRepo: text("github_repo"), // "owner/repo" for GitHub-linked apps, null otherwise
  scriptPath: text("script_path"), // Feature 007: project-local deploy script (relative path inside repo); null = use builtin
  skipInitialClone: boolean("skip_initial_clone").notNull().default(false), // true for scan-imported apps — deploy uses fetch+reset, not clone
  // ── Feature 006: health monitoring ──────────────────────────────────────
  healthUrl: text("health_url"), // FR-004 — optional public URL for HTTP probe
  healthStatus: text("health_status").notNull().default("unknown"), // FR-013 — 'healthy' | 'unhealthy' | 'unknown'
  healthCheckedAt: text("health_checked_at"), // updated every probe (R-011)
  healthLastChangeAt: text("health_last_change_at"), // updated only on transition commit (R-011)
  healthMessage: text("health_message"), // most recent failure reason
  healthProbeIntervalSec: integer("health_probe_interval_sec").notNull().default(60), // FR-002 — per-app cadence override, ≥10s
  healthDebounceCount: integer("health_debounce_count").notNull().default(2), // FR-007 — per-app debounce override, ≥1
  monitoringEnabled: boolean("monitoring_enabled").notNull().default(true), // FR-001 — master switch
  alertsMuted: boolean("alerts_muted").notNull().default(false), // FR-018 — silence Telegram, keep tracking state
  // ── Feature 008: Application Domain & TLS ───────────────────────────────
  domain: text("domain"), // FR-001 — public domain, lowercase, no leading wildcard. UNIQUE(server_id,domain) WHERE domain IS NOT NULL.
  acmeEmail: text("acme_email"), // FR-002 — per-app ACME email override; null = use global app_settings.acme_email
  proxyType: text("proxy_type").notNull().default("caddy"), // FR-003 — 'caddy' | 'nginx-legacy' | 'none'
  // Upstream addressing for Caddy reverse_proxy (R-012). Pulled into 008 from
  // pending feature 009 because caddy-config-builder needs them now.
  upstreamService: text("upstream_service"), // compose service name (e.g. "app")
  upstreamPort: integer("upstream_port"), // container port (e.g. 3000)
  // ── Feature 009: bootstrap deploy from GitHub repo ──────────────────────
  bootstrapState: text("bootstrap_state").notNull().default("active"), // FR-008/FR-009 — state machine current state
  bootstrapAutoRetry: boolean("bootstrap_auto_retry").notNull().default(false), // FR-022 — opt-in reconciler auto-retry
  composePath: text("compose_path").notNull().default("docker-compose.yml"), // FR-007 — relative path inside repo
  createdVia: text("created_via").notNull().default("manual"), // FR-032 — 'manual' | 'scan' | 'bootstrap'
  createdAt: text("created_at").notNull(),
});

// ── Feature 009: app_bootstrap_events ───────────────────────────────────────
// Append-only audit of every bootstrap state-machine transition (FR-010).
export const appBootstrapEvents = pgTable(
  "app_bootstrap_events",
  {
    id: text("id").primaryKey(),
    appId: text("app_id")
      .notNull()
      .references(() => applications.id, { onDelete: "cascade" }),
    fromState: text("from_state").notNull(),
    toState: text("to_state").notNull(),
    occurredAt: text("occurred_at").notNull(),
    metadata: jsonb("metadata"),
    actor: text("actor").notNull().default("system"), // 'system' | userId
  },
  (t) => [
    index("idx_app_bootstrap_events_app_occurred").on(t.appId, t.occurredAt),
    index("idx_app_bootstrap_events_to_state").on(t.toState),
  ],
);

// ── Feature 008: app_certs ──────────────────────────────────────────────────
// One row per cert lifecycle. Survives app soft-delete via `orphan_reason`.
// Hard-delete cascades. See data-model.md FR-004 / Invariants.
export const appCerts = pgTable(
  "app_certs",
  {
    id: text("id").primaryKey(),
    appId: text("app_id")
      .notNull()
      .references(() => applications.id, { onDelete: "cascade" }),
    domain: text("domain").notNull(),
    issuer: text("issuer").notNull(), // 'letsencrypt' | 'self-signed' | 'manual'
    status: text("status").notNull(), // pending | active | expired | revoked | rate_limited | failed | orphaned | pending_reconcile
    issuedAt: text("issued_at"),
    expiresAt: text("expires_at"),
    lastRenewAt: text("last_renew_at"),
    lastRenewOutcome: text("last_renew_outcome"), // 'success' | 'failure'
    errorMessage: text("error_message"),
    retryAfter: text("retry_after"),
    orphanedAt: text("orphaned_at"),
    orphanReason: text("orphan_reason").notNull().default(""), // '' | 'domain_change' | 'app_soft_delete' | 'manual_orphan'
    acmeAccountEmail: text("acme_account_email"),
    pendingDnsRecheckUntil: text("pending_dns_recheck_until"), // T066 — ISO timestamp; non-null while DNS revalidation in flight (FR-014a)
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    index("idx_app_certs_app_status").on(t.appId, t.status),
    index("idx_app_certs_status_created").on(t.status, t.createdAt),
    index("idx_app_certs_domain_created").on(t.domain, t.createdAt),
    index("idx_app_certs_orphaned").on(t.orphanReason, t.orphanedAt),
  ],
);

// ── Feature 008: app_cert_events ────────────────────────────────────────────
// Append-only state-transition log per FR-020 / FR-026.
export const appCertEvents = pgTable(
  "app_cert_events",
  {
    id: text("id").primaryKey(),
    certId: text("cert_id")
      .notNull()
      .references(() => appCerts.id, { onDelete: "cascade" }),
    eventType: text("event_type").notNull(),
    eventData: jsonb("event_data"),
    actor: text("actor").notNull(), // 'system' | userId
    occurredAt: text("occurred_at").notNull(),
  },
  (t) => [
    index("idx_app_cert_events_cert_occurred").on(t.certId, t.occurredAt),
    index("idx_app_cert_events_type_occurred").on(t.eventType, t.occurredAt),
  ],
);

// ── Feature 008: app_settings ───────────────────────────────────────────────
// Key-value store for global TLS settings (FR-005). v1 ships with key `acme_email`.
export const appSettings = pgTable("app_settings", {
  key: text("key").primaryKey(),
  value: text("value"),
  updatedAt: text("updated_at").notNull(),
});

// ── Feature 006: app_health_probes ──────────────────────────────────────────
// One row per probe execution. XOR(app_id, server_id) — caddy_admin probes are per-server,
// container/http/cert_expiry probes are per-app. CHECK constraint enforces XOR at DB level.
export const appHealthProbes = pgTable(
  "app_health_probes",
  {
    id: text("id").primaryKey(),
    appId: text("app_id").references(() => applications.id, { onDelete: "cascade" }),
    serverId: text("server_id").references(() => servers.id, { onDelete: "cascade" }),
    probedAt: text("probed_at").notNull(),
    probeType: text("probe_type").notNull(), // 'container' | 'http' | 'cert_expiry' | 'caddy_admin'
    outcome: text("outcome").notNull(), // 'healthy' | 'unhealthy' | 'warning' | 'error'
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

// ── GitHub Connection (singleton) ───────────────────────────────────────────
// One row per dashboard instance, enforced by CHECK (id = 'DEFAULT') constraint.
export const githubConnection = pgTable("github_connection", {
  id: text("id").primaryKey(), // Always 'DEFAULT' — DB-level CHECK constraint enforces
  token: text("token").notNull(),
  username: text("username").notNull(),
  avatarUrl: text("avatar_url").notNull(),
  tokenExpiresAt: text("token_expires_at"),
  connectedAt: text("connected_at").notNull(),
});

// ── Deployment ──────────────────────────────────────────────────────────────
export const deployments = pgTable(
  "deployments",
  {
    id: text("id").primaryKey(),
    applicationId: text("application_id")
      .notNull()
      .references(() => applications.id, { onDelete: "cascade" }),
    serverId: text("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    type: text("type").notNull(), // deploy | rollback
    status: text("status").notNull(), // pending | running | success | failed | cancelled
    branch: text("branch").notNull(),
    commitBefore: text("commit_before").notNull(),
    commitAfter: text("commit_after").notNull(),
    startedAt: text("started_at").notNull(),
    finishedAt: text("finished_at"),
    duration: integer("duration"),
    logFilePath: text("log_file_path").notNull(),
    errorMessage: text("error_message"),
  },
  (t) => [
    index("idx_deployments_app_started").on(t.applicationId, t.startedAt),
    index("idx_deployments_server_status").on(t.serverId, t.status),
  ],
);

// ── Backup ──────────────────────────────────────────────────────────────────
export const backups = pgTable(
  "backups",
  {
    id: text("id").primaryKey(),
    serverId: text("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
    databaseName: text("database_name").notNull(),
    filePath: text("file_path").notNull(),
    fileSize: integer("file_size").notNull().default(0),
    retentionDays: integer("retention_days").notNull().default(30),
    expiresAt: text("expires_at").notNull(),
    createdAt: text("created_at").notNull(),
    status: text("status").notNull(), // in-progress | complete | failed | expired
  },
  (t) => [
    index("idx_backups_server_created").on(t.serverId, t.createdAt),
    index("idx_backups_expires").on(t.expiresAt),
  ],
);

// ── Health Snapshot ─────────────────────────────────────────────────────────
export const healthSnapshots = pgTable(
  "health_snapshots",
  {
    id: text("id").primaryKey(),
    serverId: text("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
    timestamp: text("timestamp").notNull(),
    cpuLoadPercent: real("cpu_load_percent").notNull(),
    memoryPercent: real("memory_percent").notNull(),
    diskPercent: real("disk_percent").notNull(),
    swapPercent: real("swap_percent").notNull(),
    dockerContainers: jsonb("docker_containers").notNull().default([]),
    services: jsonb("services").notNull().default([]),
  },
  (t) => [
    index("idx_health_server_timestamp").on(t.serverId, t.timestamp),
  ],
);

// ── Audit Entry ─────────────────────────────────────────────────────────────
export const auditEntries = pgTable(
  "audit_entries",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    action: text("action").notNull(),
    targetType: text("target_type").notNull(), // server | application | deployment | backup
    targetId: text("target_id").notNull(),
    details: text("details"),
    result: text("result").notNull(), // success | failure
    timestamp: text("timestamp").notNull(),
  },
  (t) => [index("idx_audit_timestamp").on(t.timestamp)],
);

// ── Session ─────────────────────────────────────────────────────────────────
export const sessions = pgTable("sessions", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  expiresAt: text("expires_at").notNull(),
  createdAt: text("created_at").notNull(),
});

// ── Deploy Lock ─────────────────────────────────────────────────────────────
// One row per currently-held deploy lock. `dashboard_pid` is the
// pg_backend_pid() of the connection holding the session-scoped advisory
// lock — used by startup reconciliation to wipe orphan rows whose owning
// backend is gone from pg_stat_activity.
export const deployLocks = pgTable("deploy_locks", {
  serverId: text("server_id")
    .primaryKey()
    .references(() => servers.id, { onDelete: "cascade" }),
  appId: text("app_id").notNull(),
  acquiredAt: text("acquired_at").notNull(),
  dashboardPid: integer("dashboard_pid").notNull(),
});

// ── Script Runs ─────────────────────────────────────────────────────────────
// Feature 005: one row per invocation of any manifest-listed operation.
// Deploy runs dual-write here AND into `deployments` (linked via deployment_id
// FK). Standalone ops (backups, audits, ...) have deployment_id = NULL and own
// their log file; deploy runs don't own the log (the deployments row does per
// feature 001 retention).
export const scriptRuns = pgTable(
  "script_runs",
  {
    id: text("id").primaryKey(),
    scriptId: text("script_id").notNull(),
    serverId: text("server_id").references(() => servers.id, {
      onDelete: "set null",
    }),
    deploymentId: text("deployment_id").references(() => deployments.id, {
      onDelete: "set null",
    }),
    userId: text("user_id").notNull(),
    params: jsonb("params").notNull(),
    status: text("status").notNull(), // pending | running | success | failed | cancelled | timeout
    startedAt: text("started_at").notNull(),
    finishedAt: text("finished_at"),
    duration: integer("duration"),
    exitCode: integer("exit_code"),
    outputArtifact: jsonb("output_artifact"),
    errorMessage: text("error_message"),
    logFilePath: text("log_file_path").notNull(),
  },
  (t) => [
    index("idx_script_runs_server_started").on(t.serverId, t.startedAt),
    index("idx_script_runs_script_started").on(t.scriptId, t.startedAt),
    index("idx_script_runs_started").on(t.startedAt),
  ],
);
