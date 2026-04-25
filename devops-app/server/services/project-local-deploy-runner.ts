/**
 * Feature 007: pre-insert wrapper around `scriptsRunner.runScript` for the
 * `deploy/project-local-deploy` dispatch.
 *
 * Why a wrapper exists:
 *   The inherited feature-005 runner flow is `parse → acquireLock → insert
 *   script_runs`. A ZodError on parse — OR any earlier exception (lock
 *   contention, DB error, network failure) — throws BEFORE the row is
 *   written. That violates SC-007 ("a failed runtime validation MUST leave a
 *   `script_runs` row with status=failed for forensics"). This wrapper:
 *
 *     1. Allocates a runId + INSERTs a pending row up-front.
 *     2. Calls scriptsRunner with `reuseRunId` so the runner UPDATEs the
 *        same row on success/failure (single canonical row, no duplicates).
 *     3. On ANY caught exception, conditionally UPDATEs the row to `failed`
 *        only if it is still `pending` (`WHERE id=:runId AND status='pending'`).
 *        Conditional clause prevents overwriting the runner's own terminal
 *        status write in the race where the runner transitions
 *        `pending → running` and then throws (runner owns the final write).
 *
 * Concurrency invariant: exactly one writer transitions any given row out of
 * `pending`. The conditional WHERE makes the wrapper UPDATE idempotent vs the
 * runner's lifecycle writes.
 */

import { randomUUID } from "node:crypto";
import path from "node:path";
import { ZodError } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { scriptRuns } from "../db/schema.js";
import { scriptsRunner } from "./scripts-runner.js";
import { logger } from "../lib/logger.js";

const LOG_DIR = process.env.LOG_DIR ?? "/app/data/logs";

export class ProjectLocalValidationError extends Error {
  public readonly runId: string;
  constructor(message: string, opts: { runId: string }) {
    super(message);
    this.name = "ProjectLocalValidationError";
    this.runId = opts.runId;
  }
}

export interface DispatchProjectLocalDeployInput {
  scriptId: "deploy/project-local-deploy";
  serverId: string;
  params: Record<string, unknown>;
  userId: string;
  deploymentId: string;
}

export interface DispatchProjectLocalDeployResult {
  runId: string;
  jobId: string;
}

export async function dispatchProjectLocalDeploy(
  input: DispatchProjectLocalDeployInput,
): Promise<DispatchProjectLocalDeployResult> {
  const { scriptId, serverId, params, userId, deploymentId } = input;
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  // Tentative log path; runner refreshes it once the job is allocated.
  const logFilePath = path.join(LOG_DIR, `${runId}.log`);

  await db.insert(scriptRuns).values({
    id: runId,
    scriptId,
    serverId,
    deploymentId,
    userId,
    // Raw pre-parse input (FR-014: scriptPath is non-secret). Mask happens
    // inside the runner once Zod parses successfully.
    params,
    status: "pending",
    startedAt,
    logFilePath,
  });

  try {
    const result = await scriptsRunner.runScript(
      scriptId,
      serverId,
      params,
      userId,
      { linkDeploymentId: deploymentId, reuseRunId: runId },
    );
    return { runId: result.runId, jobId: result.jobId };
  } catch (err) {
    const isZod = err instanceof ZodError;
    const msg = isZod
      ? `scriptPath failed runtime validation: ${err.issues[0]?.message ?? "invalid"}`
      : `Deploy dispatch failed: ${err instanceof Error ? err.message : String(err)}`;

    try {
      await db
        .update(scriptRuns)
        .set({
          status: "failed",
          errorMessage: msg,
          finishedAt: new Date().toISOString(),
        })
        .where(
          and(eq(scriptRuns.id, runId), eq(scriptRuns.status, "pending")),
        );
    } catch (updErr) {
      logger.error(
        { ctx: "project-local-deploy-runner", runId, err: updErr },
        "Failed to update script_runs row on dispatch failure",
      );
    }

    if (isZod) throw new ProjectLocalValidationError(msg, { runId });
    throw err;
  }
}
