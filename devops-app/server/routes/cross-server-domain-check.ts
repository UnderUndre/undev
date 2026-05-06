/**
 * Feature 010 T033 — read-only cross-server domain conflict lookup.
 *
 * GET /api/applications/cross-server-domain-check?domain=&excludeAppId=
 *
 * Returns conflicts excluding self. No audit (read-only). Used by:
 *   - DomainEditDialog (debounced fetch on domain change)
 *   - MigrateExistingAppWizard (Step 4 review)
 *   - BootstrapWizard (Domain step)
 */

import { Router } from "express";
import { z } from "zod";
import { findCrossServerConflicts } from "../services/cross-server-domain-check.js";

export const crossServerDomainRouter = Router();

const querySchema = z.object({
  domain: z.string().min(1).max(253),
  excludeAppId: z.string().min(1),
});

crossServerDomainRouter.get(
  "/applications/cross-server-domain-check",
  async (req, res) => {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({
        error: {
          code: "INVALID_PARAMS",
          message: "domain and excludeAppId required",
          details: parsed.error.flatten(),
        },
      });
      return;
    }
    const conflicts = await findCrossServerConflicts(
      parsed.data.domain,
      parsed.data.excludeAppId,
    );
    res.json(conflicts);
  },
);
