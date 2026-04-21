/**
 * Feature 005: Universal Scripts Runner.
 *
 * The domain runner on top of `sshExecutor` (SSH plumbing) + `jobManager`
 * (in-process lifecycle) + `deployLock` (feature 004 advisory lock) +
 * `scripts-manifest` + `scripts/common.sh` + `scripts/<category>/<name>.sh`.
 *
 * Flow of `runScript`:
 *   1. Manifest lookup → ScriptNotFoundError / invalid entry → 404 / 400
 *   2. Zod parse of params → ZodError → 400
 *   3. If `requiresLock`: deployLock.acquireLock → false → DeploymentLockedError (409)
 *   4. Mask secrets → persist `script_runs` row (status=pending)
 *   5. Serialise params → argv + envExports
 *   6. Build bash buffer from common.sh + target.sh + preamble (envExports,
 *      YES=true, CI=true, source-override functions)
 *   7. sshExecutor.executeWithStdin("bash -s -- <args>", buffer)  ← invariant command
 *   8. Wire jobManager.onJobEvent to terminal-status DB update + optional
 *      deployments linked update + lock release
 */

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { scriptRuns, deployments } from "../db/schema.js";
import { sshExecutor } from "./ssh-executor.js";
import { jobManager } from "./job-manager.js";
import { deployLock } from "./deploy-lock.js";
import { sshPool } from "./ssh-pool.js";
import { logger } from "../lib/logger.js";
import { shQuote } from "../lib/sh-quote.js";
import {
  manifest,
  CATEGORY_FOLDER_MAP,
  type ScriptManifestEntry,
} from "../scripts-manifest.js";
import { extractFieldDescriptors, type FieldDescriptor } from "../lib/zod-descriptor.js";
import { serialiseParams } from "../lib/serialise-params.js";
import { maskSecrets } from "../lib/mask-secrets.js";
import { buildTransportBuffer } from "../lib/common-sh-concat.js";

const SCRIPTS_ROOT = process.env.SCRIPTS_ROOT ?? "/app/scripts";
const DEFAULT_TIMEOUT_MS = 1_800_000; // 30 min
const LOG_DIR = process.env.LOG_DIR ?? "/app/data/logs";

export class ScriptNotFoundError extends Error {
  constructor(public scriptId: string) {
    super(`Script not found: ${scriptId}`);
    this.name = "ScriptNotFoundError";
  }
}

export class InvalidManifestEntryError extends Error {
  constructor(public scriptId: string, public validationError: string) {
    super(`Manifest entry invalid: ${scriptId} — ${validationError}`);
    this.name = "InvalidManifestEntryError";
  }
}

export class DuplicateManifestIdError extends Error {
  constructor(public scriptId: string) {
    super(`Duplicate manifest id: ${scriptId}`);
    this.name = "DuplicateManifestIdError";
  }
}

export class DeploymentLockedError extends Error {
  constructor(public lockedBy: unknown) {
    super("Another operation is in progress on this server");
    this.name = "DeploymentLockedError";
  }
}

export interface ManifestDescriptor {
  id: string;
  category: string;
  description: string;
  locus: string;
  requiresLock: boolean;
  timeout?: number;
  dangerLevel?: string;
  outputArtifact?: { type: string; captureFrom: string };
  fields: FieldDescriptor[];
  valid: boolean;
  validationError: string | null;
}

export interface RunScriptOptions {
  linkDeploymentId?: string;
}

export interface RunScriptResult {
  runId: string;
  jobId: string;
}

interface ValidatedEntry {
  entry: ScriptManifestEntry;
  descriptor: ManifestDescriptor;
}

/**
 * In-memory annotated manifest cache, populated by validateManifestLenient()
 * at startup. POST /api/scripts/<id>/run consults this; entries flagged
 * valid:false return 400 INVALID_MANIFEST_ENTRY.
 */
let cache: Map<string, ValidatedEntry> | null = null;

function scriptFilePath(entry: ScriptManifestEntry): string {
  const folder = CATEGORY_FOLDER_MAP[entry.category];
  const name = entry.id.split("/")[1];
  return path.join(SCRIPTS_ROOT, folder, `${name}.sh`);
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await readFile(p);
    return true;
  } catch {
    return false;
  }
}

