import { describe, it, expect } from "vitest";
import { classifyPatError } from "../../server/lib/pat-error-classifier.js";

describe("classifyPatError (FR-016a)", () => {
  it("detects expired/revoked PAT via 'Authentication failed'", () => {
    const r = classifyPatError({
      stderr:
        "Cloning into 'foo'...\nfatal: Authentication failed for 'https://github.com/owner/foo.git/'\n",
      exitCode: 128,
    });
    expect(r.kind).toBe("pat_expired");
  });

  it("detects permission_denied via 'Permission ... denied to'", () => {
    const r = classifyPatError({
      stderr: "remote: Permission to owner/foo.git denied to bar.\n",
      exitCode: 128,
    });
    expect(r.kind).toBe("permission_denied");
  });

  it("detects sso_required via 'single sign-on'", () => {
    const r = classifyPatError({
      stderr:
        "remote: Repository not found.\nremote: To enable single sign-on for this PAT, ...\n",
      exitCode: 128,
    });
    expect(r.kind).toBe("sso_required");
  });

  it("detects sso_required via standalone SSO keyword", () => {
    const r = classifyPatError({
      stderr: "Authorize this PAT for SSO and retry.\n",
      exitCode: 128,
    });
    expect(r.kind).toBe("sso_required");
  });

  it("falls through to other on unrelated stderr", () => {
    const r = classifyPatError({
      stderr: "fatal: unable to access 'https://...': Could not resolve host\n",
      exitCode: 128,
    });
    expect(r.kind).toBe("other");
  });

  it("empty stderr with non-zero exit code → other with exit code", () => {
    const r = classifyPatError({ stderr: "", exitCode: 42 });
    expect(r.kind).toBe("other");
    expect(r.message).toContain("42");
  });

  it("SSO check beats auth-failed when both keywords present", () => {
    const r = classifyPatError({
      stderr:
        "fatal: Authentication failed for 'https://github.com/foo'\nSSO authorization required.\n",
      exitCode: 128,
    });
    expect(r.kind).toBe("sso_required");
  });

  it("non-string stderr does not crash", () => {
    const r = classifyPatError({
      stderr: undefined as unknown as string,
      exitCode: 1,
    });
    expect(r.kind).toBe("other");
  });
});
