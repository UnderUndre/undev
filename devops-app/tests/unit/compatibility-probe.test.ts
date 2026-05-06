/** Feature 011 T025 — compatibility probe parser invariants. */
import { describe, it, expect } from "vitest";
import { buildReportFromFields } from "../../server/services/compatibility-probe.js";

describe("buildReportFromFields", () => {
  function fullPass(): Record<string, string> {
    return {
      SSH_OK: "true",
      SUDO_NOPASSWD: "true",
      USE_PTY: "false",
      DOCKER: "26.1.0",
      DISK_FREE_GB: "50",
      SWAP: "true",
      OS_FAMILY: "debian",
      OS_VERSION: "22.04",
      ARCH: "x86_64",
    };
  }

  it("a fully-ready Ubuntu host yields overall=pass", () => {
    const r = buildReportFromFields(fullPass(), "vanilla");
    expect(r.overall).toBe("pass");
    expect(r.checks.every((c) => c.status === "pass")).toBe(true);
    expect(r.hints).toEqual([]);
  });

  it("missing docker → warn (auto-fixable)", () => {
    const fields = { ...fullPass(), DOCKER: "" };
    const r = buildReportFromFields(fields, "vanilla");
    expect(r.overall).toBe("warn");
    const docker = r.checks.find((c) => c.id === "docker.present")!;
    expect(docker.status).toBe("warn");
    expect(docker.autoFixableByInitialise).toBe(true);
    expect(docker.action).toBe("initialise");
  });

  it("UsePTY=true → warn with initialise remediation", () => {
    const fields = { ...fullPass(), USE_PTY: "true" };
    const r = buildReportFromFields(fields, "gcp");
    const usePty = r.checks.find((c) => c.id === "ssh.use_pty")!;
    expect(usePty.status).toBe("warn");
    expect(usePty.action).toBe("initialise");
  });

  it("disk < 5G → fail", () => {
    const fields = { ...fullPass(), DISK_FREE_GB: "3" };
    const r = buildReportFromFields(fields, "vanilla");
    expect(r.overall).toBe("fail");
    const disk = r.checks.find((c) => c.id === "disk.free")!;
    expect(disk.status).toBe("fail");
  });

  it("disk 5..10G → warn", () => {
    const fields = { ...fullPass(), DISK_FREE_GB: "8" };
    const r = buildReportFromFields(fields, "vanilla");
    const disk = r.checks.find((c) => c.id === "disk.free")!;
    expect(disk.status).toBe("warn");
  });

  it("ARM64 architecture → warn", () => {
    const fields = { ...fullPass(), ARCH: "aarch64" };
    const r = buildReportFromFields(fields, "vanilla");
    const arch = r.checks.find((c) => c.id === "arch")!;
    expect(arch.status).toBe("warn");
  });

  it("missing swap → warn (initialise)", () => {
    const fields = { ...fullPass(), SWAP: "false" };
    const r = buildReportFromFields(fields, "vanilla");
    const swap = r.checks.find((c) => c.id === "swap.present")!;
    expect(swap.status).toBe("warn");
    expect(swap.autoFixableByInitialise).toBe(true);
  });

  it("GCP cloudProvider injects use_pty hint into report.hints", () => {
    const r = buildReportFromFields(fullPass(), "gcp");
    expect(r.hints.some((h) => h.includes("use_pty"))).toBe(true);
  });

  it("vanilla cloudProvider yields no hints", () => {
    expect(buildReportFromFields(fullPass(), "vanilla").hints).toEqual([]);
  });

  it("empty input maps SSH_OK absence to fail", () => {
    const r = buildReportFromFields({}, "vanilla");
    expect(r.overall).toBe("fail");
    const ssh = r.checks.find((c) => c.id === "ssh.connect")!;
    expect(ssh.status).toBe("fail");
  });

  it("ID_LIKE=ubuntu maps to supported family (debian-derived)", () => {
    const fields = { ...fullPass(), OS_FAMILY: "ubuntu" };
    const r = buildReportFromFields(fields, "vanilla");
    const os = r.checks.find((c) => c.id === "os.family")!;
    // Note: matches via family.includes("debian") fallback; explicit
    // "ubuntu" alone passes through SUPPORTED_OS_FAMILIES set check.
    expect(os.status === "pass" || os.status === "warn").toBe(true);
  });
});
