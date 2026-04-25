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

  // ── Feature 007 (T010): scriptPath dispatch ──────────────────────────────

  it("scriptPath set + manual+git → project-local", () => {
    const r = resolveDeployOperation(
      {
        source: "manual",
        repoUrl: "git@github.com:x/y.git",
        skipInitialClone: false,
        remotePath: "/opt/app",
        branch: "main",
        scriptPath: "scripts/devops-deploy.sh",
      },
      {},
    );
    expect(r.scriptId).toBe("deploy/project-local-deploy");
    expect(r.params).toMatchObject({
      appDir: "/opt/app",
      scriptPath: "scripts/devops-deploy.sh",
      branch: "main",
      noCache: false,
      skipCleanup: false,
    });
  });

  it("scriptPath set + scan+git → project-local (overrides scan heuristic)", () => {
    const r = resolveDeployOperation(
      {
        source: "scan",
        repoUrl: "git@github.com:x/y.git",
        skipInitialClone: true,
        remotePath: "/opt/app",
        branch: "main",
        scriptPath: "scripts/deploy.sh",
      },
      { commit: "abcdef0" },
    );
    expect(r.scriptId).toBe("deploy/project-local-deploy");
    expect(r.params).toMatchObject({ commit: "abcdef0" });
  });

  it("scriptPath set + docker:// → project-local (overrides docker heuristic)", () => {
    const r = resolveDeployOperation(
      {
        source: "scan",
        repoUrl: "docker:///srv/stack",
        skipInitialClone: true,
        remotePath: "/srv/stack",
        branch: "-",
        scriptPath: "scripts/deploy.sh",
      },
      {},
    );
    expect(r.scriptId).toBe("deploy/project-local-deploy");
  });

  it("scriptPath null + manual+git → server-deploy (regression)", () => {
    const r = resolveDeployOperation(
      {
        source: "manual",
        repoUrl: "git@github.com:x/y.git",
        skipInitialClone: false,
        remotePath: "/opt/app",
        branch: "main",
        scriptPath: null,
      },
      {},
    );
    expect(r.scriptId).toBe("deploy/server-deploy");
  });

  it("scriptPath null + scan+git+skipInitialClone → server-deploy (regression)", () => {
    const r = resolveDeployOperation(
      {
        source: "scan",
        repoUrl: "git@github.com:x/y.git",
        skipInitialClone: true,
        remotePath: "/opt/app",
        branch: "main",
        scriptPath: null,
      },
      {},
    );
    expect(r.scriptId).toBe("deploy/server-deploy");
  });

  it("scriptPath null + docker:// → deploy-docker (regression)", () => {
    const r = resolveDeployOperation(
      {
        source: "scan",
        repoUrl: "docker:///srv/stack",
        skipInitialClone: true,
        remotePath: "/srv/stack",
        branch: "-",
        scriptPath: null,
      },
      {},
    );
    expect(r.scriptId).toBe("deploy/deploy-docker");
  });
});
