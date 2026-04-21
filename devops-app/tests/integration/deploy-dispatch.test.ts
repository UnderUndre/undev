/**
 * Feature 005 T040: deploy-dispatch assertions via resolveDeployOperation.
 * The runtime end-to-end path is covered by scripts-runner.test.ts; this
 * test focuses on the pure dispatch function + the shape of params given
 * to the runner for each app flavour.
 */
import { describe, it, expect } from "vitest";
import { resolveDeployOperation } from "../../server/services/deploy-dispatch.js";

describe("deploy dispatch (feature 005 T040)", () => {
  it("classic git → deploy/deploy with branch + commit", () => {
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
      scriptId: "deploy/deploy",
      params: {
        remotePath: "/opt/app",
        branch: "main",
        commit: "abc1234",
        skipInitialClone: false,
      },
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
  });

  it("scan-git → deploy/deploy preserves skipInitialClone=true", () => {
    const r = resolveDeployOperation(
      {
        repoUrl: "git@github.com:a/b.git",
        skipInitialClone: true,
        remotePath: "/opt/app",
        branch: "main",
      },
      {},
    );
    expect(r.scriptId).toBe("deploy/deploy");
    expect(r.params.skipInitialClone).toBe(true);
  });
});
