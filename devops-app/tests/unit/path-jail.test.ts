/** Feature 009 T059 — path-jail escape suite. */
import { describe, it, expect } from "vitest";
import { resolveAndJailCheck, assertJailed } from "../../server/lib/path-jail.js";
import { PathJailEscapeError } from "../../server/lib/bootstrap-errors.js";

const JAIL = "/home/deploy/apps";

function mockExec(stdout: string, exitCode = 0) {
  return async (_serverId: string, _cmd: string) => ({
    exitCode,
    stdout,
    stderr: "",
  });
}

describe("path-jail", () => {
  it("accepts a path inside the jail", async () => {
    const r = await resolveAndJailCheck(mockExec("/home/deploy/apps/foo\n"), "s1", "/home/deploy/apps/foo", JAIL);
    expect(r).toEqual({ ok: true, resolved: "/home/deploy/apps/foo" });
  });

  it("accepts the jail root itself", async () => {
    const r = await resolveAndJailCheck(mockExec("/home/deploy/apps\n"), "s1", "/home/deploy/apps", JAIL);
    expect(r.ok).toBe(true);
  });

  it("rejects parent traversal escape", async () => {
    const r = await resolveAndJailCheck(mockExec("/etc\n"), "s1", "/home/deploy/apps/../../../etc", JAIL);
    expect(r.ok).toBe(false);
  });

  it("rejects symlink to /", async () => {
    const r = await resolveAndJailCheck(mockExec("/\n"), "s1", "/home/deploy/apps/sym", JAIL);
    expect(r.ok).toBe(false);
  });

  it("rejects /home/deploy/apps2 (trailing-slash sneak)", async () => {
    const r = await resolveAndJailCheck(mockExec("/home/deploy/apps2/foo\n"), "s1", "/home/deploy/apps2/foo", JAIL);
    expect(r.ok).toBe(false);
  });

  it("rejects when readlink returns nothing", async () => {
    const r = await resolveAndJailCheck(mockExec("\n", 1), "s1", "/missing", JAIL);
    expect(r.ok).toBe(false);
  });

  it("rejects empty remotePath", async () => {
    const r = await resolveAndJailCheck(mockExec(""), "s1", "", JAIL);
    expect(r.ok).toBe(false);
  });

  it("rejects relative jail root", async () => {
    const r = await resolveAndJailCheck(mockExec("/foo"), "s1", "/foo", "apps");
    expect(r.ok).toBe(false);
  });

  it("assertJailed throws PathJailEscapeError on escape", async () => {
    await expect(
      assertJailed(mockExec("/etc\n"), "s1", "/home/deploy/apps/sym", JAIL),
    ).rejects.toBeInstanceOf(PathJailEscapeError);
  });

  it("assertJailed returns resolved path on success", async () => {
    const resolved = await assertJailed(
      mockExec("/home/deploy/apps/foo\n"),
      "s1",
      "/home/deploy/apps/foo",
      JAIL,
    );
    expect(resolved).toBe("/home/deploy/apps/foo");
  });
});
