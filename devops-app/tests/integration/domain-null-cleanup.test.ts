/** T069 — domain → NULL Caddy cleanup behavior. */
import { describe, it, expect } from "vitest";
import { buildCaddyConfig, type AppForCaddy } from "../../server/services/caddy-config-builder.js";

describe("domain null cleanup (T069)", () => {
  it("when applications.domain becomes null, builder emits no route for that app", () => {
    const apps: AppForCaddy[] = [
      {
        id: "a1",
        name: "foo",
        remotePath: "/srv/foo",
        domain: null,
        proxyType: "caddy",
        acmeEmail: null,
        upstreamService: "app",
        upstreamPort: 3000,
      },
    ];
    const cfg = buildCaddyConfig({ apps, globalAcmeEmail: "ops@x.com" });
    expect(cfg.apps.http.servers).toEqual({});
  });

  it("other apps in same server still get routes", () => {
    const apps: AppForCaddy[] = [
      {
        id: "a1",
        name: "foo",
        remotePath: "/srv/foo",
        domain: null,
        proxyType: "caddy",
        acmeEmail: null,
        upstreamService: null,
        upstreamPort: null,
      },
      {
        id: "a2",
        name: "bar",
        remotePath: "/srv/bar",
        domain: "bar.example.com",
        proxyType: "caddy",
        acmeEmail: null,
        upstreamService: "web",
        upstreamPort: 8080,
      },
    ];
    const cfg = buildCaddyConfig({ apps, globalAcmeEmail: "ops@x.com" });
    expect(cfg.apps.http.servers.srv0.routes).toHaveLength(1);
  });
});
