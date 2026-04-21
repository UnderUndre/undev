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
  scriptId: "deploy/deploy" | "deploy/deploy-docker";
  params: Record<string, unknown>;
}

export function resolveDeployOperation(
  app: ResolveDeployInput,
  runParams: { commit?: string; branch?: string },
): ResolveDeployResult {
  const isDockerOnly = app.repoUrl.startsWith("docker://");
  const branch = runParams.branch ?? app.branch;

  if (app.skipInitialClone && isDockerOnly) {
    return {
      scriptId: "deploy/deploy-docker",
      params: {
        remotePath: app.remotePath,
        branch,
        commit: runParams.commit,
      },
    };
  }

  return {
    scriptId: "deploy/deploy",
    params: {
      remotePath: app.remotePath,
      branch,
      commit: runParams.commit,
      skipInitialClone: app.skipInitialClone,
    },
  };
}
