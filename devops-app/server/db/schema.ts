import {
  pgTable,
  text,
  integer,
  real,
  index,
  jsonb,
} from "drizzle-orm/pg-core";

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
  deployScript: text("deploy_script").notNull(),
  currentCommit: text("current_commit"),
  currentVersion: text("current_version"),
  envVars: jsonb("env_vars").notNull().default({}),
  createdAt: text("created_at").notNull(),
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
