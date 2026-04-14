import express from "express";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cors from "cors";
import cookieParser from "cookie-parser";
import { db } from "./db/index.js";
import { deployments } from "./db/schema.js";
import { eq } from "drizzle-orm";
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

// Serve static client build in production
const clientDir = path.resolve(__dirname, "../client");
app.use(express.static(clientDir));

// SPA fallback — serve index.html for non-API routes
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api")) return next();
  res.sendFile(path.join(clientDir, "index.html"));
});

// Startup: zombie deploy triage
async function startup() {
  const port = Number(process.env.PORT) || 3000;

  // Zombie deploy triage: force-fail all "running" deployments
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
  } catch {
    // Schema may not exist yet on first run — that's fine
    console.log("[startup] Skipping zombie triage (schema may not exist yet)");
  }

  server.listen(port, () => {
    console.log(`[devops-dashboard] Running on http://localhost:${port}`);
  });
}

startup();

export { app, server, wss };
