/**
 * Feature 005 R-006 Layer 1: mask fields marked `.describe("secret")` as `"***"`.
 *
 * Applied before:
 *   - script_runs.params DB insert (masking at WRITE time, not display time)
 *   - auditMiddleware body capture (via extension in audit.ts)
 *
 * Flat-schema only for v1 — nested objects pass through unchanged.
 */

import { z } from "zod";
import { isSecretField } from "./zod-descriptor.js";

export function maskSecrets(
  schema: z.ZodTypeAny,
  values: Record<string, unknown>,
): Record<string, unknown> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const s = schema as any;
  const shapeRaw = s?.shape ?? s?.def?.shape ?? s?._def?.shape;
  const shapeObj: Record<string, z.ZodTypeAny> =
    typeof shapeRaw === "function" ? shapeRaw() : (shapeRaw ?? {});

  const out: Record<string, unknown> = { ...values };
  for (const key of Object.keys(values)) {
    const field = shapeObj[key];
    if (field && isSecretField(field)) {
      out[key] = "***";
    }
  }
  return out;
}
