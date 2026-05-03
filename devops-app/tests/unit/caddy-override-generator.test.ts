import { describe, it, expect } from "vitest";
import { generateCaddyOverride } from "../../server/services/caddy-override-generator.js";

describe("generateCaddyOverride", () => {
  it("simple service emits two labels + edge network", () => {
    const out = generateCaddyOverride({
      serviceName: "9router",
      domain: "9router.example.com",
      upstreamPort: 20128,
      edgeNetwork: "ai-twins-network",
    });
    expect(out).toMatch(/services:\n  9router:/);
    expect(out).toContain("caddy: 9router.example.com");
    expect(out).toContain('caddy.reverse_proxy: "{{upstreams 20128}}"');
    expect(out).toMatch(/networks:\n  default:\n  caddy_edge:\n    external: true\n    name: ai-twins-network/);
  });

  it("extraLabels appended verbatim (key+value)", () => {
    const out = generateCaddyOverride({
      serviceName: "api",
      domain: "api.example.com",
      upstreamPort: 8080,
      edgeNetwork: "caddy_edge",
      extraLabels: {
        "caddy.basic_auth.user1": "$2a$14$abcdef",
      },
    });
    expect(out).toContain('caddy.basic_auth.user1: "$2a$14$abcdef"');
  });

  it("rejects invalid port", () => {
    expect(() =>
      generateCaddyOverride({
        serviceName: "x",
        domain: "x.com",
        upstreamPort: 0,
        edgeNetwork: "n",
      }),
    ).toThrow(/invalid upstreamPort/);
    expect(() =>
      generateCaddyOverride({
        serviceName: "x",
        domain: "x.com",
        upstreamPort: 70000,
        edgeNetwork: "n",
      }),
    ).toThrow();
  });

  it("rejects empty fields", () => {
    expect(() => generateCaddyOverride({ serviceName: "", domain: "x.com", upstreamPort: 80, edgeNetwork: "n" })).toThrow();
    expect(() => generateCaddyOverride({ serviceName: "x", domain: "", upstreamPort: 80, edgeNetwork: "n" })).toThrow();
    expect(() => generateCaddyOverride({ serviceName: "x", domain: "x.com", upstreamPort: 80, edgeNetwork: "" })).toThrow();
  });

  it("yaml is valid (round-trippable shape — services/networks keys at expected depth)", () => {
    const out = generateCaddyOverride({
      serviceName: "app",
      domain: "foo.bar.baz",
      upstreamPort: 3000,
      edgeNetwork: "edge",
    });
    // Top-level keys
    expect(out.match(/^services:$/m)).not.toBeNull();
    expect(out.match(/^networks:$/m)).not.toBeNull();
    // service nested 2-space, label 6-space
    expect(out).toMatch(/^  app:$/m);
    expect(out).toMatch(/^      caddy: /m);
  });
});
