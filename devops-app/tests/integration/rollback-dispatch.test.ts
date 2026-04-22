/**
 * Feature 005 T042: rollback via the new runner path.
 * Scripts-runner receives ("deploy/server-rollback", serverId, {remotePath, commit}, userId).
 */
import { describe, it, expect } from "vitest";
import { manifest } from "../../server/scripts-manifest.js";

describe("rollback dispatch (feature 005 T042)", () => {
  it("deploy/rollback entry exists in manifest with requiresLock", () => {
    const e = manifest.find((x) => x.id === "deploy/server-rollback");
    expect(e).toBeDefined();
    expect(e!.requiresLock).toBe(true);
  });

  it("deploy/server-rollback params schema requires appDir + commit", () => {
    const e = manifest.find((x) => x.id === "deploy/server-rollback")!;
    expect(() => e.params.parse({})).toThrow();
    expect(() =>
      e.params.parse({ appDir: "/opt/x", commit: "abc1234" }),
    ).not.toThrow();
  });
});
