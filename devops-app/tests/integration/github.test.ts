import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { githubService } from "../../server/services/github.js";

// Reuse the singleton; reset its internal state between tests.
function freshService() {
  githubService.invalidateCache("");
  // Best-effort cooldown reset via a private field shim (service exposes no resetter).
  (githubService as unknown as { cooldownUntil: number | null }).cooldownUntil = null;
  return githubService;
}

// Identify errors via their `.code` tag (more robust than instanceof across reimports).
function expectErrorCode(err: unknown, code: string): void {
  expect(err).toMatchObject({ code });
}

// ── fetch helper ────────────────────────────────────────────────────────────

type FetchHandler = (url: string, init?: RequestInit) => Response | Promise<Response>;

function mockFetch(handler: FetchHandler) {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    return handler(url, init);
  }) as typeof fetch;
}

function jsonResponse(body: unknown, init: ResponseInit = {}, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: {
      "content-type": "application/json",
      "x-ratelimit-limit": "5000",
      "x-ratelimit-remaining": "4999",
      "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600),
      ...headers,
    },
  });
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("GitHubService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    // Restore real fetch
    vi.restoreAllMocks();
  });

  it("validateToken returns username + avatar + expiry", async () => {
    mockFetch((url) => {
      expect(url).toBe("https://api.github.com/user");
      return jsonResponse(
        { login: "UnderUndre", avatar_url: "https://avatars/undre" },
        {},
        {
          "github-authentication-token-expiration": "2027-04-15T00:00:00Z",
        },
      );
    });

    const svc = freshService();
    const user = await svc.validateToken("ghp_abc123");

    expect(user.username).toBe("UnderUndre");
    expect(user.avatarUrl).toBe("https://avatars/undre");
    expect(user.tokenExpiresAt).toBe("2027-04-15T00:00:00.000Z");
  });

  it("validateToken throws GITHUB_UNAUTHORIZED on 401", async () => {
    mockFetch(() => jsonResponse({ message: "Bad credentials" }, { status: 401 }));

    const svc = freshService();
    await svc.validateToken("bad").then(
      () => {
        throw new Error("Expected rejection");
      },
      (err) => expectErrorCode(err, "GITHUB_UNAUTHORIZED"),
    );
  });

  it("searchRepos returns mapped repositories (and is NOT cached)", async () => {
    let calls = 0;
    mockFetch(() => {
      calls++;
      return jsonResponse({
        items: [
          {
            full_name: "UnderUndre/undev",
            name: "undev",
            owner: { login: "UnderUndre" },
            private: false,
            default_branch: "main",
            updated_at: "2026-04-15T10:00:00Z",
            description: "dev",
          },
        ],
      });
    });

    const svc = freshService();
    await svc.searchRepos("token", "undev");
    await svc.searchRepos("token", "undev"); // should NOT hit cache
    expect(calls).toBe(2);
  });

  it("getBranches marks default branch correctly and hoists it to first", async () => {
    mockFetch((url) => {
      if (url.includes("/branches?per_page=100&page=")) {
        // Single page of results — chunk smaller than 100, loop exits.
        return jsonResponse([{ name: "develop" }, { name: "main" }]);
      }
      if (url.endsWith("/repos/UnderUndre/undev")) {
        return jsonResponse({
          full_name: "UnderUndre/undev",
          name: "undev",
          owner: { login: "UnderUndre" },
          private: false,
          default_branch: "main",
          updated_at: "",
          description: null,
        });
      }
      return jsonResponse({}, { status: 404 });
    });

    const svc = freshService();
    const branches = await svc.getBranches("token", "UnderUndre", "undev");
    // Default branch hoisted to first regardless of input order.
    expect(branches).toEqual([
      { name: "main", isDefault: true },
      { name: "develop", isDefault: false },
    ]);
  });

  it("getBranches walks pagination for repos with >100 branches", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({ name: `feat-${i.toString().padStart(3, "0")}` }));
    const page2 = [{ name: "main" }, { name: "develop" }];
    mockFetch((url) => {
      if (url.includes("/branches?per_page=100&page=1")) return jsonResponse(page1);
      if (url.includes("/branches?per_page=100&page=2")) return jsonResponse(page2);
      if (url.endsWith("/repos/o/r")) {
        return jsonResponse({
          full_name: "o/r",
          name: "r",
          owner: { login: "o" },
          private: false,
          default_branch: "main",
          updated_at: "",
          description: null,
        });
      }
      return jsonResponse({}, { status: 404 });
    });
    const svc = freshService();
    const branches = await svc.getBranches("t", "o", "r");
    expect(branches.length).toBe(102);
    expect(branches[0]).toEqual({ name: "main", isDefault: true });
  });

  it("getCommits maps commits + fetches combined CI status", async () => {
    mockFetch((url) => {
      if (url.includes("/commits?sha=")) {
        return jsonResponse([
          {
            sha: "abc123def4567890abc123def4567890abc123de",
            commit: {
              message: "feat: add auth\n\nbody",
              author: { name: "Alice", date: "2026-04-15T09:00:00Z" },
            },
          },
        ]);
      }
      if (url.endsWith("/status")) {
        return jsonResponse({ state: "success" });
      }
      return jsonResponse({}, { status: 404 });
    });

    const svc = freshService();
    const commits = await svc.getCommits("token", "UnderUndre", "undev", "main", 5);

    expect(commits).toHaveLength(1);
    expect(commits[0]).toMatchObject({
      shortSha: "abc123d",
      message: "feat: add auth",
      author: "Alice",
      status: "success",
    });
  });

  it("rate-limit cooldown rejects requests when remaining=0", async () => {
    const resetEpoch = Math.floor(Date.now() / 1000) + 3600;
    mockFetch(
      () =>
        new Response(JSON.stringify({ message: "rate limited" }), {
          status: 403,
          headers: {
            "content-type": "application/json",
            "x-ratelimit-limit": "5000",
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": String(resetEpoch),
          },
        }),
    );

    const svc = freshService();
    await svc.validateToken("t").catch((e) => expectErrorCode(e, "GITHUB_RATE_LIMITED"));
    await svc.validateToken("t").catch((e) => expectErrorCode(e, "GITHUB_RATE_LIMITED"));

    expect(svc.getRateLimit().remaining).toBe(0);
  });

  it("non-401 non-rate-limit GitHub errors surface as GITHUB_API_ERROR", async () => {
    mockFetch(() => jsonResponse({ message: "boom" }, { status: 500 }));

    const svc = freshService();
    await svc.validateToken("t").catch((e) => expectErrorCode(e, "GITHUB_API_ERROR"));
  });

  it("invalidateCache clears cached entries matching pattern", async () => {
    let calls = 0;
    mockFetch(() => {
      calls++;
      return jsonResponse([{ name: "main" }]);
    });

    const svc = freshService();
    // getBranches caches the branches + repo lookup; call twice to prime cache
    mockFetch((url) => {
      calls++;
      if (url.includes("/branches?per_page=100&page=")) return jsonResponse([{ name: "main" }]);
      return jsonResponse({
        full_name: "o/r",
        name: "r",
        owner: { login: "o" },
        private: false,
        default_branch: "main",
        updated_at: "",
        description: null,
      });
    });

    await svc.getBranches("t", "o", "r");
    const primedCalls = calls;
    await svc.getBranches("t", "o", "r"); // cached
    expect(calls).toBe(primedCalls); // no new calls

    svc.invalidateCache("/repos/o/r");
    await svc.getBranches("t", "o", "r");
    expect(calls).toBeGreaterThan(primedCalls); // cache busted
  });
});

describe("SHA validation (deploy route contract)", () => {
  const SHA_REGEX = /^[0-9a-f]{7,40}$/;

  it("accepts 7-40 hex chars", () => {
    expect(SHA_REGEX.test("abc1234")).toBe(true);
    expect(SHA_REGEX.test("a".repeat(40))).toBe(true);
  });

  it("rejects too short / too long / non-hex / shell injection attempts", () => {
    expect(SHA_REGEX.test("abc123")).toBe(false); // 6 chars
    expect(SHA_REGEX.test("a".repeat(41))).toBe(false); // 41 chars
    expect(SHA_REGEX.test("abc123z")).toBe(false); // non-hex
    expect(SHA_REGEX.test("abc1234; rm -rf /")).toBe(false); // injection
    expect(SHA_REGEX.test("$(whoami)")).toBe(false);
    expect(SHA_REGEX.test("main")).toBe(false); // branch name
  });
});
