import { describe, it, expect } from "vitest";
import { rewriteUpstream } from "../../server/services/caddy-upstream-switcher.js";
import type { CaddyConfig } from "../../server/services/caddy-admin-client.js";

function makeConfig(domain: string, dial: string): CaddyConfig {
  return {
    admin: { listen: "0.0.0.0:2019" },
    apps: {
      http: {
        servers: {
          srv0: {
            listen: [":443"],
            routes: [
              {
                match: [{ host: [domain] }],
                handle: [
                  {
                    handler: "reverse_proxy",
                    upstreams: [{ dial }],
                  },
                ],
                terminal: true,
              },
            ],
          },
        },
      },
    },
  };
}

describe("rewriteUpstream", () => {
  it("rewrites dial address for matching domain", () => {
    const cfg = makeConfig("example.com", "api-blue:3000");
    const r = rewriteUpstream(cfg, "example.com", "api-green:3000");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.previousUpstream).toBe("api-blue:3000");
    const newDial =
      cfg.apps.http.servers.srv0?.routes[0]?.handle[0];
    if (newDial && newDial.handler === "reverse_proxy") {
      expect(newDial.upstreams[0]?.dial).toBe("api-green:3000");
    }
  });

  it("returns domain_route_not_found when domain absent", () => {
    const cfg = makeConfig("example.com", "api-blue:3000");
    const r = rewriteUpstream(cfg, "other.com", "api-green:3000");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("domain_route_not_found");
  });

  it("returns no_reverse_proxy_handler when route has no proxy", () => {
    const cfg: CaddyConfig = {
      admin: { listen: "0.0.0.0:2019" },
      apps: {
        http: {
          servers: {
            s: {
              listen: [":443"],
              routes: [
                {
                  match: [{ host: ["example.com"] }],
                  handle: [{ handler: "subroute", routes: [] }],
                  terminal: true,
                },
              ],
            },
          },
        },
      },
    };
    const r = rewriteUpstream(cfg, "example.com", "api-green:3000");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("no_reverse_proxy_handler");
  });
});
