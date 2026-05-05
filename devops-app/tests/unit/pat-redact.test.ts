/** Feature 009 T059 — PAT redaction tests. */
import { describe, it, expect } from "vitest";
import {
  scrubPatFromText,
  containsPatPattern,
  BOOTSTRAP_REDACT_PATHS,
} from "../../server/lib/pat-redact.js";

describe("pat-redact", () => {
  it("scrubs ghp_ tokens", () => {
    const out = scrubPatFromText("Authentication failed for ghp_abcdefghijklmnopqrstuv");
    expect(out).toContain("***");
    expect(out).not.toContain("ghp_abcdefghij");
  });

  it("scrubs github_pat_ tokens", () => {
    const out = scrubPatFromText("token=github_pat_11ABCDEFGHIJKLMNOPQRSTUV");
    expect(out).toContain("***");
    expect(out).not.toContain("github_pat_11");
  });

  it("scrubs URL-embedded oauth2 tokens", () => {
    const out = scrubPatFromText("Cloning https://oauth2:ghp_secrettoken@github.com/foo/bar.git");
    expect(out).toContain("https://oauth2:***@");
    expect(out).not.toContain("ghp_secrettoken");
  });

  it("leaves clean strings intact", () => {
    expect(scrubPatFromText("clean error message")).toBe("clean error message");
  });

  it("returns empty string unchanged", () => {
    expect(scrubPatFromText("")).toBe("");
  });

  it("containsPatPattern detects ghp_*", () => {
    expect(containsPatPattern("see ghp_abcdefghijklmnopqrstuv in log")).toBe(true);
  });

  it("containsPatPattern detects oauth URL", () => {
    expect(containsPatPattern("https://oauth2:abc@github.com/foo")).toBe(true);
  });

  it("containsPatPattern false for clean text", () => {
    expect(containsPatPattern("nothing to see")).toBe(false);
  });

  it("redact paths cover scriptRun.params.pat and audit details", () => {
    expect(BOOTSTRAP_REDACT_PATHS).toContain("scriptRun.params.pat");
    expect(BOOTSTRAP_REDACT_PATHS).toContain("auditEntry.details.pat");
    expect(BOOTSTRAP_REDACT_PATHS).toContain("req.body.pat");
  });
});
