/**
 * Feature 005 R-007: pure function `resolveDeployOperation`.
 *
 * Dispatches deploy/rollback invocations to the right manifest entry based on
 * fields already present on the `applications` row — no new DB column, no
 * enum, no legacy-app branch. Zero side effects.
 */

export interface ResolveDeployInput {
  source?: "manual" | "scan";
  repoUrl: string;
  skipInitialClone: boolean;
  remotePath: string;
  branch: string;
}

export interface ResolveDeployResult {
  scriptId: "deploy/server-deploy" | "deploy/deploy-docker";
  params: Record<string, unknown>;
}

export function resolveDeployOperation(
  app: ResolveDeployInput,
  _runParams: { commit?: string; branch?: string },
): ResolveDeployResult {
  const isDockerOnly = app.repoUrl.startsWith("docker://");

  if (app.skipInitialClone && isDockerOnly) {
    // No git — just docker compose pull + up.
    return {
      scriptId: "deploy/deploy-docker",
      params: {
        remotePath: app.remotePath,
      },
    };
  }

  // Git-backed apps (classic OR scan-git): delegate to the target-side
  // server-deploy.sh which handles fetch + reset + compose rebuild.
  // Branch/commit are NOT passed — server-deploy derives them from git state
  // (origin/$current-branch reset). This matches the old scan-git inline
  // behaviour (cd path && git fetch+reset+deploy).
  return {
    scriptId: "deploy/server-deploy",
    params: {
      appDir: app.remotePath,
    },
  };
}
