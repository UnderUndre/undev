/**
 * Feature 005 T040: deploy-dispatch assertions via resolveDeployOperation.
 * The runtime end-to-end path is covered by scripts-runner.test.ts; this
 * test focuses on the pure dispatch function + the shape of params given
 * to the runner for each app flavour.
 */
import { describe, it, expect } from "vitest";
import { resolveDeployOperation } from "../../server/services/deploy-dispatch.js";

describe("deploy dispatch (feature 005 T040)", () => {
  it("classic git → deploy/server-deploy with appDir", () => {
    const r = resolveDeployOperation(
      {
        repoUrl: "git@github.com:a/b.git",
        skipInitialClone: false,
        remotePath: "/opt/app",
        branch: "main",
      },
      { commit: "abc1234" },
    );
    expect(r).toEqual({
      scriptId: "deploy/server-deploy",
      params: { appDir: "/opt/app" },
    });
  });

  it("scan-docker → deploy/deploy-docker", () => {
    const r = resolveDeployOperation(
      {
        repoUrl: "docker:///srv/x",
        skipInitialClone: true,
        remotePath: "/srv/x",
        branch: "-",
      },
      {},
    );
    expect(r.scriptId).toBe("deploy/deploy-docker");
    expect(r.params.remotePath).toBe("/srv/x");
  });

  it("scan-git → deploy/server-deploy", () => {
    const r = resolveDeployOperation(
      {
        repoUrl: "git@github.com:a/b.git",
        skipInitialClone: true,
        remotePath: "/opt/app",
        branch: "main",
      },
      {},
    );
    expect(r.scriptId).toBe("deploy/server-deploy");
    expect(r.params.appDir).toBe("/opt/app");
  });
});
