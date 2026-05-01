/**
 * Feature 009 FR-028 / R-008: target-side path-jail check.
 *
 * Resolves a remote path via `readlink -f || realpath` and asserts the
 * resolved value is at or under `${jailRoot}`. Defence against:
 *   - symlink trickery (`apps/foo → /etc`)
 *   - parent-traversal (`apps/../../etc`)
 *   - absolute paths outside the jail
 *
 * The check runs IN the same shell that subsequently executes destructive
 * commands (e.g. `rm -rf`) so the TOCTOU window is bounded to one SSH
 * session. Raises `PathJailEscapeError` on any escape.
 *
 * Pure dependency-injected for testability — callers wire `execCapture`
 * to `sshPool.execStream` (or a mock).
 */

import { shQuote } from "./sh-quote.js";
import { PathJailEscapeError } from "./bootstrap-errors.js";

export interface ExecCaptureResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type ExecCapture = (
  serverId: string,
  command: string,
) => Promise<ExecCaptureResult>;

export interface JailCheckOk {
  ok: true;
  resolved: string;
}
export interface JailCheckFail {
  ok: false;
  error: string;
}
export type JailCheckResult = JailCheckOk | JailCheckFail;

/**
 * Resolve `remotePath` on `serverId` and confirm it lives at or below
 * `jailRoot`. Trailing-slash normalisation prevents `/home/deploy/apps2`
 * sneaking past a `/home/deploy/apps` prefix check.
 */
export async function resolveAndJailCheck(
  exec: ExecCapture,
  serverId: string,
  remotePath: string,
  jailRoot: string,
): Promise<JailCheckResult> {
  if (typeof remotePath !== "string" || remotePath.length === 0) {
    return { ok: false, error: "remotePath must be a non-empty string" };
  }
  if (typeof jailRoot !== "string" || !jailRoot.startsWith("/")) {
    return { ok: false, error: "jailRoot must be an absolute path" };
  }

  const quoted = shQuote(remotePath);
  // Use both `readlink -f` (GNU) and `realpath` for BusyBox parity (R-008).
  const cmd =
    `readlink -f ${quoted} 2>/dev/null || realpath ${quoted} 2>/dev/null`;

  const result = await exec(serverId, cmd);
  if (result.exitCode !== 0 || result.stdout.trim() === "") {
    return {
      ok: false,
      error: `Could not resolve ${remotePath} on target`,
    };
  }

  const resolved = result.stdout.trim();
  const jailWithSep = jailRoot.endsWith("/") ? jailRoot : `${jailRoot}/`;

  if (resolved !== jailRoot && !resolved.startsWith(jailWithSep)) {
    return {
      ok: false,
      error: `Resolved path ${resolved} is outside jail root ${jailRoot}`,
    };
  }

  return { ok: true, resolved };
}

/**
 * Throwing variant — convenient for orchestrator code that wants to
 * fail-closed without manual {ok}-narrowing.
 */
export async function assertJailed(
  exec: ExecCapture,
  serverId: string,
  remotePath: string,
  jailRoot: string,
): Promise<string> {
  const result = await resolveAndJailCheck(exec, serverId, remotePath, jailRoot);
  if (!result.ok) {
    throw new PathJailEscapeError(remotePath, jailRoot);
  }
  return result.resolved;
}
