/**
 * Feature 005 R-005 + R-011: walk a ZodObject schema and emit a presentation
 * descriptor for the UI form generator.
 *
 * Written against Zod 4's public surface:
 *   - schema.shape        → record of ZodTypes
 *   - field.def.type      → "string" | "number" | "boolean" | "enum" |
 *                           "optional" | "default" | "nullable" | ...
 *   - field.def.innerType → unwrap target for optional/default/nullable
 *   - field.def.defaultValue → value for default wrapper
 *   - field.def.entries   → enum values map
 *   - field.meta()        → description (`.describe("secret")` sets this)
 *
 * The descriptor is a PRESENTATION hint; real validation on submit still uses
 * the live Zod schema server-side.
 */

import { z } from "zod";

export interface FieldDescriptor {
  name: string;
  type: "string" | "number" | "boolean" | "enum";
  required: boolean;
  default?: unknown;
  enumValues?: string[];
  isSecret: boolean;
  description?: string;
}

function toKebab(camel: string): string {
  return camel.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

function readMeta(field: unknown): { description?: string } | undefined {
  if (!field || typeof field !== "object") return undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const f = field as any;
  try {
    if (typeof f.meta === "function") return f.meta();
    if (f.meta && typeof f.meta === "object") return f.meta;
    if (f._def) return f._def;
    if (f.def) return f.def;
  } catch {
    /* ignore */
  }
  return undefined;
}

/**
 * R-011 wrapper: a single source of change when Zod's metadata API evolves.
 */
export function isSecretField(field: z.ZodTypeAny): boolean {
  return readMeta(field)?.description === "secret";
}

function getDescription(field: z.ZodTypeAny): string | undefined {
  const d = readMeta(field)?.description;
  return typeof d === "string" && d !== "secret" ? d : undefined;
}

interface ZodDef {
  type?: string;
  innerType?: z.ZodTypeAny;
  defaultValue?: unknown;
  entries?: Record<string, string>;
  values?: string[];
}

function getDef(field: z.ZodTypeAny): ZodDef {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const f = field as any;
  return (f?.def ?? f?._def ?? {}) as ZodDef;
}

function unwrap(field: z.ZodTypeAny): {
  inner: z.ZodTypeAny;
  required: boolean;
  defaultValue?: unknown;
} {
  let inner = field;
  let required = true;
  let defaultValue: unknown;

  for (let i = 0; i < 6; i++) {
    const def = getDef(inner);
    if (def.type === "optional" || def.type === "nullable") {
      required = false;
      if (!def.innerType) break;
      inner = def.innerType;
    } else if (def.type === "default") {
      required = false;
      const d = def.defaultValue;
      defaultValue = typeof d === "function" ? (d as () => unknown)() : d;
      if (!def.innerType) break;
      inner = def.innerType;
    } else {
      break;
    }
  }

  return { inner, required, defaultValue };
}

function mapType(inner: z.ZodTypeAny): {
  type: FieldDescriptor["type"];
  enumValues?: string[];
} {
  const def = getDef(inner);
  const t = def.type;
  if (t === "string") return { type: "string" };
  if (t === "number") return { type: "number" };
  if (t === "boolean") return { type: "boolean" };
  if (t === "enum") {
    const values =
      def.values ??
      (def.entries ? Object.values(def.entries) : []);
    return { type: "enum", enumValues: values };
  }
  return { type: "string" };
}

export function extractFieldDescriptors(
  schema: z.ZodTypeAny,
): FieldDescriptor[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const s = schema as any;
  const shapeRaw = s?.shape ?? s?.def?.shape ?? s?._def?.shape;
  const shapeObj: Record<string, z.ZodTypeAny> | undefined =
    typeof shapeRaw === "function" ? shapeRaw() : shapeRaw;
  if (!shapeObj || typeof shapeObj !== "object") return [];

  const out: FieldDescriptor[] = [];
  for (const [key, rawField] of Object.entries(shapeObj)) {
    const { inner, required, defaultValue } = unwrap(rawField);
    const { type, enumValues } = mapType(inner);
    const isSecret = isSecretField(rawField) || isSecretField(inner);
    out.push({
      name: toKebab(key),
      type,
      required,
      ...(defaultValue !== undefined ? { default: defaultValue } : {}),
      ...(enumValues ? { enumValues } : {}),
      isSecret,
      ...(getDescription(rawField) ? { description: getDescription(rawField) } : {}),
    });
  }
  return out;
}
