/**
 * Builds the shell command used to deploy an application.
 *
 * Split into three modes (see deployments.ts for the dispatch site):
 *   - classic     → bash <path>/<script> --branch=<B> [--commit=<C>]
 *   - scan-git    → cd <path> && git fetch+reset FETCH_HEAD && <deployScript>
 *   - scan-docker → cd <path> && <deployScript>
 *
 * Branch values passed here are assumed pre-validated by the route's Zod
 * regex; remotePath is canonicalised at write time. Both are still
 * single-quoted as defence-in-depth.
 */

import { shQuote } from "../lib/sh-quote.js";

export interface DeployCommandInput {
  remotePath: string;
  repoUrl: string;
  deployScript: string;
  skipInitialClone: boolean;
  branch: string;
  commit?: string;
}

export type DeployCommandMode = "classic" | "scan-git" | "scan-docker";

export interface DeployCommandResult {
  mode: DeployCommandMode;
  /** True when `command` should be executed verbatim by runScript ({raw:true}). */
  raw: boolean;
  /**
   * For `classic` mode this is the bash script path; the caller should join
   * it with args (`--branch=...`, `--commit=...`). For the other modes it
   * is the full shell one-liner.
   */
  command: string;
}

/**
 * Returns true when the path points at a shell script we can safely delegate
 * to `bash`. We intentionally do NOT include `.bash` (rare) to keep the rule
 * narrow; admins who use weird extensions can pre-chmod+x and use an
 * explicit `./path` invocation.
 */
function looksLikeShellScript(path: string): boolean {
  return /\.sh$/i.test(path);
}

/**
 * Normalises a deploy-script invocation so that `cd <remotePath> && <script>`
 * works even when the admin typed a bare filename (e.g. "deploy.sh") that
 * is not on `$PATH`. Classic mode (bash <path>/<script>) doesn't need this
 * because it uses the absolute path; the scan-git and scan-docker modes do.
 *
 * Rules:
 *   - Command pipelines (contain space/pipe/&&/||/redirection)  → unchanged
 *   - Starts with a well-known binary name                       → unchanged
 *   - Anything ending in `.sh` (absolute, relative, or bare)     → `bash <path>`
 *     Rationale: `./foo.sh` requires the file to have an exec bit, which
 *     often gets lost after `git clone` on hosts where `core.filemode` is
 *     disabled. `bash foo.sh` reads and interprets the file regardless of
 *     POSIX exec perm — much more robust for scan-imported apps.
 *   - Absolute path (`/...`), not .sh                            → unchanged
 *   - Relative path (`./...` / `../...`), not .sh                → unchanged
 *   - Bare name, not .sh                                         → prefixed with `./`
 */
export function normaliseScriptInvocation(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;
  // Command pipeline check first — `bash foo.sh && baz` shouldn't be wrapped.
  if (/[\s|&;<>]/.test(trimmed)) return trimmed;
  // Well-known binary names pass through (`pm2`, `make`, `docker`, etc.).
  const firstWord = trimmed.split(/[\s]/)[0] ?? trimmed;
  const KNOWN_BINARIES = new Set([
    "docker",
    "npm",
    "pnpm",
    "yarn",
    "node",
    "bash",
    "sh",
    "zsh",
    "systemctl",
    "service",
    "pm2",
    "make",
    "python",
    "python3",
    "go",
    "cargo",
    "rake",
  ]);
  if (KNOWN_BINARIES.has(firstWord)) return trimmed;
  // .sh file — run via bash regardless of exec bit. Normalise relative bare
  // names to `./` first so `bash scripts/deploy.sh` works (bash accepts
  // relative paths inside cwd without a prefix, but we stay explicit).
  if (looksLikeShellScript(trimmed)) {
    const pathPart =
      trimmed.startsWith("/") || trimmed.startsWith("./") || trimmed.startsWith("../")
        ? trimmed
        : `./${trimmed}`;
    return `bash ${pathPart}`;
  }
  // Non-.sh absolute path — unchanged (admin knows the interpreter).
  if (trimmed.startsWith("/")) return trimmed;
  // Explicit relative — unchanged.
  if (trimmed.startsWith("./") || trimmed.startsWith("../")) return trimmed;
  // Bare filename (non-.sh) — prefix with `./`.
  return `./${trimmed}`;
}

export function buildDeployCommand(input: DeployCommandInput): DeployCommandResult {
  const { remotePath, repoUrl, deployScript, skipInitialClone, branch, commit } = input;
  const isDockerOnly = repoUrl.startsWith("docker://");

  // In scan-{git,docker} modes the deploy script runs after `cd <remotePath>`.
  // A bare filename like "deploy.sh" won't be on $PATH — normalise it to
  // "./deploy.sh". Command pipelines (docker compose up -d, make deploy) are
  // passed through untouched.
  const scriptInvocation = normaliseScriptInvocation(deployScript);

  if (skipInitialClone && isDockerOnly) {
    return {
      mode: "scan-docker",
      raw: true,
      command: `cd ${shQuote(remotePath)} && ${scriptInvocation}`,
    };
  }

  if (skipInitialClone) {
    const parts = [
      `cd ${shQuote(remotePath)}`,
      `timeout 30s git -c safe.directory='*' fetch --quiet origin ${shQuote(branch)}`,
      `timeout 10s git -c safe.directory='*' reset --hard FETCH_HEAD`,
    ];
    if (commit) {
      parts.push(`timeout 10s git -c safe.directory='*' checkout ${shQuote(commit)}`);
    }
    parts.push(scriptInvocation);
    return {
      mode: "scan-git",
      raw: true,
      command: parts.join(" && "),
    };
  }

  return {
    mode: "classic",
    raw: false,
    command: `${remotePath}/${deployScript}`,
  };
}
