/**
 * Feature 006 T051 — static verification of migration 0007.
 *
 * Asserts the migration SQL is well-formed. The actual postgres apply
 * happens in CI integration with a real cluster — these checks catch the
 * common drift modes (missing column, missing index, wrong CHECK predicate,
 * missing journal entry).
 *
 * Cases:
 *   (a) all 8 columns present on `applications` with correct types/defaults
 *       and CHECK constraints (interval ≥ 10, debounce ≥ 1)
 *   (b) `app_health_probes` table + 4 named indexes + XOR CHECK constraint
 *   (c) FK CASCADE to applications + servers
 *   (d) no UPDATE / backfill — additive only (existing rows get default
 *       health_status='unknown')
 *   (e) drizzle journal entry idx=7 tag='0007_app_health_monitoring'
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const MIG_PATH = path.resolve(
  __dirname,
  "../../server/db/migrations/0007_app_health_monitoring.sql",
);
const JOURNAL_PATH = path.resolve(
  __dirname,
  "../../server/db/migrations/meta/_journal.json",
);

describe("migration 0007 (T051)", () => {
  const sql = readFileSync(MIG_PATH, "utf8");
  const journal = JSON.parse(readFileSync(JOURNAL_PATH, "utf8")) as {
    entries: { tag: string; idx: number }[];
  };

  it("(a) all 8 health columns present on applications", () => {
    const cols = [
      ["health_url", "TEXT"],
      ["health_status", "TEXT"],
      ["health_checked_at", "TEXT"],
      ["health_last_change_at", "TEXT"],
      ["health_message", "TEXT"],
      ["health_probe_interval_sec", "INTEGER"],
      ["health_debounce_count", "INTEGER"],
      ["monitoring_enabled", "BOOLEAN"],
      ["alerts_muted", "BOOLEAN"],
    ];
    expect(cols.length).toBe(9); // 8 health + alerts_muted
    for (const [name, type] of cols) {
      const re = new RegExp(`ADD COLUMN\\s+"${name}"\\s+${type}`, "i");
      expect(sql).toMatch(re);
    }
    // Defaults
    expect(sql).toMatch(/"health_status"\s+TEXT NOT NULL DEFAULT 'unknown'/);
    expect(sql).toMatch(/"health_probe_interval_sec"\s+INTEGER NOT NULL DEFAULT 60/);
    expect(sql).toMatch(/"health_debounce_count"\s+INTEGER NOT NULL DEFAULT 2/);
    expect(sql).toMatch(/"monitoring_enabled"\s+BOOLEAN NOT NULL DEFAULT TRUE/);
    expect(sql).toMatch(/"alerts_muted"\s+BOOLEAN NOT NULL DEFAULT FALSE/);
  });

  it("(a2) CHECK constraints — interval ≥10, debounce ≥1", () => {
    expect(sql).toMatch(/applications_health_probe_interval_min[\s\S]*health_probe_interval_sec"?\s*>=\s*10/);
    expect(sql).toMatch(/applications_health_debounce_min[\s\S]*health_debounce_count"?\s*>=\s*1/);
  });

  it("(b) app_health_probes table + 4 indexes + XOR CHECK", () => {
    expect(sql).toMatch(/CREATE TABLE\s+"app_health_probes"/);
    // 4 named indexes per data-model.md
    expect(sql).toMatch(/CREATE INDEX\s+"idx_app_health_probes_app_probed"/);
    expect(sql).toMatch(/CREATE INDEX\s+"idx_app_health_probes_server_probed"/);
    expect(sql).toMatch(/CREATE INDEX\s+"idx_app_health_probes_app_type_outcome"/);
    expect(sql).toMatch(/CREATE INDEX\s+"idx_app_health_probes_probed"/);
    // XOR
    expect(sql).toMatch(/app_health_probes_subject_xor/);
    expect(sql).toMatch(
      /CHECK[\s\S]*app_id IS NOT NULL AND server_id IS NULL[\s\S]*app_id IS NULL AND server_id IS NOT NULL/,
    );
  });

  it("(c) FK CASCADE on applications + servers", () => {
    expect(sql).toMatch(
      /"app_id"[\s\S]*REFERENCES\s+"applications"\("id"\)\s+ON DELETE CASCADE/,
    );
    expect(sql).toMatch(
      /"server_id"[\s\S]*REFERENCES\s+"servers"\("id"\)\s+ON DELETE CASCADE/,
    );
  });

  it("(d) no UPDATE / backfill in the migration", () => {
    // Existing apps inherit DEFAULT 'unknown' on health_status — no row
    // rewrite needed and the migration must not perform one (would block on
    // large tables under exclusive lock).
    expect(sql).not.toMatch(/^\s*UPDATE\s+"?applications"?\s+SET/im);
  });

  it("(e) registered in the drizzle journal at idx=7", () => {
    const entry = journal.entries.find(
      (e) => e.tag === "0007_app_health_monitoring",
    );
    expect(entry).toBeDefined();
    expect(entry?.idx).toBe(7);
  });
});
