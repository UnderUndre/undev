/**
 * Feature 009: typed error classes for the bootstrap state machine.
 *
 * Each error carries a discriminator `code` mapped 1:1 onto the structured
 * `{ code }` envelope returned by `routes/bootstrap.ts`. The route layer
 * surface MUST translate these into HTTP status codes — this module stays
 * transport-agnostic.
 *
 * Pattern mirrors feature 005's `ScriptNotFoundError` family, feature 008's
 * `IllegalTransitionError`, and feature 002's `GitHubApiError` — every
 * project subsystem owns its error namespace; there is no shared `AppError`
 * superclass and we do not introduce one here.
 */

export type BootstrapErrorCode =
  | "BOOTSTRAP_STATE_INVALID_TRANSITION"
  | "BOOTSTRAP_PATH_JAIL_ESCAPE"
  | "BOOTSTRAP_COMPOSE_FETCH_FAILED"
  | "BOOTSTRAP_SLUG_COLLISION"
  | "BOOTSTRAP_REMOTE_PATH_COLLISION"
  | "BOOTSTRAP_JAIL_ESCAPE";

export class BootstrapStateError extends Error {
  override readonly name = "BootstrapStateError";
  readonly code: BootstrapErrorCode = "BOOTSTRAP_STATE_INVALID_TRANSITION";
  constructor(
    public readonly fromState: string,
    public readonly toState: string,
    message?: string,
  ) {
    super(
      message ??
        `Invalid bootstrap state transition: ${fromState} → ${toState}`,
    );
  }
}

export class PathJailEscapeError extends Error {
  override readonly name = "PathJailEscapeError";
  readonly code: BootstrapErrorCode = "BOOTSTRAP_PATH_JAIL_ESCAPE";
  constructor(
    public readonly resolved: string,
    public readonly jailRoot: string,
  ) {
    super(`Resolved path ${resolved} is outside jail root ${jailRoot}`);
  }
}

export class ComposeFetchError extends Error {
  override readonly name = "ComposeFetchError";
  readonly code: BootstrapErrorCode = "BOOTSTRAP_COMPOSE_FETCH_FAILED";
  constructor(
    public readonly owner: string,
    public readonly repo: string,
    public readonly path: string,
    public readonly reason: "not_found" | "unauthorized" | "rate_limit" | "other",
    message?: string,
  ) {
    super(
      message ??
        `Failed to fetch ${path} from ${owner}/${repo} (${reason})`,
    );
  }
}

export class SlugCollisionError extends Error {
  override readonly name = "SlugCollisionError";
  readonly code: BootstrapErrorCode = "BOOTSTRAP_SLUG_COLLISION";
  constructor(
    public readonly serverId: string,
    public readonly slug: string,
  ) {
    super(`Application slug "${slug}" already exists on server ${serverId}`);
  }
}

export class RemotePathCollisionError extends Error {
  override readonly name = "RemotePathCollisionError";
  readonly code: BootstrapErrorCode = "BOOTSTRAP_REMOTE_PATH_COLLISION";
  constructor(
    public readonly serverId: string,
    public readonly remotePath: string,
  ) {
    super(
      `Remote path "${remotePath}" already used by another app on server ${serverId}`,
    );
  }
}

/**
 * Raised when the runner detects a target-side `rm -rf` would resolve to a
 * path outside `${DEPLOY_USER_HOME}/apps/`. Distinct from PathJailEscapeError
 * which is the orchestrator-side guard; this one wraps the bash exit code 4
 * surfaced by `scripts/bootstrap/hard-delete.sh`.
 */
export class JailEscapeError extends Error {
  override readonly name = "JailEscapeError";
  readonly code: BootstrapErrorCode = "BOOTSTRAP_JAIL_ESCAPE";
  constructor(public readonly resolved: string) {
    super(`Hard-delete refused: resolved path ${resolved} is outside jail`);
  }
}
