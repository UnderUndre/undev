/**
 * Feature 007 T029: regression guard — scanner code must never set scriptPath.
 *
 * Static check: grep the scanner sources for scriptPath / script_path references.
 * Any future PR that adds heuristic auto-detection of deploy scripts must
 * either remove this test or update the spec (FR-025).
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Glob } from "glob";

describe("scan boundary (T029, FR-025)", () => {
  it("no scanner source mentions scriptPath / script_path", async () => {
    const files: string[] = [];
    for await (const f of new Glob("devops-app/server/services/scanner*.ts", {
      cwd: path.resolve(__dirname, "../../.."),
    })) {
      files.push(f);
    }
    for (const f of files) {
      const src = readFileSync(
        path.resolve(__dirname, "../../..", f),
        "utf8",
      );
      expect(
        src,
        `${f} unexpectedly references scriptPath / script_path`,
      ).not.toMatch(/script_?[Pp]ath/);
    }
  });
});
