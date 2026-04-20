import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { scan, getActiveScan, ScanInProgressError } from "../services/scanner.js";
import { logger } from "../lib/logger.js";

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

  // FR-062 / SC-003: propagate client abort to the in-flight scan.
  // On socket close, look up the active scan for this server and call its
  // abort() — same handle wired by scanner.ts, which invokes kill() on the
  // SSH stream. This kills the remote `timeout 60 bash -c` pipeline inside
  // the ~2s SSH channel teardown budget.
  let clientAborted = false;
  req.on("close", () => {
    if (res.writableEnded) return;
    clientAborted = true;
    const entry = getActiveScan(serverId);
    if (entry) {
      logger.info(
        { ctx: "scan-route-abort", serverId, userId },
        "Client aborted scan — killing remote command",
      );
      entry.abort();
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
