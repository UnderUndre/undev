import { describe, it, expect } from "vitest";
import {
  manifest,
  CATEGORY_FOLDER_MAP,
} from "../../server/scripts-manifest.js";

describe("manifest (feature 005 T022)", () => {
  it("has unique ids (duplicate = fatal per R-009)", () => {
    const ids = manifest.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("all ids are '<category>/<name>' shape", () => {
    for (const e of manifest) {
      expect(e.id).toMatch(/^[a-z-]+\/[a-z-]+$/);
    }
  });

  it("every category is in CATEGORY_FOLDER_MAP", () => {
    for (const e of manifest) {
      expect(CATEGORY_FOLDER_MAP[e.category]).toBeDefined();
    }
  });

  it("the v1 + project-local entries exist", () => {
    const expected = [
      "deploy/server-deploy",
      "deploy/project-local-deploy",
      "deploy/server-rollback",
      "deploy/deploy-docker",
      "deploy/env-setup",
      "deploy/logs",
      "db/backup",
      "db/restore",
      "docker/cleanup",
      "monitoring/security-audit",
      "server-ops/health-check",
    ];
    const ids = manifest.map((e) => e.id);
    for (const id of expected) {
      expect(ids).toContain(id);
    }
  });

  it("db/restore is flagged dangerLevel:high and requiresLock", () => {
    const e = manifest.find((x) => x.id === "db/restore")!;
    expect(e.dangerLevel).toBe("high");
    expect(e.requiresLock).toBe(true);
  });

  it("deploy entries require lock", () => {
    const deploy = manifest.filter((e) => e.category === "deploy");
    for (const e of deploy) {
      if (e.id === "deploy/env-setup" || e.id === "deploy/logs") continue;
      expect(e.requiresLock).toBe(true);
    }
  });

  // Feature 006 T004 — waitForHealthy / healthyTimeoutMs surface (FR-024..FR-028)
  describe("post-deploy health gate (feature 006)", () => {
    it("deploy/server-deploy has waitForHealthy:true with default timeout 180_000", () => {
      const e = manifest.find((x) => x.id === "deploy/server-deploy")!;
      expect(e.waitForHealthy).toBe(true);
      expect(e.healthyTimeoutMs).toBe(180_000);
    });

    it("entries WITHOUT the fields validate unchanged (backward-compat)", () => {
      // server-rollback / db/backup etc never opt in → fields stay undefined.
      const rollback = manifest.find((x) => x.id === "deploy/server-rollback")!;
      expect(rollback.waitForHealthy).toBeUndefined();
      expect(rollback.healthyTimeoutMs).toBeUndefined();
      const backup = manifest.find((x) => x.id === "db/backup")!;
      expect(backup.waitForHealthy).toBeUndefined();
      expect(backup.healthyTimeoutMs).toBeUndefined();
    });
  });

  describe("deploy/project-local-deploy (T008)", () => {
    const entry = manifest.find((e) => e.id === "deploy/project-local-deploy")!;

    it("is registered with the expected fixed fields", () => {
      expect(entry).toBeDefined();
      expect(entry.category).toBe("deploy");
      expect(entry.locus).toBe("target");
      expect(entry.requiresLock).toBe(true);
      expect(entry.timeout).toBe(1_800_000);
      expect(entry.dangerLevel).toBe("low");
    });

    it("rejects traversal scriptPath via Zod refine", () => {
      expect(() =>
        entry.params.parse({
          appDir: "/opt/app",
          scriptPath: "../evil",
          branch: "main",
        }),
      ).toThrow(/Invalid scriptPath/);
    });

    it("rejects null scriptPath at z.string() (never reaches refine)", () => {
      expect(() =>
        entry.params.parse({
          appDir: "/opt/app",
          scriptPath: null,
          branch: "main",
        }),
      ).toThrow();
    });

    it("rejects non-string scriptPath at z.string()", () => {
      expect(() =>
        entry.params.parse({
          appDir: "/opt/app",
          scriptPath: 123,
          branch: "main",
        }),
      ).toThrow();
    });

    it("accepts valid scriptPath", () => {
      const parsed = entry.params.parse({
        appDir: "/opt/app",
        scriptPath: "scripts/devops-deploy.sh",
        branch: "main",
      });
      expect(parsed).toMatchObject({
        scriptPath: "scripts/devops-deploy.sh",
        noCache: false,
        skipCleanup: false,
      });
    });
  });
});
