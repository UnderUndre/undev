/**
 * Feature 005: Universal Script Runner manifest.
 *
 * Every runnable operation is declared here with:
 *   - id              → "<category>/<name>" (matches scripts/<folder>/<name>.sh)
 *   - category        → UI grouping; maps to folder via CATEGORY_FOLDER_MAP
 *   - params          → Zod schema (single source of validation + UI descriptor)
 *   - requiresLock    → true ⇒ acquire feature-004 deploy lock before exec
 *   - dangerLevel     → "high" ⇒ UI forces admin to type the id to confirm
 *   - outputArtifact  → capture hint for post-run artefact (file path, url, json)
 *
 * Category → folder mapping — the only non-identity entry is "server-ops → server":
 *   deploy        → scripts/deploy/
 *   db            → scripts/db/
 *   docker        → scripts/docker/
 *   monitoring    → scripts/monitoring/
 *   server-ops    → scripts/server/    ← UX name "Server-Ops" reads better than "Server"
 *
 * T022 (manifest validation test) and T012 (runner file resolution) import
 * CATEGORY_FOLDER_MAP rather than hard-coding, so the mapping can only live
 * in one place.
 */

import { z } from "zod";

export type ScriptCategory =
  | "deploy"
  | "db"
  | "docker"
  | "monitoring"
  | "server-ops";

export type ScriptLocus = "target" | "local" | "bootstrap";
export type DangerLevel = "low" | "medium" | "high";

export interface OutputArtifactSpec {
  type: "file-path" | "url" | "json";
  captureFrom: "stdout-last-line" | "stdout-json";
}

export interface ScriptManifestEntry<
  TParams extends z.ZodTypeAny = z.ZodTypeAny,
> {
  id: string;
  category: ScriptCategory;
  description: string;
  locus: ScriptLocus;
  params: TParams;
  requiresLock?: boolean;
  timeout?: number;
  dangerLevel?: DangerLevel;
  outputArtifact?: OutputArtifactSpec;
}

export const CATEGORY_FOLDER_MAP: Record<ScriptCategory, string> = {
  deploy: "deploy",
  db: "db",
  docker: "docker",
  monitoring: "monitoring",
  "server-ops": "server",
};

const BRANCH_REGEX = /^[a-zA-Z0-9._\-/]+$/;
const SHA_REGEX = /^[0-9a-f]{7,40}$/;

export const manifest: ScriptManifestEntry[] = [
  // deploy/*
  {
    // Target-side script: scripts/deploy/server-deploy.sh. Accepts --app-dir
    // and handles fetch/reset/rebuild internally via git+docker compose.
    // scripts/deploy/deploy.sh is a LOCAL orchestrator (push from laptop over
    // SSH) — not shipped via the runner.
    id: "deploy/server-deploy",
    category: "deploy",
    description: "Deploy an application (fetch + reset + compose rebuild)",
    locus: "target",
    requiresLock: true,
    timeout: 1_800_000,
    params: z.object({
      appDir: z.string(),
      noCache: z.boolean().default(false),
      skipCleanup: z.boolean().default(false),
    }),
  },
  {
    // Target-side rollback: scripts/deploy/server-rollback.sh.
    id: "deploy/server-rollback",
    category: "deploy",
    description: "Rollback to a previous commit (git reset + compose restart)",
    locus: "target",
    requiresLock: true,
    params: z.object({
      appDir: z.string(),
      commit: z.string().regex(SHA_REGEX),
    }),
  },
  {
    id: "deploy/deploy-docker",
    category: "deploy",
    description: "Deploy a docker-compose app",
    locus: "target",
    requiresLock: true,
    params: z.object({
      remotePath: z.string(),
      branch: z.string().optional(),
      commit: z.string().optional(),
    }),
  },
  {
    id: "deploy/env-setup",
    category: "deploy",
    description: "Set up server environment variables",
    locus: "target",
    params: z.object({ appPath: z.string() }),
  },
  {
    id: "deploy/logs",
    category: "deploy",
    description: "Tail deploy log",
    locus: "target",
    params: z.object({
      appPath: z.string(),
      lines: z.number().default(100),
    }),
  },
  // db/*
  {
    id: "db/backup",
    category: "db",
    description: "Backup a Postgres database",
    locus: "target",
    outputArtifact: { type: "file-path", captureFrom: "stdout-last-line" },
    params: z.object({
      databaseName: z.string(),
      retentionDays: z.number().default(30),
    }),
  },
  {
    id: "db/restore",
    category: "db",
    description: "Restore a Postgres database from a backup",
    locus: "target",
    requiresLock: true,
    dangerLevel: "high",
    params: z.object({
      databaseName: z.string(),
      backupPath: z.string(),
    }),
  },
  // docker/*
  {
    id: "docker/cleanup",
    category: "docker",
    description: "Prune unused Docker resources",
    locus: "target",
    params: z.object({ includeImages: z.boolean().default(true) }),
  },
  // monitoring/*
  {
    id: "monitoring/security-audit",
    category: "monitoring",
    description: "Run security audit",
    locus: "target",
    params: z.object({}),
  },
  // server-ops/*
  {
    id: "server-ops/health-check",
    category: "server-ops",
    description: "Check system health",
    locus: "target",
    params: z.object({}),
  },
];
