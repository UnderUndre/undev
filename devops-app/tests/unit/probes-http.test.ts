import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Stub SSRF guard so we test the probe runner in isolation.
vi.mock("../../server/lib/ssrf-guard.js", () => ({
  validateUrlForProbe: vi.fn(async () => ({ ok: true, resolvedIps: ["8.8.8.8"] })),
}));

import { validateUrlForProbe } from "../../server/lib/ssrf-guard.js";
import { runHttpProbe } from "../../server/services/probes/http.js";

const makeApp = (healthUrl: string | null = "https://example.test/health") => ({
  id: "app-1",
  serverId: "srv-1",
  name: "myapp",
  remotePath: "/opt/myapp",
  healthUrl,
});

describe("runHttpProbe (feature 006 T009 + T053 + T057)", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    vi.mocked(validateUrlForProbe).mockResolvedValue({
      ok: true,
      resolvedIps: ["8.8.8.8"],
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  const stubResp = (status: number) => {
    globalThis.fetch = vi.fn(async () => new Response(null, { status })) as typeof fetch;
  };

  it("200 → healthy", async () => {
    stubResp(200);
    const r = await runHttpProbe(makeApp());
    expect(r.outcome).toBe("healthy");
    expect(r.statusCode).toBe(200);
  });

  it("301 (manual redirect) → healthy", async () => {
    stubResp(301);
    const r = await runHttpProbe(makeApp());
    expect(r.outcome).toBe("healthy");
  });

  it("404 → unhealthy", async () => {
    stubResp(404);
    const r = await runHttpProbe(makeApp());
    expect(r.outcome).toBe("unhealthy");
    expect(r.statusCode).toBe(404);
  });

  it("500 → unhealthy", async () => {
    stubResp(500);
    const r = await runHttpProbe(makeApp());
    expect(r.outcome).toBe("unhealthy");
  });

  it("fetch throws DNS error → outcome=error with message", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("getaddrinfo ENOTFOUND example.test");
    }) as typeof fetch;
    const r = await runHttpProbe(makeApp());
    expect(r.outcome).toBe("error");
    expect(r.errorMessage).toMatch(/ENOTFOUND/);
  });

  it("AbortError → outcome=error with timeout message", async () => {
    globalThis.fetch = vi.fn(async () => {
      const e = new Error("aborted");
      e.name = "AbortError";
      throw e;
    }) as typeof fetch;
    const r = await runHttpProbe(makeApp());
    expect(r.outcome).toBe("error");
    expect(r.errorMessage).toMatch(/timeout/);
  });

  it("blocked SSRF → outcome=error, no fetch call", async () => {
    vi.mocked(validateUrlForProbe).mockResolvedValue({
      ok: false,
      code: "private_ip",
      resolvedIps: ["10.0.0.1"],
    });
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const r = await runHttpProbe(makeApp("http://internal/"));
    expect(r.outcome).toBe("error");
    expect(r.errorMessage).toMatch(/SSRF/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("missing healthUrl → outcome=error", async () => {
    const r = await runHttpProbe(makeApp(null));
    expect(r.outcome).toBe("error");
    expect(r.errorMessage).toMatch(/no health URL/);
  });
});
