import type { Request, Response, NextFunction } from "express";
import { randomUUID } from "node:crypto";
import { db } from "../db/index.js";
import { auditEntries } from "../db/schema.js";
import { manifest } from "../scripts-manifest.js";
import { maskSecrets } from "../lib/mask-secrets.js";

// Feature 005: for /api/scripts/:id/run, manifest-lookup the schema and mask
// secret fields before body capture. Falls back to a deep-key scrub if the
// scriptId is not in the manifest cache.
function captureBody(req: Request): unknown {
  const body = req.body;
  if (!body || typeof body !== "object") return body;

  const isScriptRun = /^\/api\/scripts\/.+\/run$/.test(req.path);
  if (!isScriptRun) return body;

  // Extract the scriptId from the path: /api/scripts/<id>/run
  const m = req.path.match(/^\/api\/scripts\/(.+)\/run$/);
  const scriptId = m ? m[1] : null;
  const entry = scriptId ? manifest.find((e) => e.id === scriptId) : null;

  const params =
    (body as { params?: Record<string, unknown> }).params ?? {};
  const masked = entry ? maskSecrets(entry.params, params) : params;

  return { ...(body as Record<string, unknown>), params: masked };
}

// Auto-log every mutating request (POST/PUT/DELETE)
export function auditMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  // Only audit mutating methods
  if (!["POST", "PUT", "DELETE"].includes(req.method)) {
    next();
    return;
  }

  // Skip auth routes from audit
  if (req.path.startsWith("/api/auth/")) {
    next();
    return;
  }

  const userId = (req as Request & { userId?: string }).userId ?? "unknown";
  const startTime = Date.now();

  // Capture original res.json to intercept response
  const originalJson = res.json.bind(res);

  res.json = function (body: unknown) {
    const result = res.statusCode < 400 ? "success" : "failure";
    const { action, targetType, targetId } = parseRoute(req);

    // Fire and forget — don't block the response
    db.insert(auditEntries)
      .values({
        id: randomUUID(),
        userId,
        action,
        targetType,
        targetId,
        details: JSON.stringify({
          method: req.method,
          path: req.path,
          statusCode: res.statusCode,
          durationMs: Date.now() - startTime,
          body: captureBody(req),
        }),
        result,
        timestamp: new Date().toISOString(),
      })
      .catch((err) => {
        console.error("[audit] Failed to write audit entry:", err);
      });

    return originalJson(body);
  };

  next();
}

function parseRoute(req: Request): {
  action: string;
  targetType: string;
  targetId: string;
} {
  const parts = req.path.split("/").filter(Boolean);
  // /api/servers/:id/... → targetType=server, targetId=:id
  // /api/apps/:id/... → targetType=application
  // /api/deployments/:id/... → targetType=deployment
  // /api/backups/:id/... → targetType=backup

  let targetType = "unknown";
  let targetId = "unknown";
  let action = `${req.method.toLowerCase()}.${parts.slice(1).join(".")}`;

  if (parts.includes("servers")) {
    targetType = "server";
    const idx = parts.indexOf("servers");
    targetId = parts[idx + 1] ?? "unknown";
  } else if (parts.includes("apps")) {
    targetType = "application";
    const idx = parts.indexOf("apps");
    targetId = parts[idx + 1] ?? "unknown";
  } else if (parts.includes("deployments")) {
    targetType = "deployment";
    const idx = parts.indexOf("deployments");
    targetId = parts[idx + 1] ?? "unknown";
  } else if (parts.includes("backups")) {
    targetType = "backup";
    const idx = parts.indexOf("backups");
    targetId = parts[idx + 1] ?? "unknown";
  }

  // Map specific actions
  if (req.path.includes("/deploy")) action = "deploy.start";
  else if (req.path.includes("/rollback")) action = "rollback.start";
  else if (req.path.includes("/cancel")) action = "deploy.cancel";
  else if (req.path.includes("/restore")) action = "backup.restore";
  else if (req.path.includes("/cleanup")) action = "docker.cleanup";
  else if (req.path.includes("/audit")) action = "security.audit";
  else if (req.path.includes("/setup")) action = "server.setup";
  else if (req.path.includes("/verify")) action = "server.verify";

  return { action, targetType, targetId };
}
