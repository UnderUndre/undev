/** T052 — domain change grace period (config-builder lens). */
import { describe, it, expect } from "vitest";
import { buildCaddyConfig, type AppForCaddy } from "../../server/services/caddy-config-builder.js";

const owner: AppForCaddy = {
  id: "a1",
  name: "foo",
  remotePath: "/srv/foo",
  domain: "new.example.com",
  proxyType: "caddy",
  acmeEmail: null,
  upstreamService: "app",
  upstreamPort: 3000,
};

describe("domain change grace period (T052)", () => {
  it("during grace: both old and new served simultaneously", () => {
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
    const hosts = cfg.apps.http.servers.srv0.routes.flatMap((r) =>
      r.match.flatMap((m) => m.host),
    );
    expect(hosts).toContain("old.example.com");
    expect(hosts).toContain("new.example.com");
  });

  it("after 7 days: old domain dropped from config", () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 86_400_000).toISOString();
    const cfg = buildCaddyConfig({
      apps: [owner],
      globalAcmeEmail: "ops@x.com",
      graceCerts: [
        {
          appId: "a1",
          domain: "old.example.com",
          orphanReason: "domain_change",
          orphanedAt: eightDaysAgo,
        },
      ],
      now: new Date(),
    });
    const hosts = cfg.apps.http.servers.srv0.routes.flatMap((r) =>
      r.match.flatMap((m) => m.host),
    );
    expect(hosts).not.toContain("old.example.com");
    expect(hosts).toContain("new.example.com");
  });
});
