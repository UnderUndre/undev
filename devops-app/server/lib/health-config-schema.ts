/**
 * Feature 006 T037 / T038 / T054 — shared Zod fragment for the 5 health config
 * fields, plus an async `.refine()` on `healthUrl` that gates against the
 * SSRF block list (FR-029b, second-layer-of-defence; T053 is authoritative).
 *
 * Reused by:
 *   - PATCH /api/applications/:id/health/config           (T037)
 *   - POST  /api/servers/:serverId/apps                   (T038)
 *   - PUT   /api/apps/:id                                 (T038)
 */
import { z } from "zod";
import { validateUrlForProbe } from "./ssrf-guard.js";

export const healthUrlFieldSchema = z
  .union([z.string().url(), z.null()])
  .superRefine(async (val, ctx) => {
    if (val === null || val === "") return;
    const result = await validateUrlForProbe(val);
    if (!result.ok) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          result.code === "private_ip"
            ? "URL resolves to a private/internal IP and is blocked by SSRF policy"
            : result.code === "nxdomain"
              ? "DNS resolution failed (NXDOMAIN)"
              : "Invalid URL",
        params: { error_code: "health_url_blocked", reason: result.code },
      });
    }
  });

/**
 * The 5 mutable health-config fields, each optional (PATCH semantics — omitted
 * means "leave column untouched"). Lower bounds per FR-002 / FR-007.
 */
export const healthConfigPatchSchema = z
  .object({
    healthUrl: healthUrlFieldSchema.optional(),
    monitoringEnabled: z.boolean().optional(),
    alertsMuted: z.boolean().optional(),
    healthProbeIntervalSec: z.number().int().min(10).optional(),
    healthDebounceCount: z.number().int().min(1).optional(),
  })
  .strict();

export type HealthConfigPatch = z.infer<typeof healthConfigPatchSchema>;
