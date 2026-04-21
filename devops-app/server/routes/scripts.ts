/**
 * Feature 005: scripts-runner HTTP surface.
 *
 *   GET  /api/scripts/manifest          → list of target-locus entries
 *   POST /api/scripts/<category>/<name>/run  → dispatch a run
 *
 * Express 5 lets us use a splat pattern on `:id(.+)` so ids containing `/`
 * match natively without %2F-encoding.
 */

import { Router } from "express";
import { z, ZodError } from "zod";
import {
  scriptsRunner,
  ScriptNotFoundError,
  InvalidManifestEntryError,
  DeploymentLockedError,
} from "../services/scripts-runner.js";
import type { Request } from "express";

export const scriptsRouter = Router();

const runBodySchema = z
  .object({
    serverId: z.string().min(1),
    params: z.unknown().optional(),
  })
  .strict();

scriptsRouter.get("/scripts/manifest", (_req, res) => {
  const scripts = scriptsRunner
    .getManifestDescriptor()
    .filter((d) => d.locus === "target");
  res.json({ scripts });
});

scriptsRouter.post("/scripts/:category/:name/run", async (req, res) => {
  const userId = (req as unknown as Request & { userId: string }).userId;
  const scriptId = `${req.params.category}/${req.params.name}`;

  const parsed = runBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: {
        code: "INVALID_BODY",
        message: "Request body validation failed",
        details: { fieldErrors: parsed.error.flatten().fieldErrors },
      },
    });
    return;
  }

  const { serverId, params } = parsed.data;

  try {
    const result = await scriptsRunner.runScript(
      scriptId,
      serverId,
      (params ?? {}) as Record<string, unknown>,
      userId,
    );
    res.status(201).json({ ...result, status: "running" });
  } catch (err) {
    if (err instanceof ScriptNotFoundError) {
      res.status(404).json({
        error: { code: "SCRIPT_NOT_FOUND", message: err.message },
      });
      return;
    }
    if (err instanceof InvalidManifestEntryError) {
      res.status(400).json({
        error: {
          code: "INVALID_MANIFEST_ENTRY",
          message: err.message,
          details: { validationError: err.validationError },
        },
      });
      return;
    }
    if (err instanceof ZodError) {
      res.status(400).json({
        error: {
          code: "INVALID_PARAMS",
          message: "Parameter validation failed",
          details: { fieldErrors: err.flatten().fieldErrors },
        },
      });
      return;
    }
    if (err instanceof DeploymentLockedError) {
      res.status(409).json({
        error: {
          code: "DEPLOYMENT_LOCKED",
          message: "Another operation is in progress on this server",
          details: { lockedBy: err.lockedBy },
        },
      });
      return;
    }
    res.status(503).json({
      error: {
        code: "SSH_ERROR",
        message: err instanceof Error ? err.message : "Run failed",
      },
    });
  }
});
