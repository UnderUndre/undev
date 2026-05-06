/**
 * Feature 010 T051 — POST /api/applications/migrate.
 *
 * Adopts an existing manually-configured app via service-layer
 * `migration-toolkit.adopt`. Service returns a discriminated union; this
 * route maps each branch to the contracts/api.md HTTP shape.
 */

import { Router, type Request } from "express";
import { z } from "zod";
import { adopt, type MigrationInput } from "../services/migration-toolkit.js";

export const migrationRouter = Router();

const bodySchema = z
  .object({
    serverId: z.string().min(1),
    remotePath: z.string().min(1).max(512),
    composePath: z.string().min(1).max(256).optional(),
    healthUrl: z.string().url().nullable().optional(),
    domain: z.string().min(1).max(253).nullable().optional(),
    domainTypedConfirmation: z.string().nullable().optional(),
  })
  .strict();

migrationRouter.post("/applications/migrate", async (req, res) => {
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: {
        code: "INVALID_PARAMS",
        message: "Invalid migrate request",
        details: parsed.error.flatten(),
      },
    });
    return;
  }
  const userId = (req as Request & { userId?: string }).userId ?? "system";
  const input: MigrationInput = {
    serverId: parsed.data.serverId,
    remotePath: parsed.data.remotePath,
    composePath: parsed.data.composePath,
    healthUrl: parsed.data.healthUrl ?? null,
    domain: parsed.data.domain ?? null,
    domainTypedConfirmation: parsed.data.domainTypedConfirmation ?? null,
  };
  const result = await adopt(input, userId);
  switch (result.kind) {
    case "insert":
      res.status(201).json({
        app: result.app,
        branch: "insert",
        detected: result.detected,
      });
      return;
    case "patch_promote":
      res.status(200).json({
        app: result.app,
        branch: "patch_promote",
        addedFields: result.addedFields,
        preservedCreatedVia: result.preservedCreatedVia,
      });
      return;
    case "path_already_managed":
      res.status(409).json({
        error: {
          code: "path_already_managed",
          message: `Path is already managed by ${result.existing.name} (${result.existing.createdVia})`,
          details: { existing: result.existing },
        },
      });
      return;
    case "target_path_invalid":
      res.status(422).json({
        error: {
          code: "target_path_invalid",
          message: "Target path validation failed",
          details: { reason: result.reason },
        },
      });
      return;
    case "target_path_jail_violation":
      res.status(422).json({
        error: {
          code: "target_path_jail_violation",
          message: "Resolved path is outside the server's allowed scan_roots",
          details: {
            reason: "outside_scan_roots",
            resolvedPath: result.resolvedPath,
            allowedRoots: result.allowedRoots,
          },
        },
      });
      return;
    case "domain_confirmation_required":
      res.status(409).json({
        error: {
          code: "domain_confirmation_required",
          message: "Cross-server domain conflict — type the domain to confirm",
          details: { conflicts: result.conflicts },
        },
      });
      return;
  }
});
