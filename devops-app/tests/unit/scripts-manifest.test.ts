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

  it("the 10 v1 entries exist", () => {
    const expected = [
      "deploy/deploy",
      "deploy/rollback",
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
});
