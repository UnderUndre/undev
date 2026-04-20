import { LRUCache } from "lru-cache";

// ── Types ───────────────────────────────────────────────────────────────────

export interface GitHubUser {
  username: string;
  avatarUrl: string;
  tokenExpiresAt: string | null;
}

export interface GitHubRepository {
  fullName: string;
  name: string;
  owner: string;
  isPrivate: boolean;
  defaultBranch: string;
  updatedAt: string;
  description: string | null;
}

export interface GitHubBranch {
  name: string;
  isDefault: boolean;
}

export type CommitStatus = "success" | "failure" | "pending" | null;

export interface GitHubCommit {
  sha: string;
  shortSha: string;
  message: string;
  author: string;
  date: string;
  status: CommitStatus;
}

export interface GitHubRateLimit {
  remaining: number;
  limit: number;
  resetAt: string;
}

// ── GitHub API error classes ────────────────────────────────────────────────

export class GitHubUnauthorizedError extends Error {
  readonly code = "GITHUB_UNAUTHORIZED" as const;
  constructor(message = "GitHub token expired or revoked — update in Settings") {
    super(message);
    this.name = "GitHubUnauthorizedError";
  }
}

export class GitHubRateLimitError extends Error {
  readonly code = "GITHUB_RATE_LIMITED" as const;
  constructor(public resetAt: string) {
    super("GitHub API rate limit exceeded");
    this.name = "GitHubRateLimitError";
  }
}

export class GitHubApiError extends Error {
  readonly code = "GITHUB_API_ERROR" as const;
  constructor(public status: number, message: string) {
    super(message);
    this.name = "GitHubApiError";
  }
}

// ── Raw GitHub API response types (minimal, only fields we consume) ─────────

interface RawUser {
  login: string;
  avatar_url: string;
}

interface RawRepo {
  full_name: string;
  name: string;
  owner: { login: string };
  private: boolean;
  default_branch: string;
  updated_at: string;
  description: string | null;
}

interface RawBranch {
  name: string;
}

interface RawCommit {
  sha: string;
  commit: {
    message: string;
    author: { name: string; date: string };
  };
}

interface RawCombinedStatus {
  state: "success" | "failure" | "pending" | "error";
}

// ── Service ─────────────────────────────────────────────────────────────────

const GITHUB_API = "https://api.github.com";
const USER_AGENT = "devops-dashboard/0.2";
const REQUEST_TIMEOUT_MS = 10_000;
const GITHUB_STATUS_CONCURRENCY = 5;

/** Run `worker` over `items` with at most `limit` in flight. Preserves order. */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i]!, i);
    }
  });
  await Promise.all(runners);
  return results;
}

class GitHubService {
  // LRU-cache: max 500 entries, 5-minute TTL
  private cache = new LRUCache<string, { body: unknown; headers: Headers }>({
    max: 500,
    ttl: 1000 * 60 * 5,
  });

  // Most recent rate-limit snapshot (updated on every response)
  private rateLimit: GitHubRateLimit = {
    remaining: -1,
    limit: -1,
    resetAt: new Date(0).toISOString(),
  };

  private cooldownUntil: number | null = null;

  getRateLimit(): GitHubRateLimit {
    return { ...this.rateLimit };
  }

  invalidateCache(pattern: string): void {
    for (const key of this.cache.keys()) {
      if (key.includes(pattern)) this.cache.delete(key);
    }
  }

  /** Validate a Fine-grained PAT by calling GET /user. Returns username/avatar/expiry. */
  async validateToken(token: string): Promise<GitHubUser> {
    const res = await this.request(token, "/user", { skipCache: true });
    const user = res.body as RawUser;
    const tokenExpiresAt = res.headers.get("github-authentication-token-expiration");

    return {
      username: user.login,
      avatarUrl: user.avatar_url,
      tokenExpiresAt: tokenExpiresAt ? new Date(tokenExpiresAt).toISOString() : null,
    };
  }

  /** Search repositories. NOT cached — users expect fresh results. */
  async searchRepos(token: string, query: string): Promise<GitHubRepository[]> {
    const q = encodeURIComponent(query);
    const res = await this.request(token, `/search/repositories?q=${q}&per_page=30`, {
      skipCache: true,
    });
    const body = res.body as { items: RawRepo[] };
    return body.items.map(mapRepo);
  }

