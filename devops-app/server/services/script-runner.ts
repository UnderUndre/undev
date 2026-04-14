import { sshPool } from "./ssh-pool.js";
import { jobManager, type JobEventCallback } from "./job-manager.js";
import type { ClientChannel } from "ssh2";

export interface RunScriptOptions {
  json?: boolean;
  timeoutMs?: number;
  onEvent?: JobEventCallback;
}

export interface RunScriptResult {
  jobId: string;
}

const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000; // 20 minutes

class ScriptRunner {
  async runScript(
    serverId: string,
    scriptPath: string,
    args: string[] = [],
    options: RunScriptOptions = {},
  ): Promise<RunScriptResult> {
    const { json = true, timeoutMs = DEFAULT_TIMEOUT_MS } = options;

    const command = [
      `bash ${scriptPath}`,
      ...(json ? ["--json"] : []),
      ...args,
    ].join(" ");

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

export const scriptRunner = new ScriptRunner();