function validateEntry(entry: ScriptManifestEntry): {
  descriptor: ManifestDescriptor;
  error: string | null;
} {
  let error: string | null = null;
  let fields: FieldDescriptor[] = [];
  try {
    // locus=target entries MUST have a ZodObject params (R-009).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = entry.params as any;
    const zodType = p?.def?.type ?? p?._def?.type ?? p?._def?.typeName;
    const isObject =
      zodType === "object" || zodType === "ZodObject" || Boolean(p?.shape);
    if (entry.locus === "target" && !isObject) {
      error = `locus=target entry must have ZodObject params (got ${zodType ?? "unknown"})`;
    } else {
      fields = extractFieldDescriptors(entry.params);
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  const descriptor: ManifestDescriptor = {
    id: entry.id,
    category: entry.category,
    description: entry.description,
    locus: entry.locus,
    requiresLock: Boolean(entry.requiresLock),
    timeout: entry.timeout,
    dangerLevel: entry.dangerLevel,
    outputArtifact: entry.outputArtifact,
    fields,
    valid: error === null,
    validationError: error,
  };
  return { descriptor, error };
}

class ScriptsRunner {
  /**
   * CI-gate helper (T022): throws on any failure. Used by the manifest unit
   * test to block PR merge on a broken manifest.
   */
  async validateManifestStrict(): Promise<void> {
    const ids = new Set<string>();
    for (const entry of manifest) {
      if (ids.has(entry.id)) {
        throw new DuplicateManifestIdError(entry.id);
      }
      ids.add(entry.id);

      const { error } = validateEntry(entry);
      if (error) throw new InvalidManifestEntryError(entry.id, error);

      if (entry.locus === "target") {
        const p = scriptFilePath(entry);
        if (!(await fileExists(p))) {
          throw new InvalidManifestEntryError(
            entry.id,
            `Script file missing: ${p}`,
          );
        }
      }
    }
  }

  /**
   * Runtime helper: annotates each entry with {valid, validationError}. Throws
   * ONLY on duplicate id (ambiguous dispatch). Other per-entry failures are
   * flagged in the cache and later surface as 400 INVALID_MANIFEST_ENTRY.
   */
  async validateManifestLenient(): Promise<void> {
    const map = new Map<string, ValidatedEntry>();
    for (const entry of manifest) {
      if (map.has(entry.id)) {
        throw new DuplicateManifestIdError(entry.id);
      }

      const { descriptor, error } = validateEntry(entry);
      let valid = error === null;
      let validationError = error;

      if (valid && entry.locus === "target") {
        const p = scriptFilePath(entry);
        if (!(await fileExists(p))) {
          valid = false;
          validationError = `Script file missing: ${p}`;
        }
      }

      if (!valid) {
        logger.warn(
          { ctx: "scripts-manifest", scriptId: entry.id, validationError },
          "Manifest entry flagged invalid",
        );
      }

      descriptor.valid = valid;
      descriptor.validationError = validationError;
      map.set(entry.id, { entry, descriptor });
    }
    cache = map;
  }

  getManifestDescriptor(): ManifestDescriptor[] {
    if (!cache) return manifest.map((e) => validateEntry(e).descriptor);
    return [...cache.values()].map((v) => v.descriptor);
  }

  async runScript(
    scriptId: string,
    serverId: string,
    params: Record<string, unknown>,
    userId: string,
    options: RunScriptOptions = {},
  ): Promise<RunScriptResult> {
    const validated = cache?.get(scriptId);
    const entry = validated?.entry ?? manifest.find((e) => e.id === scriptId);
    if (!entry) throw new ScriptNotFoundError(scriptId);
    if (validated && !validated.descriptor.valid) {
      throw new InvalidManifestEntryError(
        scriptId,
        validated.descriptor.validationError ?? "invalid",
      );
    }

    // Zod-parse — throws ZodError, route layer maps to 400.
    const parsed = entry.params.parse(params) as Record<string, unknown>;

    // Acquire deploy lock if required.
    const lockAcquired = entry.requiresLock ?? false;
    if (lockAcquired) {
      const ok = await deployLock.acquireLock(serverId, scriptId);
      if (!ok) {
        const owner = await deployLock.checkLock(serverId);
        throw new DeploymentLockedError(owner);
      }
    }

    const runId = randomUUID();
    // Ensure SSH connection exists (best-effort — falls through to the
    // caller who already established it; in tests sshPool is mocked).
    if (!sshPool.isConnected(serverId)) {
      logger.info(
        { ctx: "scripts-runner", scriptId, serverId, runId },
        "No active SSH connection; relying on caller-established pool entry",
      );
    }

    const maskedParams = maskSecrets(entry.params, parsed);
    const startedAt = new Date().toISOString();

    // Create a jobManager job first so the log-file path is deterministic.
    const job = jobManager.createJob("script-run", serverId, {
      scriptId,
      runId,
    });
    const logFilePath =
      (job.metadata.logFilePath as string | undefined) ??
      path.join(LOG_DIR, `${job.id}.log`);

    try {
      await db.insert(scriptRuns).values({
        id: runId,
        scriptId,
        serverId,
        deploymentId: options.linkDeploymentId ?? null,
        userId,
        params: maskedParams,
        status: "pending",
        startedAt,
        logFilePath,
      });
    } catch (err) {
      // Insert failure is fatal for the run — release the lock + fail the job.
      if (lockAcquired) await deployLock.releaseLock(serverId).catch((releaseErr) => logger.error({ ctx: "scripts-runner", serverId, err: releaseErr }, "Failed to release deploy lock"));
      jobManager.failJob(
        job.id,
        err instanceof Error ? err.message : "Failed to persist script_runs row",
      );
      throw err;
    }

    // Serialise + transport.
    const { args, envExports } = serialiseParams(entry.params, parsed);
    const commonShPath = path.join(SCRIPTS_ROOT, "common.sh");
    const targetPath = scriptFilePath(entry);

    let commonSh = "";
    let targetSh = "";
    try {
      commonSh = await readFile(commonShPath, "utf8");
      targetSh = await readFile(targetPath, "utf8");
    } catch (err) {
      if (lockAcquired) await deployLock.releaseLock(serverId).catch((releaseErr) => logger.error({ ctx: "scripts-runner", serverId, err: releaseErr }, "Failed to release deploy lock"));
      jobManager.failJob(
        job.id,
        `Failed to read script sources: ${err instanceof Error ? err.message : String(err)}`,
      );
      await this.persistTerminalStatus(
        runId,
        "failed",
        err instanceof Error ? err.message : "Failed to read script sources",
      );
      throw err;
    }

    const buffer = buildTransportBuffer({ commonSh, targetSh, envExports });
    const command = `bash -s -- ${args.join(" ")}`.trimEnd();

    // Timeout via AbortController (FR-017 layered guard).
    const timeoutMs = entry.timeout ?? DEFAULT_TIMEOUT_MS;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeoutMs).unref?.() ?? null;
    let timedOut = false;
    abort.signal.addEventListener("abort", () => {
      timedOut = true;
    });

    // Mark as running.
    await db
      .update(scriptRuns)
      .set({ status: "running" })
      .where(eq(scriptRuns.id, runId));

    // Wire terminal status → DB + optional deployments linked row + lock release.
    const started = Date.now();
    const unsubscribe = jobManager.onJobEvent(job.id, (_, event) => {
      if (event.type !== "status") return;
      const status = (event.data as { status: string }).status;
      if (
        status !== "success" &&
        status !== "failed" &&
        status !== "cancelled"
      ) {
        return;
      }

      void (async () => {
        try {
          const finalStatus = timedOut ? "timeout" : status;
          const errorMessage =
            finalStatus === "timeout"
              ? `Script timed out after ${timeoutMs}ms`
              : finalStatus === "failed"
                ? jobManager.getJob(job.id)?.errorMessage ?? null
                : null;
          const duration = Date.now() - started;
          const exitCode = finalStatus === "success" ? 0 : null;

          await this.persistTerminalStatus(
            runId,
            finalStatus,
            errorMessage,
            duration,
            exitCode,
          );

          if (options.linkDeploymentId) {
            await db
              .update(deployments)
              .set({
                status: finalStatus === "timeout" ? "failed" : finalStatus,
                finishedAt: new Date().toISOString(),
                errorMessage: errorMessage ?? undefined,
              })
              .where(eq(deployments.id, options.linkDeploymentId));
          }
        } catch (err) {
          logger.error(
            { ctx: "scripts-runner", runId, err },
            "Terminal status persistence failed",
          );
        } finally {
          if (timer) clearTimeout(timer);
          if (lockAcquired) {
            await deployLock.releaseLock(serverId).catch((releaseErr) => logger.error({ ctx: "scripts-runner", serverId, err: releaseErr }, "Failed to release deploy lock"));
          }
          unsubscribe();
        }
      })();
    });

    // Fire exec — don't await. runScript returns immediately after insert.
    sshExecutor
      .executeWithStdin(serverId, command, buffer, job.id, {
        signal: abort.signal,
      })
      .catch((err) => {
        jobManager.failJob(
          job.id,
          err instanceof Error ? err.message : String(err),
        );
      });

    logger.info(
      { ctx: "scripts-runner", scriptId, serverId, userId, runId, status: "running" },
      "Script run dispatched",
    );

    return { runId, jobId: job.id };
  }

  /**
   * R-010: retention prune. Deletes rows older than SCRIPT_RUNS_RETENTION_DAYS
   * (default 90) and unlinks log files ONLY for standalone runs
   * (deployment_id IS NULL) — deploy runs share their log with the
   * deployments row, which is the authoritative owner per feature 001.
   */
  async pruneOldRuns(): Promise<{
    deletedRows: number;
    deletedLogFiles: number;
  }> {
    const retentionDays = Number(process.env.SCRIPT_RUNS_RETENTION_DAYS ?? 90);
    const rows = await db.execute<{ owned_log_path: string | null }>(sql`
      DELETE FROM script_runs
      WHERE started_at::timestamptz < NOW() - (${retentionDays}::int || ' days')::interval
      RETURNING
        CASE WHEN deployment_id IS NULL THEN log_file_path ELSE NULL END
          AS owned_log_path
    `);

    // drizzle+postgres-js returns a result whose iteration shape varies across
    // minor versions — normalise without `as any`: the raw shape is either an
    // array or `{ rows: [...] }`, and we narrow via typed guards.
    type PruneRow = { owned_log_path: string | null };
    const raw = rows as unknown;
    const arr: PruneRow[] = Array.isArray(raw)
      ? (raw as PruneRow[])
      : raw &&
          typeof raw === "object" &&
          Array.isArray((raw as { rows?: unknown }).rows)
        ? ((raw as { rows: PruneRow[] }).rows)
        : [];
    const { unlink } = await import("node:fs/promises");
    let deletedLogFiles = 0;
    for (const r of arr) {
      if (!r.owned_log_path) continue;
      try {
        await unlink(r.owned_log_path);
        deletedLogFiles++;
      } catch (err) {
        // ENOENT is fine — file already gone. Everything else we log.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if ((err as any)?.code !== "ENOENT") {
          logger.warn(
            { ctx: "scripts-runner-prune", path: r.owned_log_path, err },
            "Log unlink failed",
          );
        }
      }
    }
    return { deletedRows: arr.length, deletedLogFiles };
  }

  /**
   * Background retention timer — call from server/index.ts. Disables when
   * SCRIPT_RUNS_PRUNE_INTERVAL_MS=0.
   */
  private pruneTimer: NodeJS.Timeout | null = null;

  start(): void {
    const interval = Number(
      process.env.SCRIPT_RUNS_PRUNE_INTERVAL_MS ?? 24 * 3600 * 1000,
    );
    if (interval <= 0) return;
    this.pruneTimer = setInterval(() => {
      void this.pruneOldRuns().catch((err) =>
        logger.warn({ ctx: "scripts-runner-prune", err }, "Periodic prune failed"),
      );
    }, interval);
    this.pruneTimer.unref();
  }

  stop(): void {
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = null;
    }
  }

  private async persistTerminalStatus(
    runId: string,
    status: string,
    errorMessage: string | null,
    duration?: number,
    exitCode?: number | null,
  ): Promise<void> {
    await db
      .update(scriptRuns)
      .set({
        status,
        finishedAt: new Date().toISOString(),
        ...(duration !== undefined ? { duration } : {}),
        ...(exitCode !== undefined && exitCode !== null ? { exitCode } : {}),
        ...(errorMessage !== null ? { errorMessage } : {}),
      })
      .where(eq(scriptRuns.id, runId));
  }
}

// Re-export shQuote so downstream consumers have a single import site.
export { shQuote };

export const scriptsRunner = new ScriptsRunner();
