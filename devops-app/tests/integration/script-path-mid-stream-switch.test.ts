/**
 * Feature 007 T034: US-5 mid-stream switch.
 *
 * Pure-function level — `resolveDeployOperation` is the dispatch oracle.
 * Walks: null → set → null and asserts the scriptId flips deterministically.
 */

import { describe, it, expect } from "vitest";
import { resolveDeployOperation } from "../../server/services/deploy-dispatch.js";

describe("script-path mid-stream switch (T034, FR-015)", () => {
  const baseApp = {
    source: "manual" as const,
    repoUrl: "git@github.com:x/y.git",
    skipInitialClone: false,
    remotePath: "/opt/app",
    branch: "main",
  };

  it("scriptPath: null → server-deploy", () => {
    const r = resolveDeployOperation({ ...baseApp, scriptPath: null }, {});
    expect(r.scriptId).toBe("deploy/server-deploy");
  });

  it("scriptPath: set → project-local", () => {
    const r = resolveDeployOperation(
      { ...baseApp, scriptPath: "scripts/devops-deploy.sh" },
      {},
    );
    expect(r.scriptId).toBe("deploy/project-local-deploy");
  });

  it("scriptPath: cleared back to null → server-deploy (reversibility)", () => {
    const r = resolveDeployOperation({ ...baseApp, scriptPath: null }, {});
    expect(r.scriptId).toBe("deploy/server-deploy");
  });
});
