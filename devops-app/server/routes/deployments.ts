import { Router } from "express";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { db } from "../db/index.js";
import { deployments, applications, servers } from "../db/schema.js";
import { eq, desc, and, sql } from "drizzle-orm";
import { validateBody } from "../middleware/validate.js";
import { deployLock } from "../services/deploy-lock.js";
import {
  scriptsRunner,
  DeploymentLockedError,
  ScriptNotFoundError,
  InvalidManifestEntryError,
} from "../services/scripts-runner.js";
import { resolveDeployOperation } from "../services/deploy-dispatch.js";
import { writeOrRemoveOverride } from "../services/caddy-override-writer.js";
import {
  dispatchProjectLocalDeploy,
  ProjectLocalValidationError,
} from "../services/project-local-deploy-runner.js";
import { validateScriptPath } from "../lib/validate-script-path.js";
import { jobManager } from "../services/job-manager.js";
import { sshPool } from "../services/ssh-pool.js";
import { notifier } from "../services/notifier.js";
import { logger } from "../lib/logger.js";
import type { Request } from "express";

export const deploymentsRouter = Router();

// SHA + branch validated against strict regex before ever reaching shell — security-critical.
// Branch chars limited to git-ref allowed set: alphanumerics, '.', '_', '-', '/'. No spaces or shell metacharacters.
const SHA_REGEX = /^[0-9a-f]{7,40}$/;
const BRANCH_REGEX = /^[a-zA-Z0-9._\-/]+$/;

const deploySchema = z.object({
  branch: z
    .string()
    .min(1)
    .max(255)
    .regex(BRANCH_REGEX, "Branch name contains invalid characters")
    .optional(),
  commit: z
    .string()
    .regex(SHA_REGEX, "Commit must be a 7-40 char hex SHA")
    .optional(),
});

const rollbackSchema = z.object({
  targetCommit: z.string().optional(),
  deploymentId: z.string().optional(),
});

