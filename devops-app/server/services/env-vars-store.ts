/**
 * Feature 011 T034 — encrypted-at-rest per-app env-var storage.
 *
 * Storage layout (per data-model.md):
 *   applications.env_vars            — plaintext jsonb, lazy-deprecated.
 *   applications.env_vars_encrypted  — { "VAR": { ct, iv, tag }, ... } | NULL.
 *
 * Read precedence (R-011):
 *   env_vars_encrypted non-null  → decrypt and return
 *   else env_vars non-empty      → return plaintext (legacy)
 *   else                         → {}
 *
 * Write semantics (FR-011, FR-014):
 *   - Each value is sealed individually (per-key envelope blob).
 *   - On the first encrypted write, env_vars is cleared to '{}' atomically.
 *   - Audit row carries key lists only; values NEVER appear in payloads.
 *
 * Decryption is gated by `decryptForDispatch` — this is the single
 * sanctioned path through which deploys obtain plaintext (T036 wires
 * scripts-runner to call here instead of reading env_vars directly).
 */

import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "../db/index.js";
import { applications, auditEntries } from "../db/schema.js";
import { seal, open, type EnvelopeBlob } from "../lib/envelope-cipher.js";
import { logger } from "../lib/logger.js";

export type EnvVarMap = Record<string, string>;
export type EncryptedEnvVarMap = Record<string, EnvelopeBlob>;

export interface EnvVarsDiff {
  added: string[];
  removed: string[];
  changed: string[];
}

const PLACEHOLDER_RE = /^CHANGE_ME(_[A-Z0-9_]+)?$/i;

export function detectPlaceholders(vars: EnvVarMap): string[] {
  return Object.entries(vars)
    .filter(([, v]) => PLACEHOLDER_RE.test(v))
    .map(([k]) => k);
}

async function loadRow(appId: string) {
  const rows = await db
    .select({
      id: applications.id,
      envVars: applications.envVars,
      envVarsEncrypted: applications.envVarsEncrypted,
    })
    .from(applications)
    .where(eq(applications.id, appId))
    .limit(1);
  return rows[0] ?? null;
}

export async function load(appId: string): Promise<EnvVarMap> {
  const row = await loadRow(appId);
  if (!row) return {};
  if (row.envVarsEncrypted) {
    const out: EnvVarMap = {};
    for (const [k, blob] of Object.entries(row.envVarsEncrypted)) {
      out[k] = open(blob as EnvelopeBlob);
    }
    return out;
  }
  if (row.envVars && typeof row.envVars === "object") {
    return row.envVars as EnvVarMap;
  }
  return {};
}

/** Single sanctioned decryption callsite for the deploy/dispatch path. */
export async function decryptForDispatch(appId: string): Promise<EnvVarMap> {
  return load(appId);
}

export async function save(
  appId: string,
  vars: EnvVarMap,
  userId: string,
): Promise<EnvVarsDiff> {
  const before = await load(appId);
  const beforeKeys = new Set(Object.keys(before));
  const afterKeys = new Set(Object.keys(vars));

  const added = [...afterKeys].filter((k) => !beforeKeys.has(k));
  const removed = [...beforeKeys].filter((k) => !afterKeys.has(k));
  const changed = [...afterKeys].filter(
    (k) => beforeKeys.has(k) && before[k] !== vars[k],
  );

  const sealed: EncryptedEnvVarMap = {};
  for (const [k, v] of Object.entries(vars)) {
    sealed[k] = seal(v);
  }

  // Atomic: replace encrypted blob, clear plaintext column. Single UPDATE
  // ⇒ no partial-state window where both columns hold real data.
  await db
    .update(applications)
    .set({
      envVarsEncrypted: sealed,
      envVars: {},
    })
    .where(eq(applications.id, appId));

  await db.insert(auditEntries).values({
    id: randomUUID(),
    userId,
    action: "app.env_vars_changed",
    targetType: "application",
    targetId: appId,
    // Key lists only — values are NEVER in audit payloads.
    details: JSON.stringify({
      addedKeys: added,
      removedKeys: removed,
      changedKeys: changed,
    }),
    result: "success",
    timestamp: new Date().toISOString(),
  });

  logger.info(
    {
      ctx: "env-vars-store.save",
      appId,
      addedCount: added.length,
      removedCount: removed.length,
      changedCount: changed.length,
    },
    "env vars saved",
  );

  return { added, removed, changed };
}
