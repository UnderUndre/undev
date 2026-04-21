# Data Model: Universal Script Runner

**Phase 1 output** | **Date**: 2026-04-22

---

## New entity: `script_runs`

One row per invocation of a manifest-listed operation against a server. Survives server deletion (`ON DELETE SET NULL`) and script removal from the manifest (no FK). Deploy runs dual-write here AND into the existing `deployments` table.

```ts
interface ScriptRun {
  id: string;                    // UUID PK
  scriptId: string;              // e.g. "deploy/deploy", "db/backup". Plain text (no FK to manifest).
  serverId: string | null;       // FK → servers(id) ON DELETE SET NULL
  deploymentId: string | null;   // FK → deployments(id) ON DELETE SET NULL — non-null only when scriptId starts with "deploy/"
  userId: string;                // actor
  params: unknown;               // JSONB, secrets already masked as "***" per FR-016
  status: "pending" | "running" | "success" | "failed" | "cancelled" | "timeout";
  startedAt: string;             // ISO 8601 (TEXT — matches existing convention)
  finishedAt: string | null;     // ISO 8601
  duration: number | null;       // ms
  exitCode: number | null;       // shell exit code when terminated naturally
  outputArtifact: unknown | null; // JSONB, shape per manifest's outputArtifact.type
  errorMessage: string | null;
  logFilePath: string;           // /app/data/logs/<job-id>.log
}
```

### Lifecycle

```
(insert)
  status = pending
     │
     ├── runner begins SSH exec ─→ status = running, startedAt set
     │     │
     │     ├── exit 0 ────→ status = success, finishedAt, duration, exitCode=0
     │     ├── exit !=0 ──→ status = failed, exitCode, errorMessage
     │     ├── timeout ──→ status = timeout, errorMessage="Script timed out after Xms"
     │     └── ssh error → status = failed, errorMessage=<err.message>
     │
     └── admin cancels (deploy runs only in v1) ─→ status = cancelled
```

### Invariants

1. **`status` progresses monotonically** — never rolls back from terminal state to `running`.
2. **`params` never contains plaintext secrets** — the masking happens at insert time (R-006), not display time.
3. **`deploymentId` non-null ⇔ scriptId starts with `"deploy/"`**.
4. **`logFilePath` points at a file that existed during the run**. Subject to retention pruning (FR-042) — the file may later be deleted, but until then, logFilePath is stable.

### DDL (migration `0005_scripts_runner.sql`)

Two schema changes in one migration (atomic per A-002):

```sql
-- Drop the deploy_script column (feature 005 §Deploy Consolidation)
ALTER TABLE "applications" DROP COLUMN "deploy_script";

-- New table for runner history
CREATE TABLE "script_runs" (
  "id" TEXT PRIMARY KEY,
  "script_id" TEXT NOT NULL,
  "server_id" TEXT REFERENCES "servers"("id") ON DELETE SET NULL,
  "deployment_id" TEXT REFERENCES "deployments"("id") ON DELETE SET NULL,
  "user_id" TEXT NOT NULL,
  "params" JSONB NOT NULL,
  "status" TEXT NOT NULL,
  "started_at" TEXT NOT NULL,
  "finished_at" TEXT,
  "duration" INTEGER,
  "exit_code" INTEGER,
  "output_artifact" JSONB,
  "error_message" TEXT,
  "log_file_path" TEXT NOT NULL
);

CREATE INDEX "idx_script_runs_server_started" ON "script_runs" ("server_id", "started_at" DESC);
CREATE INDEX "idx_script_runs_script_started" ON "script_runs" ("script_id", "started_at" DESC);
CREATE INDEX "idx_script_runs_started"        ON "script_runs" ("started_at" DESC);
```

Three indexes support the three UI query shapes:

- Runs tab filtered by server → `idx_script_runs_server_started`
- "When did we last backup this DB?" (filter by scriptId) → `idx_script_runs_script_started`
- Global recent runs list → `idx_script_runs_started`

### Drizzle schema fragment

Added to `devops-app/server/db/schema.ts`:

```ts
export const scriptRuns = pgTable(
  "script_runs",
  {
    id: text("id").primaryKey(),
    scriptId: text("script_id").notNull(),
    serverId: text("server_id").references(() => servers.id, { onDelete: "set null" }),
    deploymentId: text("deployment_id").references(() => deployments.id, { onDelete: "set null" }),
    userId: text("user_id").notNull(),
    params: jsonb("params").notNull(),
    status: text("status").notNull(),
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
```

Also updates `applications` table: `deployScript` field is removed.

---

## Modified entity: `applications`

**Removed column**: `deploy_script TEXT NOT NULL`.

Drizzle schema change: delete the `deployScript: text("deploy_script").notNull(),` line at `schema.ts:42`.

All runtime consumers migrate to `resolveDeployOperation(app, runParams)` — no `deploy_script` reads remain in the codebase after this feature.

---

## New in-memory entity: `ScriptManifest`

Declared in `devops-app/server/scripts-manifest.ts`. NOT persisted. Loaded at startup, validated, held in a module-scoped map.

