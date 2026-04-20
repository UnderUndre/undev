import { describe, it, expect } from "vitest";
import {
  normalisePath,
  markGitImported,
  markComposeImported,
  type ExistingApp,
} from "../../server/services/scanner-dedup.js";
import type {
  PartialGitCandidate,
  PartialComposeCandidate,
} from "../../server/services/scanner-parser.js";

describe("normalisePath", () => {
  it("collapses repeated slashes", () => {
    expect(normalisePath("/opt//app")).toBe("/opt/app");
    expect(normalisePath("///a///b///")).toBe("/a/b");
  });
  it("strips trailing slashes", () => {
    expect(normalisePath("/opt/app/")).toBe("/opt/app");
  });
  it("preserves root as '/'", () => {
    expect(normalisePath("/")).toBe("/");
    expect(normalisePath("//")).toBe("/");
  });
  it("returns empty string unchanged", () => {
    expect(normalisePath("")).toBe("");
  });
  it("is idempotent", () => {
    expect(normalisePath(normalisePath("/opt///app/"))).toBe("/opt/app");
  });
});

describe("markGitImported", () => {
  const candidate = (path: string, remoteUrl: string | null = null): PartialGitCandidate => ({
    path,
    branch: "main",
    detached: false,
    commitSha: null,
    commitSubject: null,
    commitDate: null,
    remoteUrl,
    dirty: "clean",
  });

  it("matches by normalised remotePath", () => {
    const apps: ExistingApp[] = [
      { id: "a1", remotePath: "/opt/app/", repoUrl: "x" },
    ];
    const marked = markGitImported([candidate("/opt//app")], apps);
    expect(marked[0].alreadyImported).toBe(true);
    expect(marked[0].existingApplicationId).toBe("a1");
  });

  it("matches by repoUrl when path differs", () => {
    const apps: ExistingApp[] = [
      { id: "a1", remotePath: "/other/place", repoUrl: "git@github.com:x/y.git" },
    ];
    const marked = markGitImported(
      [candidate("/opt/y", "git@github.com:x/y.git")],
      apps,
    );
    expect(marked[0].alreadyImported).toBe(true);
  });

  it("reports no match for fresh candidate", () => {
    const marked = markGitImported([candidate("/opt/fresh")], []);
    expect(marked[0].alreadyImported).toBe(false);
    expect(marked[0].existingApplicationId).toBeNull();
  });

  it("normalises the candidate path in the output", () => {
    const marked = markGitImported([candidate("/opt///app///")], []);
    expect(marked[0].path).toBe("/opt/app");
  });

  it("does not mutate the input array", () => {
    const input = [candidate("/opt/app")];
    markGitImported(input, []);
    expect(input[0].path).toBe("/opt/app");
  });
});

describe("markComposeImported", () => {
  const c = (primary: string): PartialComposeCandidate => ({
    primaryPath: primary,
    extraPaths: [],
    services: [],
  });

  it("matches compose by parent directory", () => {
    const apps: ExistingApp[] = [
      { id: "a1", remotePath: "/srv/stack", repoUrl: "" },
    ];
    const marked = markComposeImported([c("/srv/stack/docker-compose.yml")], apps);
    expect(marked[0].alreadyImported).toBe(true);
    expect(marked[0].existingApplicationId).toBe("a1");
  });

  it("handles trailing-slash discrepancy", () => {
    const apps: ExistingApp[] = [
      { id: "a1", remotePath: "/srv/stack/", repoUrl: "" },
    ];
    const marked = markComposeImported([c("/srv/stack/compose.yaml")], apps);
    expect(marked[0].alreadyImported).toBe(true);
  });
});
