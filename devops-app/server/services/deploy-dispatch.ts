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
  scriptPath?: string | null;
}

export interface ResolveDeployResult {
  scriptId:
    | "deploy/server-deploy"
    | "deploy/deploy-docker"
    | "deploy/project-local-deploy";
  params: Record<string, unknown>;
}

export function resolveDeployOperation(
  app: ResolveDeployInput,
  runParams: {
    commit?: string;
    branch?: string;
    noCache?: boolean;
    skipCleanup?: boolean;
  },
): ResolveDeployResult {
  // Feature 007: project-local script wins over docker/git heuristics.
  if (app.scriptPath) {
    const branch = runParams.branch ?? app.branch;
    const params: Record<string, unknown> = {
      appDir: app.remotePath,
      scriptPath: app.scriptPath,
      branch,
      noCache: runParams.noCache ?? false,
      skipCleanup: runParams.skipCleanup ?? false,
    };
    if (runParams.commit) params.commit = runParams.commit;
    return { scriptId: "deploy/project-local-deploy", params };
  }

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

  // Git-backed apps: delegate to target-side server-deploy.sh. We explicitly
  // pass branch so the target checks out the UI-selected branch — without
  // this, server-deploy would silently follow whatever HEAD the target shell
  // was pointing at.
  //
  // Pass repoUrl so server-deploy.sh can clone-if-missing on first deploy
  // (incident 2026-05-02 — operator should not have to SSH+mkdir+clone before
  // hitting Deploy on a brand-new app row).
  const branch = runParams.branch ?? app.branch;
  const params: Record<string, unknown> = {
    appDir: app.remotePath,
    branch,
    repoUrl: app.repoUrl,
  };
  if (runParams.commit) {
    params.commit = runParams.commit;
  }
  return {
    scriptId: "deploy/server-deploy",
    params,
  };
}
