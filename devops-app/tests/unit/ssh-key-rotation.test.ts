/**
 * Feature 011 T048 — ssh-key-rotation surface tests.
 *
 * The 5-step flow involves SSH execution + DB writes; full integration
 * is the home of T049. Unit-level test exercises the public error
 * shapes and that the module compiles + exports the documented surface.
 */
import { describe, it, expect } from "vitest";
import {
  DeployLockHeldError,
} from "../../server/services/ssh-key-rotation.js";

describe("ssh-key-rotation public surface", () => {
  it("DeployLockHeldError carries retryAfterMs", () => {
    const e = new DeployLockHeldError(5_000);
    expect(e.retryAfterMs).toBe(5_000);
    expect(e.message).toContain("deploy lock held");
  });

  it("module exports rotateKey", async () => {
    const mod = await import(
      "../../server/services/ssh-key-rotation.js"
    );
    expect(typeof mod.rotateKey).toBe("function");
  });
});
