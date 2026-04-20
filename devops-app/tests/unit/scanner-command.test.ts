import { describe, it, expect } from "vitest";
import {
  buildScanCommand,
  InvalidScanRootError,
} from "../../server/services/scanner-command.js";

describe("buildScanCommand", () => {
  const roots = ["/opt", "/srv"];

  it("wraps pipeline in `timeout --kill-after=5s 60 bash -c` (FR-062)", () => {
    const cmd = buildScanCommand(roots);
    expect(cmd.startsWith("timeout --kill-after=5s 60 bash -c '")).toBe(true);
  });

  it("emits `find -P -xdev -maxdepth 6` (FR-005)", () => {
    const cmd = buildScanCommand(roots);
    expect(cmd).toContain("find -P");
    expect(cmd).toContain("-xdev");
    expect(cmd).toContain("-maxdepth 6");
  });

  it("precedes every `git -C` with `timeout 3s` and `safe.directory='*'` (FR-021/022)", () => {
    const cmd = buildScanCommand(roots);
    const gitCalls = cmd.match(/timeout 3s git -c safe\.directory='\\''\*'\\'' -C/g) ?? [];
    expect(gitCalls.length).toBeGreaterThanOrEqual(5); // branch, sha, remote, status, log
  });

  it("invokes `docker compose config --format json` gated on docker presence (FR-032)", () => {
    const cmd = buildScanCommand(roots);
    expect(cmd).toContain("docker compose");
    expect(cmd).toContain("config --format json");
    expect(cmd).toContain("command -v docker");
  });

  it("rejects shell metacharacters (including single-quote)", () => {
    expect(() => buildScanCommand(["/opt;ls"])).toThrow(InvalidScanRootError);
    expect(() => buildScanCommand(["/opt`ls`"])).toThrow(InvalidScanRootError);
    expect(() => buildScanCommand(['/opt"bad'])).toThrow(InvalidScanRootError);
    expect(() => buildScanCommand(["/o'pt"])).toThrow(InvalidScanRootError);
    // Paths with single-quotes are vanishingly rare; rejecting defensively
    // simplifies the outer shell escaping (which uses single-quote wrapping).
  });

  it("wraps accepted paths in single-quotes in the emitted command", () => {
    const cmd = buildScanCommand(["/opt", "/srv"]);
    // Quoted roots appear in the pipeline's `find -P '/opt' '/srv' ...` form.
    expect(cmd).toContain("'/opt'");
    expect(cmd).toContain("'/srv'");
  });

  it("rejects relative paths", () => {
    expect(() => buildScanCommand(["opt"])).toThrow(InvalidScanRootError);
  });

  it("rejects empty roots array", () => {
    expect(() => buildScanCommand([])).toThrow(InvalidScanRootError);
  });

  it("rejects more than 20 roots", () => {
    const many = Array.from({ length: 21 }, (_, i) => `/root${i}`);
    expect(() => buildScanCommand(many)).toThrow(InvalidScanRootError);
  });

  it("rejects path longer than 512 chars", () => {
    const long = "/" + "a".repeat(512);
    expect(() => buildScanCommand([long])).toThrow(InvalidScanRootError);
  });
});
