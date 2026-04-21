/**
 * Feature 005 T048: pruneOldRuns() log-ownership semantics.
 *
 * Only standalone runs (deployment_id = NULL) own their log file. Deploy-linked
 * runs share the log path with a `deployments` row which is the authoritative
 * owner per feature 001 retention — we DELETE the script_runs row but MUST
 * NOT unlink the file.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const returnedRows: { owned_log_path: string | null }[] = [];
const unlinked: string[] = [];

vi.mock("../../server/db/index.js", () => ({
  db: {
    execute: vi.fn(async () => returnedRows),
  },
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const real = (await importOriginal()) as object;
  return {
    ...real,
    unlink: vi.fn(async (p: string) => {
      if (p.includes("enoent")) {
        const err = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        throw err;
      }
      unlinked.push(p);
    }),
    readFile: (real as { readFile: unknown }).readFile,
  };
});

describe("scripts-runner prune (feature 005 T048)", () => {
  beforeEach(() => {
    returnedRows.length = 0;
    unlinked.length = 0;
    vi.resetModules();
  });

  it("unlinks only rows with owned_log_path (deployment_id IS NULL)", async () => {
    returnedRows.push(
      { owned_log_path: "/app/data/logs/standalone-1.log" },
      { owned_log_path: null }, // linked to a deployments row
      { owned_log_path: "/app/data/logs/standalone-2.log" },
    );
    const { scriptsRunner } = await import(
      "../../server/services/scripts-runner.js"
    );
    const result = await scriptsRunner.pruneOldRuns();
    expect(result.deletedRows).toBe(3);
    expect(result.deletedLogFiles).toBe(2);
    expect(unlinked).toEqual([
      "/app/data/logs/standalone-1.log",
      "/app/data/logs/standalone-2.log",
    ]);
  });

  it("swallows ENOENT on unlink (file already gone)", async () => {
    returnedRows.push({ owned_log_path: "/app/data/logs/enoent.log" });
    const { scriptsRunner } = await import(
      "../../server/services/scripts-runner.js"
    );
    await expect(scriptsRunner.pruneOldRuns()).resolves.toMatchObject({
      deletedRows: 1,
      deletedLogFiles: 0,
    });
  });

  it("start()/stop() with SCRIPT_RUNS_PRUNE_INTERVAL_MS=0 is a no-op", async () => {
    process.env.SCRIPT_RUNS_PRUNE_INTERVAL_MS = "0";
    const { scriptsRunner } = await import(
      "../../server/services/scripts-runner.js"
    );
    scriptsRunner.start();
    scriptsRunner.stop();
    delete process.env.SCRIPT_RUNS_PRUNE_INTERVAL_MS;
  });
});
