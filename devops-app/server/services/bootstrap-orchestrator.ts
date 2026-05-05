/**
 * Feature 009 T011/T020/T021/T022 — bootstrap state-machine driver.
 *
 * Owns the entire INIT → ACTIVE chain (and every failed_<step> branch).
 *
 *   - State transitions go through `canTransition` only — single source of
 *     truth for both forward (success) and retry-from-failed paths.
 *   - Every transition writes a row to `app_bootstrap_events` in the SAME
 *     transaction as the `applications.bootstrap_state` update (R-012),
 *     then broadcasts WS `bootstrap.state-changed` AFTER commit.
 *   - Step dispatch goes through `scriptsRunner.runScript` — that gives us
 *     deploy-lock, terminal-status persistence, log-streaming for free.
 *   - Failure path: classify via `pat-error-classifier` for clone errors
 *     (FR-016a) so PAT-expired surfaces a distinct state; everything else
 *     writes generic `failed_<step>` and fires Telegram.
 */

import { randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { applications, appBootstrapEvents, githubConnection, scriptRuns } from "../db/schema.js";
import { logger } from "../lib/logger.js";
import { jobManager, type JobEvent } from "./job-manager.js";
import { scriptsRunner } from "./scripts-runner.js";
import { sshPool } from "./ssh-pool.js";
import { resolveAndJailCheck } from "../lib/path-jail.js";
import { validateComposePath } from "../lib/validate-compose-path.js";
import { classifyPatError } from "../lib/pat-error-classifier.js";
import { scrubPatFromText } from "../lib/pat-redact.js";
import { BootstrapStateError, PathJailEscapeError } from "../lib/bootstrap-errors.js";
import { channelManager } from "../ws/channels.js";
import { notifier } from "./notifier.js";

export {
  canTransition,
  type BootstrapState,
  type BootstrapStep,
} from "../lib/bootstrap-state-machine.js";
import { canTransition, type BootstrapState, type BootstrapStep } from "../lib/bootstrap-state-machine.js";

interface AppRow {
  id: string;
  serverId: string;
  name: string;
  repoUrl: string;
  branch: string;
  remotePath: string;
  composePath: string;
  domain: string | null;
  upstreamService: string | null;
  upstreamPort: number | null;
  bootstrapState: string;
  githubRepo: string | null;
}

async function loadApp(appId: string): Promise<AppRow | null> {
  const [row] = await db
    .select({
      id: applications.id,
      serverId: applications.serverId,
      name: applications.name,
      repoUrl: applications.repoUrl,
      branch: applications.branch,
      remotePath: applications.remotePath,
      composePath: applications.composePath,
      domain: applications.domain,
      upstreamService: applications.upstreamService,
      upstreamPort: applications.upstreamPort,
      bootstrapState: applications.bootstrapState,
      githubRepo: applications.githubRepo,
    })
    .from(applications)
    .where(eq(applications.id, appId))
    .limit(1);
  return row ?? null;
}

async function fetchPat(): Promise<string | null> {
  const [row] = await db
    .select({ token: githubConnection.token })
    .from(githubConnection)
    .where(eq(githubConnection.id, "DEFAULT"))
    .limit(1);
  return row?.token ?? null;
}

interface TransitionMetadata {
  [key: string]: unknown;
}

/**
 * Atomic state-machine transition. Validates, writes the event row + the
 * applications update in one DB transaction, then broadcasts the WS event
 * AFTER commit (R-012). Throws BootstrapStateError on forbidden transitions.
 */
async function transition(
  appId: string,
  fromState: BootstrapState,
  toState: BootstrapState,
  actor: string,
  metadata: TransitionMetadata = {},
): Promise<void> {
  if (!canTransition(fromState, toState)) {
    throw new BootstrapStateError(fromState, toState);
  }

  const occurredAt = new Date().toISOString();
  const eventId = randomUUID();

  await db.transaction(async (tx) => {
    const updated = await tx
      .update(applications)
      .set({ bootstrapState: toState })
      .where(
        and(eq(applications.id, appId), eq(applications.bootstrapState, fromState)),
      )
      .returning({ id: applications.id });
    if (updated.length === 0) {
      // CAS lost — somebody else (reconciler? race?) advanced state. Bail.
      throw new BootstrapStateError(
        fromState,
        toState,
        `CAS failed: app ${appId} no longer in ${fromState}`,
      );
    }
    await tx.insert(appBootstrapEvents).values({
      id: eventId,
      appId,
      fromState,
      toState,
      occurredAt,
      metadata,
      actor,
    });
  });

  channelManager.broadcast("bootstrap", {
    type: "bootstrap.state-changed",
    appId,
    fromState,
    toState,
    occurredAt,
    actor,
    metadata,
  });
}

interface JobResult {
  status: "success" | "failed" | "cancelled" | "timeout";
  errorMessage: string | null;
}

function awaitJobTerminal(
  appId: string,
  scriptId: string,
  runId: string,
  jobId: string,
): Promise<JobResult> {
  return new Promise((resolve) => {
    const unsubscribe = jobManager.onJobEvent(jobId, (_, event: JobEvent) => {
      if (event.type === "log") {
        // T022 — broadcast each log line on `bootstrap` channel.
        const line = (event.data as { message?: string }).message ?? "";
        channelManager.broadcast("bootstrap", {
          type: "bootstrap.step-log",
          appId,
          runId,
          scriptId,
          stream: "stdout",
          line,
        });
        return;
      }
      if (event.type !== "status") return;
      const status = (event.data as { status: string }).status;
      if (status !== "success" && status !== "failed" && status !== "cancelled") {
        return;
      }
      const job = jobManager.getJob(jobId);
      const errorMessage = job?.errorMessage ?? null;
      unsubscribe();
      resolve({
        status: status as JobResult["status"],
        errorMessage,
      });
    });
  });
}

class BootstrapOrchestrator {
  /** INIT → CLONING dispatch. */
  async start(appId: string, userId: string): Promise<void> {
    const app = await loadApp(appId);
    if (!app) {
      logger.warn({ ctx: "bootstrap-orchestrator", appId }, "start: app not found");
      return;
    }
    if (app.bootstrapState !== "init") {
      logger.warn(
        { ctx: "bootstrap-orchestrator", appId, state: app.bootstrapState },
        "start called on non-init app",
      );
      return;
    }
    void this.runChain(app, "cloning", userId).catch((err) => {
      logger.error(
        { ctx: "bootstrap-orchestrator", appId, err },
        "Bootstrap chain crashed",
      );
    });
  }

  /** Resume from `failed_<step>` at `fromStep`. */
  async retryFromFailedStep(
    appId: string,
    fromStep: BootstrapStep,
    userId: string,
  ): Promise<void> {
    const app = await loadApp(appId);
    if (!app) {
      logger.warn({ ctx: "bootstrap-orchestrator", appId }, "retry: app not found");
      return;
    }
    if (!canTransition(app.bootstrapState as BootstrapState, fromStep)) {
      throw new BootstrapStateError(app.bootstrapState, fromStep);
    }
    await transition(appId, app.bootstrapState as BootstrapState, fromStep, userId, {
      reason: "manual_retry",
    });
    const fresh = await loadApp(appId);
    if (!fresh) return;
    void this.runChain(fresh, fromStep, userId).catch((err) => {
      logger.error(
        { ctx: "bootstrap-orchestrator", appId, err },
        "Retry chain crashed",
      );
    });
  }

  canTransition(from: BootstrapState, to: BootstrapState): boolean {
    return canTransition(from, to);
  }

  /**
   * Drive the chain forward starting at `step`. Each step is a separate
   * scriptsRunner.runScript call; we await the job's terminal status, then
   * either advance to the next step or land in failed_<step>.
   *
   * Note: each phase reloads `applications` so external edits (Edit Config
   * during a stalled state) take effect on resume.
   */
  private async runChain(
    initial: AppRow,
    startAt: BootstrapStep,
    userId: string,
  ): Promise<void> {
    let app = initial;
    let step: BootstrapStep | "done" = startAt;

    while (step !== "done") {
      const fresh = await loadApp(app.id);
      if (!fresh) return;
      app = fresh;

      if (step === "cloning") {
        const ok = await this.runClone(app, userId);
        if (!ok) return;
        step = "compose_up";
        continue;
      }
      if (step === "compose_up") {
        const ok = await this.runComposeUp(app, userId);
        if (!ok) return;
        step = "healthcheck";
        continue;
      }
      if (step === "healthcheck") {
        const ok = await this.runHealthcheck(app, userId);
        if (!ok) return;
        step = app.domain ? "proxy_applied" : "done";
        if (step === "done") {
          await this.runFinalise(app, userId);
        }
        continue;
      }
      if (step === "proxy_applied") {
        // Feature 008's reconciler handles the actual Caddy push; here we
        // just record the transition and let the reconciler reconcile.
        await transition(app.id, "healthcheck", "proxy_applied", userId, {});
        step = "cert_issued";
        continue;
      }
      if (step === "cert_issued") {
        // Feature 008's cert lifecycle owns the actual issuance — once the
        // cert is observed `ready` we transition to active. For now we
        // shortcut: assume domain handoff is async and finalise.
        await transition(app.id, "proxy_applied", "cert_issued", userId, {});
        await this.runFinalise(app, userId);
        step = "done";
        continue;
      }
      step = "done";
    }
  }

  private async runClone(app: AppRow, userId: string): Promise<boolean> {
    if (!app.githubRepo) {
      await this.failStep(app, "cloning", "Missing githubRepo on application", userId);
      return false;
    }
    const pat = await fetchPat();
    if (pat === null || pat === "") {
      await this.failStep(app, "cloning", "GitHub connection missing PAT", userId);
      return false;
    }

    let runId: string;
    let jobId: string;
    try {
      const result = await scriptsRunner.runScript(
        "bootstrap/clone",
        app.serverId,
        {
          appId: app.id,
          remotePath: app.remotePath,
          repoUrl: app.repoUrl,
          branch: app.branch,
          pat,
        },
        userId,
      );
      runId = result.runId;
      jobId = result.jobId;
    } catch (err) {
      await this.failStep(
        app,
        "cloning",
        err instanceof Error ? err.message : String(err),
        userId,
      );
      return false;
    }

    const term = await awaitJobTerminal(app.id, "bootstrap/clone", runId, jobId);
    if (term.status === "success") {
      logger.info({ ctx: "bootstrap-orchestrator", appId: app.id, runId }, "clone succeeded");
      return true;
    }

    const stderr = await this.fetchRunStderr(runId);
    const classified = classifyPatError({
      stderr,
      exitCode: 1,
    });
    const errorMessage = scrubPatFromText(term.errorMessage ?? classified.message);
    if (classified.kind === "pat_expired") {
      await transition(app.id, "cloning", "failed_clone_pat_expired", userId, {
        runId,
        errorKind: "pat_expired",
        errorMessage,
      });
    } else {
      await transition(app.id, "cloning", "failed_clone", userId, {
        runId,
        errorKind: classified.kind,
        errorMessage,
      });
    }
    await this.notifyFailure(app, "cloning", errorMessage);
    return false;
  }

  private async runComposeUp(app: AppRow, userId: string): Promise<boolean> {
    // FR-020a layer-3: re-validate composePath right before SSH command construction.
    const guard = validateComposePath(app.composePath);
    if (!guard.ok) {
      await this.failStep(
        app,
        "compose_up",
        `composePath rejected by validator: ${guard.message}`,
        userId,
      );
      return false;
    }

    let runId: string;
    let jobId: string;
    try {
      const result = await scriptsRunner.runScript(
        "bootstrap/compose-up",
        app.serverId,
        { appId: app.id, remotePath: app.remotePath, composePath: app.composePath },
        userId,
      );
      runId = result.runId;
      jobId = result.jobId;
    } catch (err) {
      await this.failStep(
        app,
        "compose_up",
        err instanceof Error ? err.message : String(err),
        userId,
      );
      return false;
    }

    const term = await awaitJobTerminal(app.id, "bootstrap/compose-up", runId, jobId);
    if (term.status === "success") return true;
    const errorMessage = term.errorMessage ?? "compose-up failed";
    await transition(app.id, "compose_up", "failed_compose", userId, {
      runId,
      errorMessage,
    });
    await this.notifyFailure(app, "compose_up", errorMessage);
    return false;
  }

  private async runHealthcheck(app: AppRow, userId: string): Promise<boolean> {
    if (!app.upstreamService) {
      // No service to inspect → skip silently per FR-011.
      return true;
    }

    let runId: string;
    let jobId: string;
    try {
      const result = await scriptsRunner.runScript(
        "bootstrap/wait-healthy",
        app.serverId,
        {
          appId: app.id,
          remotePath: app.remotePath,
          composePath: app.composePath,
          service: app.upstreamService,
          timeoutSeconds: 180,
        },
        userId,
      );
      runId = result.runId;
      jobId = result.jobId;
    } catch (err) {
      await this.failStep(
        app,
        "healthcheck",
        err instanceof Error ? err.message : String(err),
        userId,
      );
      return false;
    }

    const term = await awaitJobTerminal(app.id, "bootstrap/wait-healthy", runId, jobId);
    if (term.status === "success") return true;
    const errorMessage = term.errorMessage ?? "healthcheck failed";
    await transition(app.id, "healthcheck", "failed_healthcheck", userId, {
      runId,
      errorMessage,
    });
    await this.notifyFailure(app, "healthcheck", errorMessage);
    return false;
  }

  private async runFinalise(app: AppRow, userId: string): Promise<void> {
    let runId: string;
    let jobId: string;
    try {
      const result = await scriptsRunner.runScript(
        "bootstrap/finalise",
        app.serverId,
        { appId: app.id, remotePath: app.remotePath },
        userId,
      );
      runId = result.runId;
      jobId = result.jobId;
    } catch (err) {
      logger.warn(
        { ctx: "bootstrap-orchestrator", appId: app.id, err },
        "finalise dispatch failed — transitioning to active anyway",
      );
      await this.transitionToActive(app, userId, null);
      return;
    }

    await awaitJobTerminal(app.id, "bootstrap/finalise", runId, jobId);
    // Read current_commit from the run's outputArtifact.
    const [run] = await db
      .select({ outputArtifact: scriptRuns.outputArtifact })
      .from(scriptRuns)
      .where(eq(scriptRuns.id, runId))
      .limit(1);
    const artefact = run?.outputArtifact as { currentCommit?: string } | null | undefined;
    const currentCommit = artefact?.currentCommit ?? null;
    if (currentCommit) {
      await db
        .update(applications)
        .set({ currentCommit })
        .where(eq(applications.id, app.id));
    }
    await this.transitionToActive(app, userId, currentCommit);
  }

  private async transitionToActive(
    app: AppRow,
    userId: string,
    currentCommit: string | null,
  ): Promise<void> {
    const fresh = await loadApp(app.id);
    if (!fresh) return;
    if (fresh.bootstrapState === "active") return;
    await transition(app.id, fresh.bootstrapState as BootstrapState, "active", userId, {
      currentCommit,
    });
    await notifier
      .notify({
        serverId: app.serverId,
        event: "Bootstrap succeeded",
        details: `*${app.name}* is now ACTIVE${currentCommit ? ` @ \`${currentCommit.slice(0, 8)}\`` : ""}`,
      })
      .catch((err: unknown) => {
        logger.warn({ ctx: "bootstrap-orchestrator", err }, "Telegram notify failed");
      });
  }

  private async failStep(
    app: AppRow,
    step: BootstrapStep,
    errorMessage: string,
    userId: string,
  ): Promise<void> {
    const failedState =
      step === "cloning"
        ? "failed_clone"
        : step === "compose_up"
          ? "failed_compose"
          : step === "healthcheck"
            ? "failed_healthcheck"
            : step === "proxy_applied"
              ? "failed_proxy"
              : "failed_cert";
    const scrubbed = scrubPatFromText(errorMessage);
    try {
      await transition(app.id, app.bootstrapState as BootstrapState, failedState, userId, {
        errorMessage: scrubbed,
      });
    } catch (err) {
      logger.warn(
        { ctx: "bootstrap-orchestrator", appId: app.id, err },
        "transition to failed state failed",
      );
    }
    await this.notifyFailure(app, step, scrubbed);
  }

  private async notifyFailure(
    app: AppRow,
    step: BootstrapStep,
    errorMessage: string,
  ): Promise<void> {
    await notifier
      .notify({
        serverId: app.serverId,
        event: "Bootstrap failed",
        details: `*${app.name}* failed at ${step}: ${errorMessage}`,
      })
      .catch((err: unknown) => {
        logger.warn({ ctx: "bootstrap-orchestrator", err }, "Telegram notify failed");
      });
  }

  private async fetchRunStderr(runId: string): Promise<string> {
    const [row] = await db
      .select({ errorMessage: scriptRuns.errorMessage })
      .from(scriptRuns)
      .where(eq(scriptRuns.id, runId))
      .limit(1);
    return row?.errorMessage ?? "";
  }

  /**
   * T049 entry point — also exposed via routes/bootstrap.ts.
   * Ordered: cert revoke (delegated) → compose down → realpath jail check
   * → rm -rf via bootstrap/hard-delete → DELETE applications row.
   */
  async hardDelete(
    appId: string,
    confirmName: string,
    userId: string,
    jailRoot: string,
  ): Promise<{
    removed: { remotePath: string; resolved: string };
  }> {
    const app = await loadApp(appId);
    if (!app) {
      throw new BootstrapStateError("unknown", "hard_deleted", `App ${appId} not found`);
    }
    if (confirmName !== app.name) {
      throw new BootstrapStateError(app.bootstrapState, "hard_deleted", "CONFIRM_MISMATCH");
    }
    const exec = async (serverId: string, command: string) => {
      const { stdout, stderr, exitCode } = await sshPool.exec(serverId, command, 15_000);
      return { stdout, stderr, exitCode };
    };
    const jail = await resolveAndJailCheck(exec, app.serverId, app.remotePath, jailRoot);
    if (!jail.ok) {
      throw new PathJailEscapeError(app.remotePath, jailRoot);
    }
    // Dispatch hard-delete script.
    const { jobId } = await scriptsRunner.runScript(
      "bootstrap/hard-delete",
      app.serverId,
      {
        appId,
        remotePath: app.remotePath,
        composePath: app.composePath,
        jailRoot,
      },
      userId,
    );
    const term = await awaitJobTerminal(appId, "bootstrap/hard-delete", "hard-delete", jobId);
    if (term.status !== "success") {
      throw new Error(`hard-delete script failed: ${term.errorMessage ?? "unknown"}`);
    }
    // Append terminal event before delete (cascades will wipe events).
    const occurredAt = new Date().toISOString();
    await db.insert(appBootstrapEvents).values({
      id: randomUUID(),
      appId,
      fromState: app.bootstrapState,
      toState: "hard_deleted",
      occurredAt,
      metadata: { confirmedBy: userId, removedFrom: jail.resolved },
      actor: userId,
    });
    await db.delete(applications).where(eq(applications.id, appId));

    channelManager.broadcast("bootstrap", {
      type: "bootstrap.state-changed",
      appId,
      fromState: app.bootstrapState,
      toState: "hard_deleted",
      occurredAt,
      actor: userId,
      metadata: { resolved: jail.resolved },
    });

    return { removed: { remotePath: app.remotePath, resolved: jail.resolved } };
  }
}

export const bootstrapOrchestrator = new BootstrapOrchestrator();

/**
 * Helper for the GET /api/applications/:id/bootstrap-state route — returns
 * the current `script_runs` row that's running for the app, if any.
 *
 * Q4 in data-model.md says LATERAL JSONB_AGG; we keep the shape simple here
 * and let drizzle compose two SELECTs — the route is a low-traffic poll.
 */
export async function findCurrentRun(appId: string): Promise<{
  runId: string;
  scriptId: string;
  status: string;
  startedAt: string;
} | null> {
  const rows = await db
    .select({
      id: scriptRuns.id,
      scriptId: scriptRuns.scriptId,
      status: scriptRuns.status,
      startedAt: scriptRuns.startedAt,
      params: scriptRuns.params,
    })
    .from(scriptRuns)
    .where(
      and(
        eq(scriptRuns.status, "running"),
        sql`${scriptRuns.scriptId} LIKE 'bootstrap/%'`,
      ),
    )
    .orderBy(desc(scriptRuns.startedAt))
    .limit(20);
  for (const r of rows) {
    const params = r.params as { appId?: string } | null;
    if (params?.appId === appId) {
      return {
        runId: r.id,
        scriptId: r.scriptId,
        status: r.status,
        startedAt: r.startedAt,
      };
    }
  }
  return null;
}
