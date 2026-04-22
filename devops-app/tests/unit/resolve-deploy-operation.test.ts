import { describe, it, expect } from "vitest";
import { resolveDeployOperation } from "../../server/services/deploy-dispatch.js";

describe("resolveDeployOperation (feature 005 T033)", () => {
  it("manual git → deploy/server-deploy with appDir", () => {
    const r = resolveDeployOperation(
      {
        source: "manual",
        repoUrl: "git@github.com:x/y.git",
        skipInitialClone: false,
        remotePath: "/opt/app",
        branch: "main",
      },
      {},
    );
    expect(r.scriptId).toBe("deploy/server-deploy");
    expect(r.params).toMatchObject({ appDir: "/opt/app" });
  });

  it("manual docker with skipInitialClone → deploy/deploy-docker", () => {
    const r = resolveDeployOperation(
      {
        source: "manual",
        repoUrl: "docker://container-x",
        skipInitialClone: true,
        remotePath: "/srv/stack",
        branch: "-",
      },
      { commit: "abc123" },
    );
    expect(r.scriptId).toBe("deploy/deploy-docker");
    expect(r.params).toMatchObject({ remotePath: "/srv/stack" });
  });

  it("scan git with skipInitialClone=true → deploy/server-deploy", () => {
    const r = resolveDeployOperation(
      {
        source: "scan",
        repoUrl: "git@github.com:x/y.git",
        skipInitialClone: true,
        remotePath: "/opt/app",
        branch: "main",
      },
      {},
    );
    expect(r.scriptId).toBe("deploy/server-deploy");
    expect(r.params).toMatchObject({ appDir: "/opt/app" });
  });

  it("scan docker → deploy/deploy-docker", () => {
    const r = resolveDeployOperation(
      {
        source: "scan",
        repoUrl: "docker:///srv/stack",
        skipInitialClone: true,
        remotePath: "/srv/stack",
        branch: "-",
      },
      {},
    );
    expect(r.scriptId).toBe("deploy/deploy-docker");
  });
});
