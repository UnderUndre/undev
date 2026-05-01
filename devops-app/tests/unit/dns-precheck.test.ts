import { describe, it, expect, beforeEach } from "vitest";
import { precheck } from "../../server/services/dns-precheck.js";
import { __resetForTests, __seedCacheForTests } from "../../server/lib/cloudflare-cidrs.js";

beforeEach(() => {
  __resetForTests();
  __seedCacheForTests(["104.16.0.0/13"], ["2606:4700::/32"]);
});

function makeDeps(v4: () => Promise<string[]>, v6: () => Promise<string[]>) {
  return { resolve4: () => v4(), resolve6: () => v6() };
}

const ENOTFOUND = Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });

describe("dns-precheck (T021)", () => {
  it("match — server IP in resolved set", async () => {
    const out = await precheck(
      "foo.example.com",
      "1.2.3.4",
      makeDeps(() => Promise.resolve(["1.2.3.4"]), () => Promise.reject(ENOTFOUND)),
    );
    expect(out.kind).toBe("match");
  });

  it("cloudflare — resolved IP in CF range", async () => {
    const out = await precheck(
      "foo.example.com",
      "1.2.3.4",
      makeDeps(() => Promise.resolve(["104.21.50.10"]), () => Promise.reject(ENOTFOUND)),
    );
    expect(out.kind).toBe("cloudflare");
  });

  it("mismatch — non-CF, non-matching", async () => {
    const out = await precheck(
      "foo.example.com",
      "1.2.3.4",
      makeDeps(() => Promise.resolve(["8.8.8.8"]), () => Promise.reject(ENOTFOUND)),
    );
    expect(out.kind).toBe("mismatch");
  });

  it("nxdomain — both ENOTFOUND", async () => {
    const out = await precheck(
      "foo.example.com",
      "1.2.3.4",
      makeDeps(() => Promise.reject(ENOTFOUND), () => Promise.reject(ENOTFOUND)),
    );
    expect(out.kind).toBe("nxdomain");
  });

  it("AAAA-only — match against IPv6", async () => {
    const out = await precheck(
      "foo.example.com",
      "2001:db8::1",
      makeDeps(() => Promise.reject(ENOTFOUND), () => Promise.resolve(["2001:db8::1"])),
    );
    expect(out.kind).toBe("match");
  });

  it("round-robin: any match → match", async () => {
    const out = await precheck(
      "foo.example.com",
      "1.2.3.4",
      makeDeps(() => Promise.resolve(["8.8.8.8", "1.2.3.4"]), () => Promise.reject(ENOTFOUND)),
    );
    expect(out.kind).toBe("match");
  });

  it("round-robin: none match → mismatch", async () => {
    const out = await precheck(
      "foo.example.com",
      "1.2.3.4",
      makeDeps(() => Promise.resolve(["8.8.8.8", "9.9.9.9"]), () => Promise.reject(ENOTFOUND)),
    );
    expect(out.kind).toBe("mismatch");
  });

  it("v4 throws non-ENOTFOUND, v6 succeeds → uses v6 result", async () => {
    const out = await precheck(
      "foo.example.com",
      "2001:db8::1",
      makeDeps(() => Promise.reject(new Error("ESERVFAIL")), () => Promise.resolve(["2001:db8::1"])),
    );
    expect(out.kind).toBe("match");
  });

  it("both throw non-NX errors → treated as nxdomain", async () => {
    const out = await precheck(
      "foo.example.com",
      "1.2.3.4",
      makeDeps(() => Promise.reject(new Error("EBADRESP")), () => Promise.reject(new Error("EBADRESP"))),
    );
    expect(out.kind).toBe("nxdomain");
  });

  it("cloudflare v6 detected", async () => {
    const out = await precheck(
      "foo.example.com",
      "1.2.3.4",
      makeDeps(() => Promise.reject(ENOTFOUND), () => Promise.resolve(["2606:4700::1"])),
    );
    expect(out.kind).toBe("cloudflare");
  });

  it("cloudflare match against server IP — match wins over CF classification", async () => {
    // Pathological: server is itself on CF (rare). 'match' takes priority.
    const out = await precheck(
      "foo.example.com",
      "104.21.50.10",
      makeDeps(() => Promise.resolve(["104.21.50.10"]), () => Promise.reject(ENOTFOUND)),
    );
    expect(out.kind).toBe("match");
  });

  it("timeout — promise rejects within 5s in real impl; mocked here as ETIMEOUT", async () => {
    const out = await precheck(
      "foo.example.com",
      "1.2.3.4",
      makeDeps(
        () => Promise.reject(Object.assign(new Error("ETIMEOUT"), { code: "ETIMEOUT" })),
        () => Promise.reject(Object.assign(new Error("ETIMEOUT"), { code: "ETIMEOUT" })),
      ),
    );
    expect(out.kind).toBe("nxdomain");
  });
});
