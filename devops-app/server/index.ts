import express from "express";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cors from "cors";
import cookieParser from "cookie-parser";
import { db, client } from "./db/index.js";
import { deployments } from "./db/schema.js";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { deployLock } from "./services/deploy-lock.js";
import { logger } from "./lib/logger.js";
import { authRouter, requireAuth } from "./middleware/auth.js";
import { auditMiddleware } from "./middleware/audit.js";
import { setupWebSocket } from "./ws/handler.js";
import { serversRouter } from "./routes/servers.js";
import { appsRouter } from "./routes/apps.js";
import { deploymentsRouter } from "./routes/deployments.js";
import { backupsRouter } from "./routes/backups.js";
import { healthRouter } from "./routes/health.js";
import { logsRouter } from "./routes/logs.js";
import { auditRouter } from "./routes/audit.js";
import { dockerRouter } from "./routes/docker.js";
import { settingsRouter } from "./routes/settings.js";
import { githubRouter } from "./routes/github.js";
import { scanRouter } from "./routes/scan.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const server = createServer(app);

// WebSocket server on /ws path
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
  if (url.pathname === "/ws") {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  } else {
    socket.destroy();
  }
});

// Setup WebSocket handler
setupWebSocket(wss);

// Global middleware
app.use(cors());
app.use(express.json());
app.use(cookieParser());

// Auth routes (no auth required)
app.use("/api/auth", authRouter);

// Protected routes — require auth + audit
app.use("/api", requireAuth);
app.use("/api", auditMiddleware);

// Routes
app.use("/api/servers", serversRouter);
app.use("/api", appsRouter);
app.use("/api", deploymentsRouter);
app.use("/api", backupsRouter);
app.use("/api", healthRouter);
app.use("/api", logsRouter);
app.use("/api", auditRouter);
app.use("/api", dockerRouter);
app.use("/api/settings", settingsRouter);
app.use("/api/github", githubRouter);
app.use("/api", scanRouter);

// Serve static client build in production
const clientDir = path.resolve(__dirname, "../client");
app.use(express.static(clientDir));

// SPA fallback — serve index.html for non-API routes
app.use((req, res, next) => {
  if (req.method !== "GET" || req.path.startsWith("/api")) return next();
  res.sendFile(path.join(clientDir, "index.html"));
});

// Startup: auto-migrate + zombie deploy triage
async function startup() {
  const port = Number(process.env.PORT) || 3000;

  // Step 1: Auto-apply pending migrations
  try {
    await migrate(db, { migrationsFolder: "./server/db/migrations" });
    console.log("[startup] Database migrations applied");
  } catch (err) {
    console.error("[startup] Migration failed:", err);
    process.exit(1);
  }

  // Step 1b: Deploy-lock pool-safety self-check (T015). If a transaction-mode
  // pooler sits between dashboard and Postgres, advisory locks cannot function.
  // Fail-closed: log error, skip lock hooks, but keep serving traffic. Uses
  // `error` (not `fatal`) because the process keeps running — `fatal` would be
  // a false alarm for aggregators that page on it.
  let lockHooksEnabled = true;
  try {
    await deployLock.assertDirectConnection();
  } catch (err) {
    logger.error(
      { ctx: "deploy-lock-pool-check", err },
      "Deploy lock disabled — pool check failed",
    );
    lockHooksEnabled = false;
  }

  // Step 1c: Reconcile orphan deploy_locks rows (never blocks startup) and
  // start the pool-exhaustion watchdog — both gated on the pool check.
  if (lockHooksEnabled) {
    await deployLock.reconcileOrphanLocks().catch((err) => {
      logger.warn(
        { ctx: "deploy-lock-reconcile", err },
        "Orphan reconciliation skipped",
      );
    });
    deployLock.start();
  }

  // Step 1d: Graceful shutdown — ALWAYS register, whether or not the lock
  // feature is active. The pool must drain on SIGTERM regardless so we don't
  // leak Postgres backends on container shutdown. The lock-release loop is a
  // no-op when `lockHooksEnabled === false` because `heldServerIds()` is empty.
  process.on("SIGTERM", () => {
    void (async () => {
      deployLock.stop();
      const ids = deployLock.heldServerIds();
      const releases = Promise.allSettled(
        ids.map((id) => deployLock.releaseLock(id)),
      );
      const timeout = new Promise<void>((resolve) =>
        setTimeout(resolve, 2000),
      );
      await Promise.race([releases, timeout]);
      try {
        await client.end({ timeout: 5 });
      } catch {
        /* ignore */
      }
      logger.info(
        { ctx: "shutdown", releasedCount: ids.length },
        "Graceful shutdown complete",
      );
      process.exit(0);
    })();
  });

  // Step 2: Zombie deploy triage — force-fail all "running" deployments
  try {
    const zombies = await db
      .update(deployments)
      .set({
        status: "failed",
        errorMessage: "Interrupted by dashboard restart",
        finishedAt: new Date().toISOString(),
      })
      .where(eq(deployments.status, "running"))
      .returning({ id: deployments.id });

    if (zombies.length > 0) {
      console.log(
        `[startup] Force-failed ${zombies.length} zombie deployment(s): ${zombies.map((z) => z.id).join(", ")}`,
      );
    }
  } catch (err) {
    console.error("[startup] Zombie triage failed:", err);
  }

  server.listen(port, () => {
    console.log(`[devops-dashboard] Running on http://localhost:${port}`);
  });
}

startup();

export { app, server, wss };
