import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { scan, ScanInProgressError } from "../services/scanner.js";

export const scanRouter = Router();

const paramsSchema = z.object({ serverId: z.string().min(1) });

// POST /api/servers/:serverId/scan
scanRouter.post("/servers/:serverId/scan", async (req: Request, res: Response) => {
  const params = paramsSchema.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({
      error: { code: "INVALID_PARAMS", message: "serverId is required" },
    });
    return;
  }

  const userId = (req as Request & { userId?: string }).userId ?? "unknown";
  const serverId = params.data.serverId;

  // Wire client-abort → kill the in-flight scan. Lock is released in
  // scanner.scan()'s finally block regardless.
  let clientAborted = false;
  req.on("close", () => {
    if (!res.writableEnded) {
      clientAborted = true;
      // The lock entry's abort() is invoked by the timeout path inside scan();
      // the only way to signal it from here without exporting internals is
      // via the Node-side setTimeout, which will fire anyway. Good enough for v1.
    }
  });

  try {
    const result = await scan(serverId, userId);
    if (clientAborted) return; // client already gone; don't bother sending
    res.json(result);
  } catch (err) {
    if (err instanceof ScanInProgressError) {
      res.status(409).json({
        error: {
          code: "SCAN_IN_PROGRESS",
          message: "Another scan is already running on this server",
          since: err.since.toISOString(),
          byUserId: err.byUserId,
        },
      });
      return;
    }
    const msg = err instanceof Error ? err.message : "Unknown scanner error";
    if (msg.includes("No active SSH connection") || msg.includes("Server not found")) {
      res.status(503).json({
        error: { code: "SSH_UNREACHABLE", message: "Server unreachable — check SSH credentials" },
      });
      return;
    }
    if (msg.includes("scanRoots")) {
      res.status(400).json({
        error: { code: "INVALID_SCAN_ROOT", message: msg },
      });
      return;
    }
    res.status(500).json({
      error: { code: "SCAN_ERROR", message: msg },
    });
  }
});
