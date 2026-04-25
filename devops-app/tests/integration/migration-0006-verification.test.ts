/**
 * Feature 007 T028: static verification of migration 0006.
 *
 * Asserts the migration SQL contains the additive ADD COLUMN + CHECK constraint
 * and is registered in the journal. Runs without a live DB — the actual
 * postgres apply happens in CI integration with a real cluster.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const MIG_PATH = path.resolve(
  __dirname,
  "../../server/db/migrations/0006_project_local_deploy.sql",
);
const JOURNAL_PATH = path.resolve(
  __dirname,
  "../../server/db/migrations/meta/_journal.json",
);

describe("migration 0006 (T028)", () => {
  const sql = readFileSync(MIG_PATH, "utf8");
  const journal = JSON.parse(readFileSync(JOURNAL_PATH, "utf8")) as {
    entries: { tag: string; idx: number }[];
  };

  it("ADD COLUMN script_path nullable with no default", () => {
    expect(sql).toMatch(/ALTER TABLE\s+"applications"\s+ADD COLUMN\s+"script_path"\s+TEXT\s*;/);
    expect(sql).not.toMatch(/script_path.*DEFAULT/i);
    expect(sql).not.toMatch(/script_path.*NOT NULL/i);
  });

  it("CHECK constraint disallows '' / all-whitespace", () => {
    expect(sql).toMatch(/applications_script_path_non_empty/);
    expect(sql).toMatch(/CHECK[\s\S]*script_path[\s\S]*IS NULL[\s\S]*LENGTH\(TRIM/);
  });

  it("no UPDATE / backfill in the migration", () => {
    expect(sql).not.toMatch(/^\s*UPDATE\s+/im);
  });

  it("registered in the drizzle journal", () => {
    const entry = journal.entries.find(
      (e) => e.tag === "0006_project_local_deploy",
    );
    expect(entry).toBeDefined();
    expect(entry?.idx).toBe(6);
  });
});
