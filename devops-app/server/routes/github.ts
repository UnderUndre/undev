import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { githubConnection } from "../db/schema.js";
import {
  githubService,
  GitHubUnauthorizedError,
  GitHubRateLimitError,
  GitHubApiError,
} from "../services/github.js";
import { parseCompose } from "../lib/compose-parser.js";

export const githubRouter = Router();

// ── Helpers ─────────────────────────────────────────────────────────────────

async function getToken(): Promise<string | null> {
  const [row] = await db
    .select({ token: githubConnection.token })
    .from(githubConnection)
    .where(eq(githubConnection.id, "DEFAULT"))
    .limit(1);
  return row?.token ?? null;
}

/** Maps GitHub service errors → HTTP responses. */
function handleGitHubError(err: unknown, res: Response): boolean {
  if (err instanceof GitHubUnauthorizedError) {
    res.status(401).json({
      error: { code: "GITHUB_UNAUTHORIZED", message: err.message },
    });
    return true;
  }
  if (err instanceof GitHubRateLimitError) {
    res.status(429).json({
      error: {
        code: "GITHUB_RATE_LIMITED",
        message: err.message,
        details: { resetAt: err.resetAt },
      },
    });
    return true;
  }
  if (err instanceof GitHubApiError) {
    res.status(502).json({
      error: { code: "GITHUB_API_ERROR", message: err.message },
    });
    return true;
  }
  return false;
}

// Middleware: require GitHub connection, attach token to req
function requireGitHub(req: Request & { ghToken?: string }, res: Response, next: NextFunction) {
  getToken()
    .then((token) => {
      if (!token) {
        res.status(400).json({
          error: { code: "GITHUB_NOT_CONNECTED", message: "Connect GitHub in Settings first" },
        });
        return;
      }
      req.ghToken = token;
      next();
    })
    .catch(next);
}

const ownerRepoSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
});

// ── Routes ──────────────────────────────────────────────────────────────────

// GET /api/github/repos?q=
githubRouter.get("/repos", requireGitHub, async (req: Request & { ghToken?: string }, res) => {
  const q = String(req.query.q ?? "").trim();
  if (q.length < 2) {
    res.status(400).json({
      error: { code: "VALIDATION_ERROR", message: "Query parameter 'q' must be at least 2 characters" },
    });
    return;
  }
  try {
    const repos = await githubService.searchRepos(req.ghToken!, q);
    res.json(repos);
  } catch (err) {
    if (handleGitHubError(err, res)) return;
    throw err;
  }
});

// GET /api/github/repos/:owner/:repo/branches
githubRouter.get(
  "/repos/:owner/:repo/branches",
  requireGitHub,
  async (req: Request & { ghToken?: string }, res) => {
    const parsed = ownerRepoSchema.safeParse(req.params);
    if (!parsed.success) {
      res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "Invalid owner/repo" } });
      return;
    }
    try {
      const branches = await githubService.getBranches(req.ghToken!, parsed.data.owner, parsed.data.repo);
      res.json(branches);
    } catch (err) {
      if (handleGitHubError(err, res)) return;
      console.error("[github route] Unexpected error:", err);
      throw err;
    }
  },
);

// Feature 009 T013 — compose pre-fetch via GitHub Contents API.
// Falls back from .yml to .yaml per FR-003. Parsing is graceful (FR-004) —
// yaml errors return 200 with `found:true, errors:[…]` so the wizard can
// surface them without us reinventing 422 semantics.
const composeOwnerRepoSchema = z.object({
  owner: z.string().regex(/^[A-Za-z0-9._-]+$/),
  repo: z.string().regex(/^[A-Za-z0-9._-]+$/),
});
githubRouter.get(
  "/repos/:owner/:repo/compose",
  requireGitHub,
  async (req: Request & { ghToken?: string }, res) => {
    const parsed = composeOwnerRepoSchema.safeParse(req.params);
    if (!parsed.success) {
      res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "Invalid owner/repo" } });
      return;
    }
    const { owner, repo } = parsed.data;
    const path = String(req.query.path ?? "docker-compose.yml").trim() || "docker-compose.yml";
    const ref = req.query.ref ? String(req.query.ref) : undefined;

    try {
      let text = await githubService.fetchComposeFile(req.ghToken!, owner, repo, path, ref);
      let foundPath = path;
      if (text === null && path === "docker-compose.yml") {
        text = await githubService.fetchComposeFile(req.ghToken!, owner, repo, "docker-compose.yaml", ref);
        if (text !== null) foundPath = "docker-compose.yaml";
      }
      if (text === null) {
        res.json({
          found: false,
          errors: [`No ${path} or docker-compose.yaml in ${owner}/${repo}`],
          warnings: [],
        });
        return;
      }
      const parsedCompose = parseCompose(text);
      if (parsedCompose.kind === "yaml_invalid") {
        res.status(422).json({
          error: {
            code: "COMPOSE_PARSE_ERROR",
            message: parsedCompose.error,
          },
        });
        return;
      }
      if (parsedCompose.kind === "no_services") {
        res.json({
          found: true,
          path: foundPath,
          ref: ref ?? null,
          services: [],
          errors: ["Compose file has no `services:` map"],
          warnings: [],
        });
        return;
      }
      // Map ComposeService discriminated union → flat shape per contracts/api.md.
      const services = parsedCompose.services.map((s) => ({
        name: s.name,
        kind: s.kind,
        exposeOrPorts: s.kind === "ok" ? s.port : null,
        rawValue: s.kind === "ambiguous_port" ? s.rawValue : null,
        networkModeHost: s.networkModeHost,
        replicas: s.replicas,
        hasHealthcheck: s.hasHealthcheck,
      }));
      res.json({
        found: true,
        path: foundPath,
        ref: ref ?? null,
        services,
        errors: [],
        warnings: parsedCompose.warnings,
      });
    } catch (err) {
      if (err instanceof GitHubUnauthorizedError) {
        res.status(403).json({
          error: {
            code: "GITHUB_REPO_NOT_ACCESSIBLE",
            message: err.message,
          },
        });
        return;
      }
      if (handleGitHubError(err, res)) return;
      throw err;
    }
  },
);

// GET /api/github/repos/:owner/:repo/commits?branch=&count=
githubRouter.get(
  "/repos/:owner/:repo/commits",
  requireGitHub,
  async (req: Request & { ghToken?: string }, res) => {
    const parsed = ownerRepoSchema.safeParse(req.params);
    if (!parsed.success) {
      res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "Invalid owner/repo" } });
      return;
    }
    const branch = String(req.query.branch ?? "").trim();
    if (!branch) {
      res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "Query parameter 'branch' is required" } });
      return;
    }
    const count = Number(req.query.count ?? 20);
    try {
      const commits = await githubService.getCommits(
        req.ghToken!,
        parsed.data.owner,
        parsed.data.repo,
        branch,
        Number.isFinite(count) ? count : 20,
      );
      res.json(commits);
    } catch (err) {
      if (handleGitHubError(err, res)) return;
      console.error("[github route] Unexpected error:", err);
      throw err;
    }
  },
);
