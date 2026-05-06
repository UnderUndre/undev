/**
 * Feature 011 T035 — lazy migration helper + .env.example parser.
 *
 * `lazyMigrateOnWrite` is a thin wrapper over `env-vars-store.save` that
 * exists for symmetry with the data-model spec; the actual atomicity is
 * already enforced by `save` (single UPDATE clears env_vars + writes
 * env_vars_encrypted in one shot).
 *
 * `parseEnvExample` is robust against real-world `.env.example` mess
 * (per gemini #5):
 *   - strips optional leading `export ` prefix
 *   - skips blank lines and lines starting with `#`
 *   - skips lines with no `=`
 *   - strips inline comments after the value when the value isn't quoted
 *   - normalises `"..."` and `'...'` quoted values (outer quotes removed,
 *     inner content preserved verbatim)
 *   - skips lines with unclosed quotes (multi-line values are out of
 *     scope for this importer, per OQ-002 v1 resolution)
 */

import { logger } from "../lib/logger.js";
import { save, type EnvVarMap, type EnvVarsDiff } from "./env-vars-store.js";

export async function lazyMigrateOnWrite(
  appId: string,
  newVars: EnvVarMap,
  userId: string,
): Promise<EnvVarsDiff> {
  return save(appId, newVars, userId);
}

const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;

export function parseEnvExample(text: string): EnvVarMap {
  const out: EnvVarMap = {};
  const lines = text.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i] ?? "";
    line = line.trim();
    if (!line || line.startsWith("#")) continue;

    if (line.startsWith("export ")) line = line.slice("export ".length).trim();

    const eq = line.indexOf("=");
    if (eq <= 0) continue;

    const key = line.slice(0, eq).trim();
    if (!ENV_NAME_RE.test(key)) continue;

    let rawValue = line.slice(eq + 1);
    // Trim leading whitespace before checking for quotes
    rawValue = rawValue.replace(/^\s+/, "");

    let value: string;
    if (rawValue.startsWith('"') || rawValue.startsWith("'")) {
      const quote = rawValue[0];
      const closeIdx = rawValue.indexOf(quote!, 1);
      if (closeIdx === -1) {
        // Unclosed quote — multi-line value, out of scope.
        logger.warn(
          { ctx: "parseEnvExample", key },
          "skipping multi-line quoted value",
        );
        continue;
      }
      value = rawValue.slice(1, closeIdx);
    } else {
      // Strip inline `#` comment, then trim trailing whitespace
      const hash = rawValue.indexOf("#");
      value = (hash >= 0 ? rawValue.slice(0, hash) : rawValue).trimEnd();
    }

    out[key] = value;
  }

  return out;
}
