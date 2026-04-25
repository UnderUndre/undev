import { describe, it, expect } from "vitest";
import {
  buildProjectLocalCommand,
  NON_INTERACTIVE_ENV_PREFIX,
} from "../../server/services/build-project-local-command.js";

describe("buildProjectLocalCommand (T011/T012)", () => {
  const base = {
    appDir: "/opt/app",
    scriptPath: "scripts/devops-deploy.sh",
    branch: "main",
  };

  it("happy path", () => {
    expect(buildProjectLocalCommand(base)).toBe(
      "NON_INTERACTIVE=1 DEBIAN_FRONTEND=noninteractive CI=true bash '/opt/app'/'scripts/devops-deploy.sh' --app-dir='/opt/app' --branch='main'",
    );
  });

  it("includes commit when present", () => {
    const cmd = buildProjectLocalCommand({ ...base, commit: "abc123" });
    expect(cmd).toContain("--commit='abc123'");
  });

  it("omits commit when absent", () => {
    expect(buildProjectLocalCommand(base)).not.toContain("--commit");
  });

  it("emits both bool flags when set", () => {
    const cmd = buildProjectLocalCommand({
      ...base,
      noCache: true,
      skipCleanup: true,
    });
    expect(cmd).toContain("--no-cache");
    expect(cmd).toContain("--skip-cleanup");
  });

  it("omits bool flags when false/undefined", () => {
    const cmd = buildProjectLocalCommand({
      ...base,
      noCache: false,
      skipCleanup: false,
    });
    expect(cmd).not.toContain("--no-cache");
    expect(cmd).not.toContain("--skip-cleanup");
  });

  it("shQuote-escapes appDir with single quote", () => {
    const cmd = buildProjectLocalCommand({ ...base, appDir: "/opt/o'app" });
    expect(cmd).toContain("'/opt/o'\\''app'");
  });

  it("shQuote-escapes appDir with spaces", () => {
    const cmd = buildProjectLocalCommand({ ...base, appDir: "/opt/my app" });
    expect(cmd).toContain("'/opt/my app'");
  });

  it("shQuote-escapes branch with single quote", () => {
    const cmd = buildProjectLocalCommand({ ...base, branch: "feat/o'brien" });
    expect(cmd).toContain("--branch='feat/o'\\''brien'");
  });

  it("handles long values", () => {
    const cmd = buildProjectLocalCommand({
      ...base,
      appDir: "/opt/" + "a".repeat(500),
    });
    expect(cmd.length).toBeGreaterThan(500);
  });

  it("env prefix is constant and starts every command (regression guard)", () => {
    const variants = [
      base,
      { ...base, commit: "deadbee" },
      { ...base, noCache: true },
      { ...base, skipCleanup: true },
      { ...base, noCache: true, skipCleanup: true, commit: "feedface" },
      { ...base, appDir: "/x/y", scriptPath: "deploy.sh", branch: "release" },
    ];
    for (const v of variants) {
      const cmd = buildProjectLocalCommand(v);
      expect(cmd.startsWith(NON_INTERACTIVE_ENV_PREFIX + " ")).toBe(true);
    }
  });

  it("script path concatenation uses literal slash", () => {
    const cmd = buildProjectLocalCommand({
      ...base,
      appDir: "/a",
      scriptPath: "b.sh",
    });
    expect(cmd).toContain("'/a'/'b.sh'");
  });

  it("env constants present individually", () => {
    const cmd = buildProjectLocalCommand(base);
    expect(cmd).toContain("NON_INTERACTIVE=1");
    expect(cmd).toContain("DEBIAN_FRONTEND=noninteractive");
    expect(cmd).toContain("CI=true");
  });
});
