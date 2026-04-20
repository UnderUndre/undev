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

function shQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * Normalises a deploy-script invocation so that `cd <remotePath> && <script>`
 * works even when the admin typed a bare filename (e.g. "deploy.sh") that
 * is not on `$PATH`. Classic mode (bash <path>/<script>) doesn't need this
 * because it uses the absolute path; the scan-git and scan-docker modes do.
 *
 * Rules:
 *   - Absolute path (starts with `/`)                    → unchanged
 *   - Starts with `./` or `../`                          → unchanged
 *   - Starts with a shell keyword/builtin (`docker`,     → unchanged (command pipeline)
 *     `npm`, `pnpm`, `yarn`, `node`, `bash`, `sh`,
 *     `systemctl`, `service`, `pm2`, `make`) or contains
 *     a space/pipe/&&/|| etc.
 *   - Otherwise treated as a bare file name              → prefixed with `./`
 */
export function normaliseScriptInvocation(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;
  // Absolute path.
  if (trimmed.startsWith("/")) return trimmed;
  // Already-explicit relative path.
  if (trimmed.startsWith("./") || trimmed.startsWith("../")) return trimmed;
  // Looks like a command pipeline (has a space, pipe, semicolon, redirection,
  // etc.) — leave untouched so `docker compose up -d` or `make deploy` work.
  if (/[\s|&;<>]/.test(trimmed)) return trimmed;
  // Starts with a well-known binary name — definitely a command, not a file
  // in the cwd (defence-in-depth on top of the whitespace check above).
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
  // Bare filename — prefix with `./` so it resolves inside the cwd after cd.
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
