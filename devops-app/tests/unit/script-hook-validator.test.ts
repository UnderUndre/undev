/** Feature 010 T007 — script-hook-validator unit tests. */
import { describe, it, expect } from "vitest";
import { validateHookFields } from "../../server/lib/script-hook-validator.js";

const NULLS = {
  scriptPath: null,
  preDeployScriptPath: null,
  postDeployScriptPath: null,
  onFailScriptPath: null,
  preDestroyScriptPath: null,
};

describe("validateHookFields", () => {
  it("accepts all-null", () => {
    const r = validateHookFields(NULLS);
    expect(r.ok).toBe(true);
  });

  it("normalises empty strings to null", () => {
    const r = validateHookFields({ ...NULLS, preDeployScriptPath: "  " });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.preDeployScriptPath).toBeNull();
  });

  it("rejects leading slash", () => {
    const r = validateHookFields({ ...NULLS, preDeployScriptPath: "/abs/path.sh" });
    expect(r.ok).toBe(false);
  });

  it("rejects `..`", () => {
    const r = validateHookFields({ ...NULLS, preDeployScriptPath: "scripts/../etc/x.sh" });
    expect(r.ok).toBe(false);
  });

  it("rejects shell metachars", () => {
    const r = validateHookFields({ ...NULLS, preDeployScriptPath: "scripts/x;rm.sh" });
    expect(r.ok).toBe(false);
  });

  it("requires .sh extension", () => {
    const r = validateHookFields({ ...NULLS, preDeployScriptPath: "scripts/migrate.py" });
    expect(r.ok).toBe(false);
  });

  it("rejects > 256 chars", () => {
    const r = validateHookFields({
      ...NULLS,
      preDeployScriptPath: `${"a".repeat(260)}.sh`,
    });
    expect(r.ok).toBe(false);
  });

  it("script_path alone is fine", () => {
    const r = validateHookFields({ ...NULLS, scriptPath: "scripts/full.sh" });
    expect(r.ok).toBe(true);
  });

  it("hooks alone are fine", () => {
    const r = validateHookFields({
      ...NULLS,
      preDeployScriptPath: "scripts/migrate.sh",
      postDeployScriptPath: "scripts/notify.sh",
    });
    expect(r.ok).toBe(true);
  });

  it("script_path + hook → mutually exclusive", () => {
    const r = validateHookFields({
      ...NULLS,
      scriptPath: "scripts/full.sh",
      preDeployScriptPath: "scripts/migrate.sh",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("script_path_hooks_mutually_exclusive");
    }
  });

  it("script_path + multiple hooks lists every set hook", () => {
    const r = validateHookFields({
      ...NULLS,
      scriptPath: "scripts/full.sh",
      preDeployScriptPath: "scripts/a.sh",
      postDeployScriptPath: "scripts/b.sh",
    });
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.code === "script_path_hooks_mutually_exclusive") {
      expect(r.error.setHooks).toContain("preDeployScriptPath");
      expect(r.error.setHooks).toContain("postDeployScriptPath");
    }
  });
});
