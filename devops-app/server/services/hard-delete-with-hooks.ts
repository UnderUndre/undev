/**
 * Feature 010 T010 + T016 — pre_destroy hook decorator.
 *
 * Wraps the existing hard-delete flows (feature 008 inline `apps.ts` route,
 * feature 009 `bootstrap-orchestrator.hardDelete`) without modifying them:
 *
 *   1. Load the app row.
 *   2. If `force === true`, audit `app.hard_deleted_force_bypass` with the
 *      bypassed hook path, skip the hook, delegate.
 *   3. Else if `preDestroyScriptPath` is non-NULL, dispatch the hook over
 *      SSH (same env exports as deploy hooks). On non-zero exit, throw
 *      `PreDestroyHookFailed` (route maps to 422 `pre_destroy_hook_failed`).
 *   4. Delegate to the appropriate inline-delete based on `created_via`.
 *
 * The inline-delete is passed in as a `delegate` callback so this module
 * stays test-friendly and avoids dragging in feature 008's route handler.
 */

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { applications, auditEntries } from "../db/schema.js";
import { sshPool } from "./ssh-pool.js";
import { shQuote } from "../lib/sh-quote.js";
import { logger } from "../lib/logger.js";

export type HardDeleteDelegate = (args: {
  appId: string;
  app: {
    id: string;
    name: string;
    serverId: string;
    remotePath: string;
    createdVia: string;
  };
  userId: string;
}) => Promise<HardDeleteOutcome>;

export interface HardDeleteOutcome {
  removed: {
    remotePath: string;
    extra?: Record<string, unknown>;
  };
}

export interface HardDeleteWithHooksOptions {
  /**
   * When true, skip the pre_destroy hook entirely and audit the bypass.
   * Surfaced via `?force=true` on the route per Session 2026-05-05 GE-2.
   */
  force?: boolean;
}

export class PreDestroyHookFailed extends Error {
  override readonly name = "PreDestroyHookFailed";
  readonly code = "pre_destroy_hook_failed" as const;
  constructor(
    public readonly hookPath: string,
    public readonly exitCode: number,
    public readonly sshStderr: string,
  ) {
    super(`pre_destroy hook ${hookPath} exited ${exitCode}`);
  }
}

interface HookExecutor {
  exec: typeof sshPool.exec;
}

const defaultExecutor: HookExecutor = { exec: sshPool.exec.bind(sshPool) };

/**
 * Run the pre_destroy hook. Returns exit code; never throws — caller
 * decides how to react.
 */
async function runPreDestroyHook(
  serverId: string,
  remotePath: string,
  hookPath: string,
  exec: HookExecutor,
): Promise<{ exitCode: number; stderr: string }> {
  // Hook receives APP_DIR as env; same convention as deploy hooks.
  const cmd = `cd ${shQuote(remotePath)} && APP_DIR=${shQuote(remotePath)} bash ${shQuote(hookPath)}`;
  try {
    const result = await exec.exec(serverId, cmd, 60_000);
    return { exitCode: result.exitCode, stderr: result.stderr };
  } catch (err) {
    return {
      exitCode: -1,
      stderr: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function hardDeleteWithHooks(
  appId: string,
  userId: string,
  delegate: HardDeleteDelegate,
  options: HardDeleteWithHooksOptions = {},
  exec: HookExecutor = defaultExecutor,
): Promise<HardDeleteOutcome> {
  const [app] = await db
    .select({
      id: applications.id,
      name: applications.name,
      serverId: applications.serverId,
      remotePath: applications.remotePath,
      createdVia: applications.createdVia,
      preDestroyScriptPath: applications.preDestroyScriptPath,
    })
    .from(applications)
    .where(eq(applications.id, appId))
    .limit(1);
  if (!app) {
    throw new PreDestroyHookFailed("(unknown)", -1, "app not found");
  }

  const force = options.force === true;
  const hookPath = app.preDestroyScriptPath;

  if (force && hookPath) {
    // Audit force-bypass BEFORE delegate runs (per R-008a forensic ordering).
    await db.insert(auditEntries).values({
      id: randomUUID(),
      userId,
      action: "app.hard_deleted_force_bypass",
      targetType: "application",
      targetId: appId,
      details: JSON.stringify({
        skippedHookPath: hookPath,
        skipReason: "operator_force_bypass",
      }),
      result: "success",
      timestamp: new Date().toISOString(),
    });
    logger.warn(
      { ctx: "hard-delete-with-hooks", appId, hookPath },
      "pre_destroy hook bypassed via force=true",
    );
  } else if (hookPath) {
    const { exitCode, stderr } = await runPreDestroyHook(
      app.serverId,
      app.remotePath,
      hookPath,
      exec,
    );
    if (exitCode !== 0) {
      logger.warn(
        { ctx: "hard-delete-with-hooks", appId, hookPath, exitCode },
        "pre_destroy hook failed; aborting hard-delete",
      );
      throw new PreDestroyHookFailed(hookPath, exitCode, stderr);
    }
  }

  return delegate({
    appId,
    app: {
      id: app.id,
      name: app.name,
      serverId: app.serverId,
      remotePath: app.remotePath,
      createdVia: app.createdVia,
    },
    userId,
  });
}