```ts
type ScriptCategory = "deploy" | "db" | "docker" | "monitoring" | "server-ops";
type ScriptLocus = "target" | "local" | "bootstrap";
type DangerLevel = "low" | "medium" | "high";

interface OutputArtifactSpec {
  type: "file-path" | "url" | "json";
  captureFrom: "stdout-last-line" | "stdout-json";
}

interface ScriptManifestEntry<TParams extends z.ZodObject<z.ZodRawShape> = z.ZodObject<z.ZodRawShape>> {
  id: string;                       // "<category>/<name>"
  category: ScriptCategory;
  description: string;
  locus: ScriptLocus;
  params: TParams;
  requiresLock?: boolean;           // default false
  timeout?: number;                 // ms, default 1_800_000
  dangerLevel?: DangerLevel;
  outputArtifact?: OutputArtifactSpec;
}

export const manifest: ScriptManifestEntry[] = [
  // deploy/*
  { id: "deploy/deploy",      category: "deploy", description: "Deploy an application", locus: "target",
    requiresLock: true, timeout: 1_800_000,
    params: z.object({
      remotePath: z.string(),
      branch: z.string().regex(/^[a-zA-Z0-9._\-/]+$/),
      commit: z.string().regex(/^[0-9a-f]{7,40}$/).optional(),
      skipInitialClone: z.boolean().default(false),
    }),
  },
  { id: "deploy/rollback",    category: "deploy", description: "Rollback to a previous commit", locus: "target",
    requiresLock: true,
    params: z.object({
      remotePath: z.string(),
      commit: z.string().regex(/^[0-9a-f]{7,40}$/),
    }),
  },
  { id: "deploy/deploy-docker", category: "deploy", description: "Deploy a docker-compose app", locus: "target",
    requiresLock: true,
    params: z.object({
      remotePath: z.string(),
      branch: z.string().optional(),
      commit: z.string().optional(),
    }),
  },
  { id: "deploy/env-setup",   category: "deploy", description: "Set up server environment variables", locus: "target",
    params: z.object({ appPath: z.string() }),
  },
  { id: "deploy/logs",        category: "deploy", description: "Tail deploy log", locus: "target",
    params: z.object({ appPath: z.string(), lines: z.number().default(100) }),
  },
  // db/*
  { id: "db/backup",          category: "db", description: "Backup a Postgres database", locus: "target",
    outputArtifact: { type: "file-path", captureFrom: "stdout-last-line" },
    params: z.object({
      databaseName: z.string(),
      retentionDays: z.number().default(30),
    }),
  },
  { id: "db/restore",         category: "db", description: "Restore a Postgres database from a backup", locus: "target",
    requiresLock: true, dangerLevel: "high",
    params: z.object({
      databaseName: z.string(),
      backupPath: z.string(),
    }),
  },
  // docker/*
  { id: "docker/cleanup",     category: "docker", description: "Prune unused Docker resources", locus: "target",
    params: z.object({ includeImages: z.boolean().default(true) }),
  },
  // monitoring/*
  { id: "monitoring/security-audit", category: "monitoring", description: "Run security audit", locus: "target",
    params: z.object({}),
  },
  // server-ops/*
  { id: "server-ops/health-check", category: "server-ops", description: "Check system health", locus: "target",
    params: z.object({}),
  },
];
```

(Exact param schemas subject to adjustment per actual script argv in task phase.)

### Validation at startup (FR-003 / R-009)

1. `new Set(manifest.map(e => e.id)).size === manifest.length` — no duplicates.
2. For each entry: `fs.existsSync(path.join(process.cwd(), "scripts", entry.category, name + ".sh"))` where `name = entry.id.split("/")[1]`. Exception: `server-ops/health-check` maps to `scripts/server/health-check.sh` (category→folder mapping table: `deploy→deploy, db→db, docker→docker, monitoring→monitoring, server-ops→server`).
3. `z.object.parse({})` on the entry's schema must either succeed (all defaults) or fail with a ZodError (not any other error type — catches schema authoring bugs).

---

## Deprecated entity

`applications.deploy_script` — removed by migration `0005_scripts_runner.sql`. No dual-write period, no grace column.

---

## Query catalogue

All queries the runner / routes issue.

### Q1. Insert new run (pending)

```sql
INSERT INTO script_runs (id, script_id, server_id, deployment_id, user_id, params, status,
                         started_at, log_file_path)
VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8);
-- id = UUID, started_at = ISO now, deployment_id = null unless deploy
```

### Q2. Transition to running (on SSH exec start)

```sql
UPDATE script_runs SET status = 'running' WHERE id = $1;
```

### Q3. Terminal status update

```sql
UPDATE script_runs
   SET status         = $2,
       finished_at    = $3,
       duration       = $4,
       exit_code      = $5,
       error_message  = $6,
       output_artifact = $7
 WHERE id = $1;
```

### Q4. Fetch recent runs for Runs page (global)

```sql
SELECT id, script_id, server_id, user_id, status, started_at, finished_at, duration
  FROM script_runs
  ORDER BY started_at DESC
  LIMIT $1 OFFSET $2;
```

### Q5. Fetch recent runs filtered

```sql
SELECT ...
  FROM script_runs
  WHERE ($1::text IS NULL OR status = $1)
    AND ($2::text IS NULL OR server_id = $2)
    AND ($3::text IS NULL OR script_id = $3)
  ORDER BY started_at DESC
  LIMIT $4 OFFSET $5;
```

### Q6. Detail view

```sql
SELECT * FROM script_runs WHERE id = $1;
```

### Q7. Retention prune (startup, R-010)

```sql
DELETE FROM script_runs
  WHERE started_at < NOW() - INTERVAL '90 days'
  RETURNING log_file_path;
-- The runner then fs.unlink each returned log_file_path (best-effort, ignore ENOENT).
```

All parameter bindings use Drizzle or `postgres` tagged-template — no raw string interpolation.