  async getBranches(token: string, owner: string, repo: string): Promise<GitHubBranch[]> {
    // GitHub paginates branches at 100/page and returns them alphabetically.
    // Monorepos with many topic branches (e.g. 200+) push `main` off the first
    // page, so we walk the pagination until exhausted or the hard cap hits.
    const MAX_PAGES = 10; // 1000 branches ceiling
    const all: RawBranch[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const res = await this.request(
        token,
        `/repos/${owner}/${repo}/branches?per_page=100&page=${page}`,
      );
      const chunk = res.body as RawBranch[];
      all.push(...chunk);
      if (chunk.length < 100) break; // last page
    }

    // Fetch default branch name separately for the isDefault flag + to hoist
    // it to the front of the result (UI's first option).
    const repoRes = await this.request(token, `/repos/${owner}/${repo}`);
    const defaultBranch = (repoRes.body as RawRepo).default_branch;

    const mapped = all.map((b) => ({ name: b.name, isDefault: b.name === defaultBranch }));
    // Put default branch first; keep the rest in GitHub's alphabetical order.
    mapped.sort((a, b) => {
      if (a.isDefault && !b.isDefault) return -1;
      if (!a.isDefault && b.isDefault) return 1;
      return a.name.localeCompare(b.name);
    });
    return mapped;
  }

  async getCommits(
    token: string,
    owner: string,
    repo: string,
    branch: string,
    count = 20,
  ): Promise<GitHubCommit[]> {
    const safeCount = Math.min(Math.max(count, 1), 100);
    const res = await this.request(
      token,
      `/repos/${owner}/${repo}/commits?sha=${encodeURIComponent(branch)}&per_page=${safeCount}`,
    );
    const commits = res.body as RawCommit[];

    // Fetch CI status per commit with bounded concurrency to avoid hammering GitHub
    // (would otherwise hit secondary rate limits on requests for 50+ commits).
    const statuses = await mapWithConcurrency(commits, GITHUB_STATUS_CONCURRENCY, (c) =>
      this.getCommitStatus(token, owner, repo, c.sha).catch(() => null),
    );

    return commits.map((c, i) => ({
      sha: c.sha,
      shortSha: c.sha.slice(0, 7),
      message: c.commit.message.split("\n")[0] ?? "",
      author: c.commit.author.name,
      date: c.commit.author.date,
      status: statuses[i] ?? null,
    }));
  }

  async getCommitStatus(
    token: string,
    owner: string,
    repo: string,
    sha: string,
  ): Promise<CommitStatus> {
    const res = await this.request(
      token,
      `/repos/${owner}/${repo}/commits/${sha}/status`,
    );
    const body = res.body as RawCombinedStatus;
    if (body.state === "success") return "success";
    if (body.state === "failure" || body.state === "error") return "failure";
    if (body.state === "pending") return "pending";
    return null;
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  private async request(
    token: string,
    path: string,
    opts: { skipCache?: boolean } = {},
  ): Promise<{ body: unknown; headers: Headers }> {
    // Enforce cooldown when rate-limited
    if (this.cooldownUntil && Date.now() < this.cooldownUntil) {
      throw new GitHubRateLimitError(new Date(this.cooldownUntil).toISOString());
    }

    const cacheKey = `GET ${path}`;
    if (!opts.skipCache) {
      const cached = this.cache.get(cacheKey);
      if (cached) return cached;
    }

    let res: Response;
    try {
      res = await fetch(`${GITHUB_API}${path}`, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: {
          "Authorization": `Bearer ${token}`,
          "Accept": "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": USER_AGENT,
        },
      });
    } catch (err) {
      // AbortSignal.timeout fires a TimeoutError (DOMException). Map it to GitHubApiError
      // so callers see a stable shape — bare network/abort errors leak transport details.
      const isTimeout =
        err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      throw new GitHubApiError(
        isTimeout ? 504 : 502,
        isTimeout
          ? `GitHub API request timed out after ${REQUEST_TIMEOUT_MS}ms`
          : `GitHub API request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Update rate-limit snapshot from headers
    const remaining = Number(res.headers.get("x-ratelimit-remaining") ?? "-1");
    const limit = Number(res.headers.get("x-ratelimit-limit") ?? "-1");
    const resetEpoch = Number(res.headers.get("x-ratelimit-reset") ?? "0");
    if (!Number.isNaN(remaining) && remaining >= 0) {
      this.rateLimit = {
        remaining,
        limit,
        resetAt: new Date(resetEpoch * 1000).toISOString(),
      };
      if (remaining === 0) {
        this.cooldownUntil = resetEpoch * 1000;
      } else {
        this.cooldownUntil = null;
      }
    }

    if (res.status === 401 || res.status === 403) {
      // 403 with rate-limit-remaining=0 is a rate limit, not an auth error
      if (remaining === 0) {
        throw new GitHubRateLimitError(new Date(resetEpoch * 1000).toISOString());
      }
      throw new GitHubUnauthorizedError();
    }

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new GitHubApiError(res.status, `GitHub API ${res.status}: ${errText.slice(0, 200)}`);
    }

    const body = await res.json();
    const entry = { body, headers: res.headers };
    if (!opts.skipCache) this.cache.set(cacheKey, entry);
    return entry;
  }
}

function mapRepo(r: RawRepo): GitHubRepository {
  return {
    fullName: r.full_name,
    name: r.name,
    owner: r.owner.login,
    isPrivate: r.private,
    defaultBranch: r.default_branch,
    updatedAt: r.updated_at,
    description: r.description,
  };
}

export const githubService = new GitHubService();
