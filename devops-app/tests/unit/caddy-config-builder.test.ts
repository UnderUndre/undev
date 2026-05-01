import { describe, it, expect } from "vitest";
import {
  buildCaddyConfig,
  AcmeEmailRequiredError,
  type AppForCaddy,
} from "../../server/services/caddy-config-builder.js";

function app(over: Partial<AppForCaddy> = {}): AppForCaddy {
  return {
    id: "app1",
    name: "foo",
    remotePath: "/srv/foo",
    domain: "foo.example.com",
    proxyType: "caddy",
    acmeEmail: null,
    upstreamService: "app",
    upstreamPort: 3000,
    ...over,
  };
}

describe("buildCaddyConfig (T011)", () => {
  it("empty apps → minimal config", () => {
    const cfg = buildCaddyConfig({ apps: [], globalAcmeEmail: "ops@x.com" });
    expect(cfg.apps.http.servers).toEqual({});
    expect(cfg.apps.tls).toBeUndefined();
  });

  it("one caddy app with global email → route + policy", () => {
    const cfg = buildCaddyConfig({
      apps: [app()],
      globalAcmeEmail: "ops@x.com",
    });
    expect(cfg.apps.http.servers.srv0.routes).toHaveLength(1);
    expect(cfg.apps.http.servers.srv0.routes[0].match).toEqual([{ host: ["foo.example.com"] }]);
    expect(cfg.apps.tls?.automation.policies[0].issuers[0].email).toBe("ops@x.com");
  });

  it("per-app email overrides global", () => {
    const cfg = buildCaddyConfig({
      apps: [app({ acmeEmail: "app@x.com" })],
      globalAcmeEmail: "ops@x.com",
    });
    expect(cfg.apps.tls?.automation.policies[0].issuers[0].email).toBe("app@x.com");
  });

  it("missing email → throws AcmeEmailRequiredError", () => {
    expect(() =>
      buildCaddyConfig({
        apps: [app()],
        globalAcmeEmail: null,
      }),
    ).toThrow(AcmeEmailRequiredError);
  });

  it("nginx-legacy app excluded", () => {
    const cfg = buildCaddyConfig({
      apps: [app({ id: "a1", proxyType: "nginx-legacy" }), app({ id: "a2", domain: "bar.example.com" })],
      globalAcmeEmail: "ops@x.com",
    });
    expect(cfg.apps.http.servers.srv0.routes).toHaveLength(1);
  });

  it("none proxy_type excluded", () => {
    const cfg = buildCaddyConfig({
      apps: [app({ proxyType: "none" })],
      globalAcmeEmail: "ops@x.com",
    });
    expect(cfg.apps.http.servers).toEqual({});
  });

  it("null domain excluded (FR-017a — site removal trigger)", () => {
    const cfg = buildCaddyConfig({
      apps: [app({ domain: null })],
      globalAcmeEmail: "ops@x.com",
    });
    expect(cfg.apps.http.servers).toEqual({});
  });

  it("apex + subdomain coexistence", () => {
    const cfg = buildCaddyConfig({
      apps: [
        app({ id: "a1", domain: "example.com" }),
        app({ id: "a2", domain: "foo.example.com" }),
      ],
      globalAcmeEmail: "ops@x.com",
    });
    expect(cfg.apps.http.servers.srv0.routes).toHaveLength(2);
    expect(cfg.apps.tls?.automation.policies).toHaveLength(2);
  });

  it("upstream uses Docker DNS not host port", () => {
    const cfg = buildCaddyConfig({
      apps: [app({ remotePath: "/srv/aitwins", upstreamService: "web", upstreamPort: 8080 })],
      globalAcmeEmail: "ops@x.com",
    });
    const r = cfg.apps.http.servers.srv0.routes[0];
    const handle = r.handle[0];
    expect(handle.handler).toBe("reverse_proxy");
    if (handle.handler === "reverse_proxy") {
      expect(handle.upstreams[0].dial).toBe("aitwins-web-1:8080");
    }
  });

  it("default upstream when service/port null", () => {
    const cfg = buildCaddyConfig({
      apps: [app({ remotePath: "/srv/foo", upstreamService: null, upstreamPort: null })],
      globalAcmeEmail: "ops@x.com",
    });
    const r = cfg.apps.http.servers.srv0.routes[0];
    if (r.handle[0].handler === "reverse_proxy") {
      expect(r.handle[0].upstreams[0].dial).toBe("foo-app-1:3000");
    }
  });

  it("grace cert in 7d window emits route + policy", () => {
    const owner = app({ id: "a1", domain: "new.example.com" });
    const cfg = buildCaddyConfig({
      apps: [owner],
      globalAcmeEmail: "ops@x.com",
      graceCerts: [
        {
          appId: "a1",
          domain: "old.example.com",
          orphanReason: "domain_change",
          orphanedAt: new Date().toISOString(),
        },
      ],
      now: new Date(),
    });
    expect(cfg.apps.http.servers.srv0.routes).toHaveLength(2);
    const hosts = cfg.apps.http.servers.srv0.routes.flatMap((r) =>
      r.match.flatMap((m) => m.host),
    );
    expect(hosts).toContain("old.example.com");
    expect(hosts).toContain("new.example.com");
  });

  it("grace cert outside 7d window excluded", () => {
    const owner = app({ id: "a1", domain: "new.example.com" });
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    const cfg = buildCaddyConfig({
      apps: [owner],
      globalAcmeEmail: "ops@x.com",
      graceCerts: [
        { appId: "a1", domain: "old.example.com", orphanReason: "domain_change", orphanedAt: eightDaysAgo },
      ],
      now: new Date(),
    });
    expect(cfg.apps.http.servers.srv0.routes).toHaveLength(1);
  });

  it("snapshot stable for known input", () => {
    const cfg = buildCaddyConfig({
      apps: [app({ remotePath: "/srv/foo", upstreamService: "app", upstreamPort: 3000 })],
      globalAcmeEmail: "ops@x.com",
    });
    expect(cfg).toMatchInlineSnapshot(`
      {
        "admin": {
          "listen": "127.0.0.1:2019",
        },
        "apps": {
          "http": {
            "servers": {
              "srv0": {
                "listen": [
                  ":80",
                  ":443",
                ],
                "routes": [
                  {
                    "handle": [
                      {
                        "handler": "reverse_proxy",
                        "upstreams": [
                          {
                            "dial": "foo-app-1:3000",
                          },
                        ],
                      },
                    ],
                    "match": [
                      {
                        "host": [
                          "foo.example.com",
                        ],
                      },
                    ],
                    "terminal": true,
                  },
                ],
              },
            },
          },
          "tls": {
            "automation": {
              "policies": [
                {
                  "issuers": [
                    {
                      "email": "ops@x.com",
                      "module": "acme",
                    },
                  ],
                  "subjects": [
                    "foo.example.com",
                  ],
                },
              ],
            },
          },
        },
      }
    `);
  });
});
