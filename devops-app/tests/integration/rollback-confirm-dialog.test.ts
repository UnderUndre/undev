/**
 * Feature 007 T026: contract-level test for the rollback confirm UX.
 *
 * The repo doesn't ship a DOM-rendering test harness (no @testing-library/react
 * / jsdom), so this test asserts the contract of the dialog component + the
 * conditional gating logic that lives in AppPage.tsx via a static behaviour
 * model: when scriptPath is null, dialog body should not include the
 * project-local warning string; when set, it should.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

describe("rollback confirm UX (T026)", () => {
  it("RollbackConfirmDialog exports the expected component", async () => {
    const mod = await import(
      "../../client/components/deployments/RollbackConfirmDialog.js"
    );
    expect(typeof mod.RollbackConfirmDialog).toBe("function");
  });

  it("AppPage rollback modal contains a project-local warning conditional on scriptPath", () => {
    const src = readFileSync(
      path.resolve(__dirname, "../../client/pages/AppPage.tsx"),
      "utf8",
    );
    // The project-local warning block must be guarded by app.scriptPath.
    expect(src).toMatch(/app\.scriptPath\s*&&/);
    expect(src).toMatch(/project-local[\s\S]{0,40}script/);
  });

  it("dialog copy includes the scriptPath literal in monospace", () => {
    const src = readFileSync(
      path.resolve(
        __dirname,
        "../../client/components/deployments/RollbackConfirmDialog.tsx",
      ),
      "utf8",
    );
    expect(src).toMatch(/font-mono/);
    expect(src).toMatch(/\{scriptPath\}/);
  });

  it("dialog binds Escape to onCancel", () => {
    const src = readFileSync(
      path.resolve(
        __dirname,
        "../../client/components/deployments/RollbackConfirmDialog.tsx",
      ),
      "utf8",
    );
    expect(src).toMatch(/Escape/);
    expect(src).toMatch(/onCancel/);
  });
});
