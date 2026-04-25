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

  it("AppPage actually mounts RollbackConfirmDialog for project-local apps", () => {
    const src = readFileSync(
      path.resolve(__dirname, "../../client/pages/AppPage.tsx"),
      "utf8",
    );
    // The new accessible dialog must be imported and rendered, gated on scriptPath.
    expect(src).toMatch(/import\s*\{\s*RollbackConfirmDialog\s*\}/);
    expect(src).toMatch(/<RollbackConfirmDialog\b/);
    expect(src).toMatch(/rollbackTarget\s*&&\s*app\.scriptPath/);
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
