/**
 * Feature 009: slug derivation per FR-006.
 *
 * Derivation pipeline (deterministic, one-shot):
 *   1. NFD-decompose + diacritic strip ("Café" → "Cafe", "Naïve" → "Naive")
 *   2. transliterate non-ASCII via the `transliteration` npm dep
 *      ("Россия" → "Rossiya", "Αθήνα" → "Athina")
 *   3. lowercase
 *   4. replace any non-[a-z0-9]+ run with single "-"
 *   5. trim leading/trailing "-"
 *   6. truncate to 64 chars
 *   7. fallback `repo-<sha256(originalRepoName).slice(0,8)>` if empty
 *
 * Post-condition (programmer error if violated): result MUST match
 * `/^[a-z0-9]+(-[a-z0-9]+)*$/`. The fallback guarantees a valid slug for
 * every conceivable input including emoji-only and CJK without table
 * coverage. See spec.md FR-006 + Edge Cases for rationale.
 */

import { createHash } from "node:crypto";
import { transliterate } from "transliteration";
import { and, eq, ne } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { applications } from "../db/schema.js";

export const SLUG_REGEX = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const DIACRITICS_RE = /\p{Diacritic}/gu;
const NON_ALNUM_RUN = /[^a-z0-9]+/g;
const LEADING_TRAILING_DASH = /^-+|-+$/g;

export function deriveSlug(repoName: string): string {
  const decomposed = repoName.normalize("NFD").replace(DIACRITICS_RE, "");
  const ascii = transliterate(decomposed);
  const cleaned = ascii
    .toLowerCase()
    .replace(NON_ALNUM_RUN, "-")
    .replace(LEADING_TRAILING_DASH, "")
    .slice(0, 64)
    .replace(LEADING_TRAILING_DASH, "");

  const slug = cleaned === "" ? fallbackSlug(repoName) : cleaned;

  if (!SLUG_REGEX.test(slug)) {
    // Programmer error — fallback should always produce a valid slug.
    throw new Error(
      `slug invariant broken: input=${JSON.stringify(repoName)} produced=${JSON.stringify(slug)}`,
    );
  }
  return slug;
}

function fallbackSlug(repoName: string): string {
  const hash = createHash("sha256").update(repoName).digest("hex").slice(0, 8);
  return `repo-${hash}`;
}

export type ValidateSlugResult =
  | { ok: true; value: string }
  | { ok: false; error: string };

const FORBIDDEN_CHARS = /[\s/\\.;|&$()`<>"'?*]/;

export function validateSlug(slug: string): ValidateSlugResult {
  if (typeof slug !== "string") {
    return { ok: false, error: "Slug must be a string" };
  }
  if (slug.length === 0) return { ok: false, error: "Slug cannot be empty" };
  if (slug.length > 64) return { ok: false, error: "Slug must be ≤64 characters" };
  if (FORBIDDEN_CHARS.test(slug)) {
    return { ok: false, error: "Slug contains forbidden characters" };
  }
  if (slug.includes("..")) {
    return { ok: false, error: "Slug cannot contain `..`" };
  }
  if (!SLUG_REGEX.test(slug)) {
    return {
      ok: false,
      error: "Slug must match ^[a-z0-9]+(-[a-z0-9]+)*$",
    };
  }
  return { ok: true, value: slug };
}

/**
 * FR-027 — server-side uniqueness check. Slug is unique per-server,
 * matching feature 008's domain uniqueness scope (R-004).
 *
 * `excludeAppId` lets the Edit-Config flow pass its own row through
 * without a self-collision.
 */
export async function isSlugUniqueOnServer(
  db: PgDatabase<never>,
  serverId: string,
  slug: string,
  excludeAppId?: string,
): Promise<boolean> {
  const filter =
    excludeAppId !== undefined
      ? and(
          eq(applications.serverId, serverId),
          eq(applications.name, slug),
          ne(applications.id, excludeAppId),
        )
      : and(eq(applications.serverId, serverId), eq(applications.name, slug));
  const rows = await db
    .select({ id: applications.id })
    .from(applications)
    .where(filter)
    .limit(1);
  return rows.length === 0;
}
