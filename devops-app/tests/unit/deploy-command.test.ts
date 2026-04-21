import { describe, it, expect } from "vitest";
import {
  buildDeployCommand,
  normaliseScriptInvocation,
} from "../../server/services/deploy-command.js";

describe("buildDeployCommand (FR-052 / FR-053 / SC-005)", () => {
  describe("classic mode (skipInitialClone=false)", () => {
    it("returns the script path unchanged for runScript to wrap in bash", () => {
      const r = buildDeployCommand({
        remotePath: "/opt/app",
        repoUrl: "git@github.com:acme/app.git",
        deployScript: "deploy.sh",
        skipInitialClone: false,
        branch: "main",
      });
      expect(r.mode).toBe("classic");
      expect(r.raw).toBe(false);
      expect(r.command).toBe("/opt/app/deploy.sh");
    });

    it("never inlines git clone/fetch — the script owns that in classic mode", () => {
      const r = buildDeployCommand({
        remotePath: "/opt/app",
        repoUrl: "git@github.com:acme/app.git",
        deployScript: "deploy.sh",
        skipInitialClone: false,
        branch: "main",
      });
      expect(r.command).not.toContain("git ");
      expect(r.command).not.toContain("clone");
      expect(r.command).not.toContain("fetch");
    });
  });

  describe("scan-git mode (SC-005 — no clone, uses FETCH_HEAD)", () => {
    it("uses `git fetch` + `git reset --hard FETCH_HEAD`, never `git clone`", () => {
      const r = buildDeployCommand({
        remotePath: "/opt/app",
        repoUrl: "git@github.com:acme/app.git",
        deployScript: "docker compose up -d",
        skipInitialClone: true,
        branch: "main",
      });
      expect(r.mode).toBe("scan-git");
      expect(r.raw).toBe(true);
      expect(r.command).toContain("git -c safe.directory='*' fetch --quiet origin 'main'");
      expect(r.command).toContain("git -c safe.directory='*' reset --hard FETCH_HEAD");
      expect(r.command).not.toContain("git clone");
      // Script snippet is appended at the end.
      expect(r.command.endsWith("docker compose up -d")).toBe(true);
    });

    it("cd's into single-quoted remotePath first", () => {
      const r = buildDeployCommand({
        remotePath: "/opt/a pp",
        repoUrl: "git@github.com:x/y.git",
        deployScript: "ls",
        skipInitialClone: true,
        branch: "main",
      });
      expect(r.command.startsWith("cd '/opt/a pp' && ")).toBe(true);
    });

    it("adds checkout <sha> when commit is specified", () => {
      const r = buildDeployCommand({
        remotePath: "/opt/app",
        repoUrl: "git@github.com:x/y.git",
        deployScript: "ls",
        skipInitialClone: true,
        branch: "main",
        commit: "deadbeef1234567",
      });
      expect(r.command).toContain("git -c safe.directory='*' checkout 'deadbeef1234567'");
    });

    it("applies `timeout` to each git command (FR-022 spirit)", () => {
      const r = buildDeployCommand({
        remotePath: "/opt/app",
        repoUrl: "git@github.com:x/y.git",
        deployScript: "ls",
        skipInitialClone: true,
        branch: "main",
      });
      const timeoutCount = (r.command.match(/timeout \d+s git /g) ?? []).length;
      expect(timeoutCount).toBeGreaterThanOrEqual(2); // fetch + reset
    });
  });

  describe("scan-docker mode (FR-053)", () => {
    it("skips ALL git operations when repoUrl starts with docker://", () => {
      const r = buildDeployCommand({
        remotePath: "/srv/stack",
        repoUrl: "docker:///srv/stack/docker-compose.yml",
        deployScript: "docker compose pull && docker compose up -d",
        skipInitialClone: true,
        branch: "-",
      });
      expect(r.mode).toBe("scan-docker");
      expect(r.raw).toBe(true);
      expect(r.command).not.toContain("git ");
      expect(r.command).not.toContain("FETCH_HEAD");
      expect(r.command).toBe(
        "cd '/srv/stack' && docker compose pull && docker compose up -d",
      );
    });

    it("does not run git commands even if branch is supplied", () => {
      const r = buildDeployCommand({
        remotePath: "/srv/stack",
        repoUrl: "docker://container-name",
        deployScript: "docker restart container-name",
        skipInitialClone: true,
        branch: "main",
        commit: "deadbeef1234567",
      });
      expect(r.command).not.toMatch(/\bgit\b/);
      expect(r.command).not.toContain("deadbeef");
    });
  });

  describe("normaliseScriptInvocation (PATH trap fix + .sh exec-perm fix)", () => {
    it("wraps bare .sh filenames with bash to bypass exec-perm", () => {
      // `./foo.sh` requires the exec bit, which often gets lost after git
      // clone when core.filemode is off. `bash foo.sh` sidesteps that.
      expect(normaliseScriptInvocation("deploy.sh")).toBe("bash ./deploy.sh");
      expect(normaliseScriptInvocation("scripts/server-deploy-prod.sh")).toBe(
        "bash ./scripts/server-deploy-prod.sh",
      );
    });

    it("wraps absolute .sh paths with bash too", () => {
      expect(normaliseScriptInvocation("/opt/scripts/deploy.sh")).toBe(
        "bash /opt/scripts/deploy.sh",
      );
    });

    it("wraps explicit relative .sh paths with bash", () => {
      expect(normaliseScriptInvocation("./deploy.sh")).toBe("bash ./deploy.sh");
      expect(normaliseScriptInvocation("../scripts/foo.sh")).toBe(
        "bash ../scripts/foo.sh",
      );
    });

    it("prefixes non-.sh bare filenames with ./ (no bash wrapping)", () => {
      expect(normaliseScriptInvocation("run")).toBe("./run");
      expect(normaliseScriptInvocation("build.py")).toBe("./build.py");
    });

    it("leaves non-.sh absolute paths untouched", () => {
      expect(normaliseScriptInvocation("/opt/scripts/run")).toBe(
        "/opt/scripts/run",
      );
    });

    it("leaves non-.sh explicit relative paths untouched", () => {
      expect(normaliseScriptInvocation("./run")).toBe("./run");
      expect(normaliseScriptInvocation("../scripts/run")).toBe("../scripts/run");
    });

    it("leaves command pipelines untouched", () => {
      expect(normaliseScriptInvocation("docker compose up -d")).toBe(
        "docker compose up -d",
      );
      expect(
        normaliseScriptInvocation("docker compose pull && docker compose up -d"),
      ).toBe("docker compose pull && docker compose up -d");
      expect(normaliseScriptInvocation("npm run deploy")).toBe("npm run deploy");
      expect(normaliseScriptInvocation("make deploy")).toBe("make deploy");
    });

    it("leaves well-known binary names untouched even without args", () => {
      expect(normaliseScriptInvocation("docker")).toBe("docker");
      expect(normaliseScriptInvocation("pm2")).toBe("pm2");
    });

    it("is invoked by buildDeployCommand for scan-git mode", () => {
      const r = buildDeployCommand({
        remotePath: "/opt/app",
        repoUrl: "git@github.com:x/y.git",
        deployScript: "deploy.sh",
        skipInitialClone: true,
        branch: "main",
      });
      // Bare "deploy.sh" must be wrapped so exec-perm is irrelevant.
      expect(r.command.endsWith("&& bash ./deploy.sh")).toBe(true);
    });

    it("is invoked by buildDeployCommand for scan-docker mode", () => {
      const r = buildDeployCommand({
        remotePath: "/srv/stack",
        repoUrl: "docker:///srv/stack/docker-compose.yml",
        deployScript: "run",
        skipInitialClone: true,
        branch: "-",
      });
      // "run" is not a .sh file → falls back to ./ prefix.
      expect(r.command).toBe("cd '/srv/stack' && ./run");
    });

    it("does NOT prefix command pipelines in scan-docker mode", () => {
      const r = buildDeployCommand({
        remotePath: "/srv/stack",
        repoUrl: "docker:///srv/stack/docker-compose.yml",
        deployScript: "docker compose up -d",
        skipInitialClone: true,
        branch: "-",
      });
      expect(r.command).toBe("cd '/srv/stack' && docker compose up -d");
    });

    it("does NOT affect classic mode (uses absolute path anyway)", () => {
      const r = buildDeployCommand({
        remotePath: "/opt/app",
        repoUrl: "git@github.com:x/y.git",
        deployScript: "deploy.sh",
        skipInitialClone: false,
        branch: "main",
      });
      expect(r.command).toBe("/opt/app/deploy.sh");
    });
  });

  describe("shell-quoting", () => {
    it("single-quote escapes remotePath containing a single quote", () => {
      const r = buildDeployCommand({
        remotePath: "/opt/o'dd",
        repoUrl: "docker://x",
        deployScript: "ls",
        skipInitialClone: true,
        branch: "-",
      });
      // POSIX: ' becomes '\''
      expect(r.command).toContain("'/opt/o'\\''dd'");
    });
  });
});
