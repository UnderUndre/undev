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
  createdAt: text("created_at").notNull(),
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
