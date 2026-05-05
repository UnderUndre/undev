/**
 * Feature 009 T060 — SC-003 zero-leak gate for PAT.
 *
 * Asserts the three-layer defence by constructing the actual params bundle
 * `bootstrap-orchestrator` would pass to `scriptsRunner.runScript`,
 * running it through the same `maskSecrets` + `serialiseParams` pipeline,
 * and grepping for PAT shapes in the masked output.
 *
 * The DB+SSH end-to-end variant lives in T029/T042 (which need a full test
 * harness); this one runs in a plain vitest worker and locks down the
 * regression surface.
 */
import { describe, it, expect } from "vitest";
import { manifest } from "../../server/scripts-manifest.js";
import { maskSecrets } from "../../server/lib/mask-secrets.js";
import { serialiseParams } from "../../server/lib/serialise-params.js";
import {
  containsPatPattern,
  scrubPatFromText,
} from "../../server/lib/pat-redact.js";

const SAMPLE_PAT = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";

describe("PAT leak gate (T060 / SC-003)", () => {
  it("manifest declares pat as secret on bootstrap/clone", () => {
    const entry = manifest.find((m) => m.id === "bootstrap/clone");
    expect(entry).toBeDefined();
    // Zod schema shape access varies by version (`shape`, `def.shape`,
    // `_def.shape` — the same fallback chain `serialiseParams` uses).
    const s = entry!.params as { shape?: unknown; def?: { shape?: unknown }; _def?: { shape?: unknown } };
    const raw = s.shape ?? s.def?.shape ?? s._def?.shape;
    const fields = (typeof raw === "function" ? (raw as () => unknown)() : raw) as
      | Record<string, { description?: string }>
      | undefined;
    expect(fields?.pat?.description).toBe("secret");
  });

  it("maskSecrets replaces pat with *** in script_runs.params", () => {
    const entry = manifest.find((m) => m.id === "bootstrap/clone");
    const masked = maskSecrets(entry!.params, {
      appId: "app-1",
      remotePath: "/home/deploy/apps/foo",
      repoUrl: "https://github.com/foo/bar.git",
      branch: "main",
      pat: SAMPLE_PAT,
    });
    const json = JSON.stringify(masked);
    expect(containsPatPattern(json)).toBe(false);
    expect(json).toContain('"pat":"***"');
  });

  it("serialiseParams routes pat to env-var, not argv", () => {
    const entry = manifest.find((m) => m.id === "bootstrap/clone");
    const { args, envExports } = serialiseParams(entry!.params, {
      appId: "app-1",
      remotePath: "/home/deploy/apps/foo",
      repoUrl: "https://github.com/foo/bar.git",
      branch: "main",
      pat: SAMPLE_PAT,
    });
    const argvJoined = args.join(" ");
    expect(containsPatPattern(argvJoined)).toBe(false);
    // The PAT lives in the env exports buffer (which is passed via stdin to
    // bash, never on argv) — it's bytes inside the SSH data channel.
    const envKeys = Object.keys(envExports);
    expect(envKeys.some((k) => /SECRET_PAT|PAT/.test(k))).toBe(true);
    // And the value is the actual PAT — but only inside this opaque dict,
    // not in argv.
    const envJoined = envKeys.map((k) => `${k}=${envExports[k]}`).join(" ");
    expect(envJoined).toContain(SAMPLE_PAT);
  });

  it("scrubPatFromText neutralises stderr leakage variants", () => {
    expect(scrubPatFromText(`fatal: clone of ghp_${SAMPLE_PAT.slice(4)}`)).not.toContain("ghp_");
    expect(scrubPatFromText("https://oauth2:abcsecrettoken@github.com/foo")).toContain(
      "https://oauth2:***@",
    );
  });
});
