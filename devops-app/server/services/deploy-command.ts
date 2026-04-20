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

export function buildDeployCommand(input: DeployCommandInput): DeployCommandResult {
  const { remotePath, repoUrl, deployScript, skipInitialClone, branch, commit } = input;
  const isDockerOnly = repoUrl.startsWith("docker://");

  if (skipInitialClone && isDockerOnly) {
    return {
      mode: "scan-docker",
      raw: true,
      command: `cd ${shQuote(remotePath)} && ${deployScript}`,
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
    parts.push(deployScript);
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
