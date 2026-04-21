/**
 * Feature 005 R-004: serialise a validated params record into argv + env
 * exports for the bash buffer.
 *
 *   - Strings, numbers → `--flag=<shQuoted>` in argv
 *   - booleans: true → `--flag`; false → omitted
 *   - arrays → repeated `--flag=<shQuoted>`
 *   - null / undefined → skipped
 *   - fields marked `.describe("secret")` → NEVER in argv, routed into
 *     envExports as `SECRET_<UPPER_SNAKE_NAME>` — the caller injects those
 *     into the bash stdin buffer as `export` lines (feature 005 FR-016).
 *
 * Field name `envExports` (not `env`) makes the destination explicit:
 * these are script-body exports, NOT child-process spawn env.
 */

import { z } from "zod";
import { shQuote } from "./sh-quote.js";
import { isSecretField } from "./zod-descriptor.js";

export interface SerialisedParams {
  args: string[];
  envExports: Record<string, string>;
}

function toKebab(camel: string): string {
  return camel.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

function toUpperSnake(camel: string): string {
  return camel.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();
}

export function serialiseParams(
  schema: z.ZodTypeAny,
  values: Record<string, unknown>,
): SerialisedParams {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const s = schema as any;
  const shapeRaw = s?.shape ?? s?.def?.shape ?? s?._def?.shape;
  const shapeObj: Record<string, z.ZodTypeAny> =
    typeof shapeRaw === "function" ? shapeRaw() : (shapeRaw ?? {});

  const args: string[] = [];
  const envExports: Record<string, string> = {};

  for (const [key, val] of Object.entries(values)) {
    if (val === null || val === undefined) continue;
    const field = shapeObj[key];
    const secret = field ? isSecretField(field) : false;

    if (secret) {
      envExports[`SECRET_${toUpperSnake(key)}`] = String(val);
      continue;
    }

    const kebab = toKebab(key);

    if (typeof val === "boolean") {
      if (val) args.push(`--${kebab}`);
      continue;
    }

    if (Array.isArray(val)) {
      for (const v of val) {
        if (v === null || v === undefined) continue;
        args.push(`--${kebab}=${shQuote(String(v))}`);
      }
      continue;
    }

    args.push(`--${kebab}=${shQuote(String(val))}`);
  }

  return { args, envExports };
}