// POST /api/apps/:appId/deploy
deploymentsRouter.post(
  "/apps/:appId/deploy",
  validateBody(deploySchema),
  async (req, res) => {
    const userId = (req as Request & { userId: string }).userId;
    const appId = req.params.appId as string;
    const { branch, commit } = req.body;

    // Fetch app + server
    const [app] = await db
      .select()
      .from(applications)
      .where(eq(applications.id, appId))
      .limit(1);

    if (!app) {
      res.status(404).json({ error: { code: "NOT_FOUND", message: "Application not found" } });
      return;
    }

    const [server] = await db
      .select()
      .from(servers)
      .where(eq(servers.id, app.serverId))
      .limit(1);

    if (!server) {
      res.status(404).json({ error: { code: "NOT_FOUND", message: "Server not found" } });
      return;
    }

    // Feature 007 (fail-closed gate): if scriptPath is set on the row, run the
    // validator BEFORE opening any SSH connection. SC-007 requires invalid
    // runtime state to fail closed before any network side effect. The
    // wrapper's runtime re-validation still runs as the last line of defence,
    // but this gate avoids the SSH handshake on tampered-DB inputs.
    if (app.scriptPath) {
      const sp = validateScriptPath(app.scriptPath);
      if (!sp.ok || sp.value === null) {
        res.status(400).json({
          error: {
            code: "INVALID_PARAMS",
            message: "Persisted scriptPath failed validation",
            details: {
              fieldErrors: {
                scriptPath: [sp.ok ? "scriptPath is empty" : sp.error],
              },
            },
          },
        });
        return;
      }
    }

    // Ensure SSH connection
    if (!sshPool.isConnected(server.id)) {
      try {
        await sshPool.connect({
          id: server.id,
          host: server.host,
          port: server.port,
          sshUser: server.sshUser,
          sshAuthMethod: (server.sshAuthMethod as "key" | "password") ?? "key",
          sshPrivateKey: server.sshPrivateKey,
          sshPassword: server.sshPassword,
        });
      } catch (err) {
        res.status(503).json({
          error: { code: "SSH_ERROR", message: "Cannot connect to server" },
        });
        return;
      }
    }

    // Create deployment record first so we can pass the id into the runner.
    const deploymentId = randomUUID();
    const logFilePath = `/app/data/logs/${deploymentId}.log`;
    const deployBranch = branch ?? app.branch;

    await db.insert(deployments).values({
      id: deploymentId,
      applicationId: app.id,
      serverId: server.id,
      userId,
      type: "deploy",
      status: "running",
      branch: deployBranch,
      commitBefore: app.currentCommit ?? "unknown",
      commitAfter: commit ?? "HEAD",
      startedAt: new Date().toISOString(),
      logFilePath,
    });

    try {
      const { scriptId, params } = resolveDeployOperation(
        {
          repoUrl: app.repoUrl,
          skipInitialClone: app.skipInitialClone === true,
          remotePath: app.remotePath,
          branch: deployBranch,
          scriptPath: app.scriptPath,
          composePath: app.composePath,
        },
        { commit, branch: deployBranch },
      );

      // Phase 3 (feature 008-revised): if the app has a public domain AND a
      // global caddy_edge_network is configured, write a docker-compose
      // override file with labels for caddy-docker-proxy. server-deploy.sh
      // auto-detects and merges it via -f. Best-effort — failures don't
      // block the deploy (operator can still ssh and edit by hand).
      if (scriptId === "deploy/server-deploy") {
        await writeOrRemoveOverride(server.id, {
          domain: app.domain,
          upstreamService: app.upstreamService,
          upstreamPort: app.upstreamPort,
          remotePath: app.remotePath,
          name: app.name,
        }).catch((err) => {
          logger.warn(
            { ctx: "deploy-override-write", err, appId: app.id },
            "override write failed (continuing deploy)",
          );
        });
      }

      // Feature 007: project-local-deploy goes through the wrapper so the
      // SC-007 forensics trail row is guaranteed even on parse/lock/SSH errors.
      let jobId: string;
      if (scriptId === "deploy/project-local-deploy") {
        const result = await dispatchProjectLocalDeploy({
          scriptId,
          serverId: server.id,
          params,
          userId,
          deploymentId,
        });
        jobId = result.jobId;
      } else {
        const result = await scriptsRunner.runScript(
          scriptId,
          server.id,
          params,
          userId,
          { linkDeploymentId: deploymentId },
        );
        jobId = result.jobId;
      }

      // App-commit + notify hooks stay route-local.
      jobManager.onJobEvent(jobId, (_id, event) => {
        if (event.type !== "status") return;
        const status = (event.data as { status: string }).status;
        if (status === "success") {
          db.update(applications)
            .set({ currentCommit: commit ?? "HEAD" })
            .where(eq(applications.id, app.id))
            .catch(() => {});
        }
        if (status === "success" || status === "failed") {
          notifier
            .notify({
              serverId: server.id,
              event: status === "success" ? "Deploy Success" : "Deploy Failed",
              details: `App: ${app.name}\nBranch: ${deployBranch}`,
            })
            .catch(() => {});
        }
      });

      res.status(201).json({ deploymentId, jobId });
    } catch (err) {
      if (err instanceof DeploymentLockedError) {
        await db
          .update(deployments)
          .set({
            status: "failed",
            finishedAt: new Date().toISOString(),
            errorMessage: "Deployment lock held by another operation",
          })
          .where(eq(deployments.id, deploymentId));
        res.status(409).json({
          error: {
            code: "DEPLOYMENT_LOCKED",
            message: "Another deployment is in progress on this server",
            details: { lockedBy: err.lockedBy },
          },
        });
        return;
      }
      if (err instanceof ScriptNotFoundError) {
        await db
          .update(deployments)
          .set({
            status: "failed",
            finishedAt: new Date().toISOString(),
            errorMessage: err.message,
          })
          .where(eq(deployments.id, deploymentId));
        res.status(500).json({
          error: { code: "DEPLOY_ERROR", message: err.message },
        });
        return;
      }
      if (err instanceof ProjectLocalValidationError) {
        await db
          .update(deployments)
          .set({
            status: "failed",
            finishedAt: new Date().toISOString(),
            errorMessage: err.message,
          })
          .where(eq(deployments.id, deploymentId));
        res.status(400).json({
          error: {
            code: "INVALID_PARAMS",
            message: err.message,
            details: { runId: err.runId },
          },
        });
        return;
      }
      if (err instanceof InvalidManifestEntryError) {
        await db
          .update(deployments)
          .set({
            status: "failed",
            finishedAt: new Date().toISOString(),
            errorMessage: err.message,
          })
          .where(eq(deployments.id, deploymentId));
        res.status(500).json({
          error: {
            code: "INVALID_MANIFEST_ENTRY",
            message: err.message,
            details: { validationError: err.validationError },
          },
        });
        return;
      }

      const errMsg = err instanceof Error ? err.message : "Deploy failed";
      logger.error(
        {
          ctx: "deploy-route",
          appId: app.id,
          serverId: server.id,
          deploymentId,
          err,
          errName: (err as Error | undefined)?.name,
          errStack: (err as Error | undefined)?.stack,
        },
        "Deploy dispatch failed",
      );
      await db
        .update(deployments)
        .set({
          status: "failed",
          finishedAt: new Date().toISOString(),
          errorMessage: errMsg,
        })
        .where(eq(deployments.id, deploymentId));

      res.status(500).json({
        error: {
          code: "DEPLOY_ERROR",
          message: "Failed to start deployment",
          details: { reason: errMsg },
        },
      });
    }
  },
);

