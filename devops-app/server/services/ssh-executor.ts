import { sshPool } from "./ssh-pool.js";
import { jobManager, type JobEventCallback } from "./job-manager.js";
import { shQuote } from "../lib/sh-quote.js";

export interface RunScriptOptions {
  json?: boolean;
  timeoutMs?: number;
  raw?: boolean; // true = execute command as-is (no bash prefix, no escape)
  onEvent?: JobEventCallback;
}

export interface RunScriptResult {
  jobId: string;
}

export interface ExecuteWithStdinOptions {
  signal?: AbortSignal;
  /** Log each stdout line as-is via jobManager.appendLog. */
  rawLogging?: boolean;
}

const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000; // 20 minutes

class SshExecutor {
  async runScript(
    serverId: string,
    scriptPath: string,
    args: string[] = [],
    options: RunScriptOptions = {},
  ): Promise<RunScriptResult> {
    const { json = true, timeoutMs = DEFAULT_TIMEOUT_MS, raw = false } = options;

    let command: string;
    if (raw) {
      // Raw mode: execute command as-is (for inline SSH commands)
      command = scriptPath;
    } else {
      // Script mode: escape args, prefix with bash
      command = [
        `bash ${shQuote(scriptPath)}`,
        ...(json ? ["--json"] : []),
        ...args.map(shQuote),
      ].join(" ");
    }

    const job = jobManager.createJob("script", serverId, {
      scriptPath,
      args,
      command,
    });

    // Execute asynchronously
    this.executeScript(serverId, command, job.id, json, timeoutMs).catch(
      (err) => {
        jobManager.failJob(job.id, err instanceof Error ? err.message : String(err));
      },
    );

    return { jobId: job.id };
  }

  /**
   * FR-017: Execute `command` on the remote and pipe `stdinBuffer` into its
   * stdin, then close. The SSH command is invariant (`bash -s ...`) — secrets
   * travel inside the encrypted SSH data channel as part of the stdin buffer,
   * not as argv or as per-invocation env prefix.
   *
   * Aborts via the provided AbortSignal: calls the ssh stream's `kill()` which
   * sends SIGKILL to the remote process and closes the channel. This is the
   * primary timeout/cancel path for the new scripts-runner (feature 005).
   *
   * Returns `{ jobId }` immediately; caller subscribes via jobManager.onJobEvent.
   */
  async executeWithStdin(
    serverId: string,
    command: string,
    stdinBuffer: string | Buffer,
    jobId: string,
    options: ExecuteWithStdinOptions = {},
  ): Promise<void> {
    const { stream, kill } = await sshPool.execStream(serverId, command);

    // Abort wiring — SIGKILL + channel close
    const abortHandler = () => {
      kill();
    };
    if (options.signal) {
      if (options.signal.aborted) {
        kill();
        return;
      }
      options.signal.addEventListener("abort", abortHandler, { once: true });
    }

    let buffer = "";

    // Attach listeners BEFORE writing stdin — ssh2 ClientChannel is a Duplex
    // in flowing mode as soon as it's created. If we write first, the remote
    // may push the first stdout chunk before the 'data' handler is attached
    // and we lose those lines (that's exactly what caused "Waiting for
    // output..." to stay forever on the UI — server-deploy.sh's early echoes
    // hit the channel before this subscriber existed).
    stream.on("data", (data: Buffer) => {
      const text = data.toString();
      buffer += text;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        jobManager.appendLog(jobId, line);
      }
    });

    stream.stderr.on("data", (data: Buffer) => {
      jobManager.appendLog(jobId, `[stderr] ${data.toString().trimEnd()}`);
    });

    stream.on("close", (code: number) => {
      options.signal?.removeEventListener("abort", abortHandler);
      if (buffer.trim()) jobManager.appendLog(jobId, buffer.trim());
      if (code === 0) {
        jobManager.completeJob(jobId);
      } else {
        jobManager.failJob(jobId, `Script exited with code ${code}`);
      }
    });

    stream.on("error", (err: Error) => {
      options.signal?.removeEventListener("abort", abortHandler);
      jobManager.failJob(jobId, err.message);
    });

    // Now it's safe to push the script into stdin and close the write side so
    // `bash -s` reads to EOF and starts executing.
    stream.write(stdinBuffer);
    stream.end();
  }

  private async executeScript(
    serverId: string,
    command: string,
    jobId: string,
    parseJson: boolean,
    timeoutMs: number,
  ): Promise<void> {
    const { stream, kill } = await sshPool.execStream(serverId, command);

    // Timeout guard
    const timer = setTimeout(() => {
      kill();
      jobManager.failJob(jobId, `Script timed out after ${timeoutMs / 1000}s`);
    }, timeoutMs);

    let buffer = "";

    stream.on("data", (data: Buffer) => {
      const text = data.toString();
      buffer += text;

      // Process line by line for NDJSON
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? ""; // keep incomplete line in buffer

      for (const line of lines) {
        if (!line.trim()) continue;

        if (parseJson) {
          try {
            const parsed = JSON.parse(line);
            this.handleJsonLine(jobId, parsed);
          } catch {
            // Not valid JSON — treat as raw log
            jobManager.appendLog(jobId, line);
          }
        } else {
          jobManager.appendLog(jobId, line);
        }
      }
    });

    stream.stderr.on("data", (data: Buffer) => {
      jobManager.appendLog(jobId, `[stderr] ${data.toString().trimEnd()}`);
    });

    stream.on("close", (code: number) => {
      clearTimeout(timer);

      // Process remaining buffer
      if (buffer.trim()) {
        jobManager.appendLog(jobId, buffer.trim());
      }

      if (code === 0) {
        jobManager.completeJob(jobId);
      } else {
        jobManager.failJob(jobId, `Script exited with code ${code}`);
      }
    });

    stream.on("error", (err: Error) => {
      clearTimeout(timer);
      jobManager.failJob(jobId, err.message);
    });
  }

  private handleJsonLine(
    jobId: string,
    parsed: Record<string, unknown>,
  ): void {
    const type = parsed.type as string;

    switch (type) {
      case "log":
        jobManager.appendLog(
          jobId,
          `[${parsed.level ?? "info"}] ${parsed.message}`,
        );
        break;
      case "progress":
        jobManager.emitEvent(jobId, {
          type: "progress",
          data: { step: parsed.step, status: parsed.status },
        });
        break;
      case "result":
        jobManager.emitEvent(jobId, {
          type: "result",
          data: parsed.data ?? parsed,
        });
        break;
      default:
        jobManager.appendLog(jobId, JSON.stringify(parsed));
    }
  }
}

export const sshExecutor = new SshExecutor();
// Backwards-compat alias for any pre-005 imports still on the old name.
export const scriptRunner = sshExecutor;