// POST /api/apps/:appId/rollback
deploymentsRouter.post(
  "/apps/:appId/rollback",
  validateBody(rollbackSchema),
  async (req, res) => {
    const userId = (req as Request & { userId: string }).userId;
    const appId = req.params.appId as string;
    const { targetCommit, deploymentId: targetDeploymentId } = req.body;

    const [app] = await db
      .select()
      .from(applications)
      .where(eq(applications.id, appId))
      .limit(1);

    if (!app) {
      res.status(404).json({ error: { code: "NOT_FOUND", message: "Application not found" } });
      return;
    }

    const [server] = await db
      .select()
      .from(servers)
      .where(eq(servers.id, app.serverId))
      .limit(1);

    if (!server) {
      res.status(404).json({ error: { code: "NOT_FOUND", message: "Server not found" } });
      return;
    }

    // Determine rollback target
    let rollbackCommit = targetCommit;
    if (!rollbackCommit && targetDeploymentId) {
      const [targetDeploy] = await db
        .select()
        .from(deployments)
        .where(eq(deployments.id, targetDeploymentId))
        .limit(1);
      rollbackCommit = targetDeploy?.commitAfter;
    }

    if (!rollbackCommit) {
      res.status(400).json({
        error: { code: "INVALID_PARAMS", message: "rollback target commit is required" },
      });
      return;
    }

    const deploymentId = randomUUID();
    const logFilePath = `/app/data/logs/${deploymentId}.log`;

    await db.insert(deployments).values({
      id: deploymentId,
      applicationId: app.id,
      serverId: server.id,
      userId,
      type: "rollback",
      status: "running",
      branch: app.branch,
      commitBefore: app.currentCommit ?? "unknown",
      commitAfter: rollbackCommit,
      startedAt: new Date().toISOString(),
      logFilePath,
    });

    try {
      const { jobId } = await scriptsRunner.runScript(
        "deploy/server-rollback",
        server.id,
        { appDir: app.remotePath, commit: rollbackCommit },
        userId,
        { linkDeploymentId: deploymentId },
      );

      jobManager.onJobEvent(jobId, (_id, event) => {
        if (event.type !== "status") return;
        const status = (event.data as { status: string }).status;
        if (status === "success" && rollbackCommit) {
          db.update(applications)
            .set({ currentCommit: rollbackCommit })
            .where(eq(applications.id, app.id))
            .catch(() => {});
        }
      });

      res.status(201).json({ deploymentId, jobId });
    } catch (err) {
      if (err instanceof DeploymentLockedError) {
        await db
          .update(deployments)
          .set({
            status: "failed",
            finishedAt: new Date().toISOString(),
            errorMessage: "Deployment lock held by another operation",
          })
          .where(eq(deployments.id, deploymentId));
        res.status(409).json({
          error: {
            code: "DEPLOYMENT_LOCKED",
            message: "Another deployment is in progress",
            details: { lockedBy: err.lockedBy },
          },
        });
        return;
      }

      const errMsg = err instanceof Error ? err.message : "Rollback failed";
      logger.error(
        {
          ctx: "rollback-route",
          appId: app.id,
          serverId: server.id,
          deploymentId,
          err,
          errName: (err as Error | undefined)?.name,
          errStack: (err as Error | undefined)?.stack,
        },
        "Rollback dispatch failed",
      );
      await db
        .update(deployments)
        .set({
          status: "failed",
          finishedAt: new Date().toISOString(),
          errorMessage: errMsg,
        })
        .where(eq(deployments.id, deploymentId));

      res.status(500).json({
        error: {
          code: "ROLLBACK_ERROR",
          message: "Failed to start rollback",
          details: { reason: errMsg },
        },
      });
    }
  },
);

// POST /api/deployments/:id/cancel
deploymentsRouter.post("/deployments/:id/cancel", async (req, res) => {
  const id = req.params.id as string;
  const [deployment] = await db
    .select()
    .from(deployments)
    .where(eq(deployments.id, id))
    .limit(1);

  if (!deployment) {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "Deployment not found" } });
    return;
  }

  if (deployment.status !== "running") {
    res.status(400).json({
      error: { code: "INVALID_STATE", message: "Can only cancel running deployments" },
    });
    return;
  }

  // Cancel the job (this kills the SSH channel)
  const job = jobManager.getJob(deployment.id);
  if (job) {
    jobManager.cancelJob(job.id);
  }

  await db
    .update(deployments)
    .set({
      status: "cancelled",
      finishedAt: new Date().toISOString(),
    })
    .where(eq(deployments.id, deployment.id));

  await deployLock.releaseLock(deployment.serverId);

  res.json({ status: "cancelled" });
});

// GET /api/apps/:appId/deployments
deploymentsRouter.get("/apps/:appId/deployments", async (req, res) => {
  const appId = req.params.appId as string;
  const limit = Math.min(Number(req.query.limit) || 20, 100);
  const offset = Number(req.query.offset) || 0;

  const result = await db
    .select()
    .from(deployments)
    .where(eq(deployments.applicationId, appId))
    .orderBy(desc(deployments.startedAt))
    .limit(limit)
    .offset(offset);

  res.json(result);
});

// GET /api/deployments/:id
deploymentsRouter.get("/deployments/:id", async (req, res) => {
  const id = req.params.id as string;
  const [deployment] = await db
    .select()
    .from(deployments)
    .where(eq(deployments.id, id))
    .limit(1);

  if (!deployment) {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "Deployment not found" } });
    return;
  }

  res.json(deployment);
});
