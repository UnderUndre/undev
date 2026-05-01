import { Router } from "express";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/index.js";
import { servers } from "../db/schema.js";
import { sshPool } from "../services/ssh-pool.js";
import { channelManager } from "../ws/channels.js";
import { shQuote } from "../lib/sh-quote.js";
import { logger } from "../lib/logger.js";

export const logsRouter = Router();

/**
 * Lazy-connect helper for endpoints that need an SSH channel even after a
 * dashboard recreate that wiped the pool. Looks up server config from DB,
 * attempts `sshPool.connect`. Returns true on success, false on failure
 * (caller surfaces 503).
 *
 * Incident 2026-05-02: self-deploy modal showed "Target SSH not connected"
 * because the new dashboard container had an empty pool until the next
 * polling tick. Now any read endpoint can dial-on-demand.
 */
async function ensureSshConnected(serverId: string): Promise<boolean> {
  if (sshPool.isConnected(serverId)) return true;
  const [server] = await db
    .select()
    .from(servers)
    .where(eq(servers.id, serverId))
    .limit(1);
  if (!server) return false;
  try {
    await sshPool.connect({
      id: server.id,
      host: server.host,
      port: server.port,
      sshUser: server.sshUser,
      sshAuthMethod: (server.sshAuthMethod as "key" | "password") ?? "key",
      sshPrivateKey: server.sshPrivateKey,
      sshPassword: server.sshPassword,
    });
    return sshPool.isConnected(serverId);
  } catch (err) {
    logger.warn(
      { ctx: "ssh-lazy-connect", serverId, err },
      "lazy-connect failed",
    );
    return false;
  }
}

// ── File-tail endpoint (incident 2026-05-01 — UI live tail for self-deploy) ──
//
// Live `tail -f`-like reader for arbitrary files on the target. Used by the
// frontend Job log panel to stream `deploy.log` after self-deploy detach,
// where in-band SSH stdout pipe dies with the dashboard container recreate.
//
// Contract:
//   GET /api/servers/:serverId/file-tail?path=<absolute>&offset=<bytes>
//   →  { chunk: string, newOffset: number, fileSize: number, eof: boolean }
//
// The client maintains `offset` as a cursor: passes 0 on first call, then
// echoes `newOffset` on every subsequent poll. Idempotent, resumable, no
// race conditions. `eof` is `newOffset === fileSize` — UI uses it to render
// "Up to date" indicator when poll catches up.
//
// Safety:
//   • Path MUST be absolute, ≤ 256 chars, printable ASCII, no `..`, no `\`.
//     Must end with `.log` (whitelist) — prevents reading /etc/shadow etc.
//   • SSH-side `realpath -e` resolves symlinks; resolved path STILL validated
//     against the same rules.
//   • Per-request cap: 64 KiB chunk. Big files require multiple polls.
//   • Auth: requireAuth middleware (mounted globally on /api).

const FILE_TAIL_REGEX = /^\/[\x20-\x7E]{0,255}$/;
const MAX_CHUNK_BYTES = 64 * 1024;

const fileTailQuery = z.object({
  path: z
    .string()
    .min(2)
    .max(256)
    .regex(FILE_TAIL_REGEX, "path must be absolute printable-ASCII")
    .refine((p) => !p.includes(".."), "path must not contain ..")
    .refine((p) => !p.includes("\\"), "path must not contain backslashes")
    .refine(
      (p) => p.endsWith(".log"),
      "path must end with .log (whitelist for safety)",
    ),
  offset: z.coerce.number().int().nonnegative().default(0),
});

logsRouter.get("/servers/:serverId/file-tail", async (req, res) => {
  const serverId = req.params.serverId as string;
  const parse = fileTailQuery.safeParse(req.query);
  if (!parse.success) {
    res.status(400).json({
      error: { code: "INVALID_PARAMS", message: parse.error.message },
    });
    return;
  }
  const { path, offset } = parse.data;

  // Lazy-connect: post-self-deploy the new dashboard container has a fresh
  // empty pool. Endpoint-level dial avoids forcing the operator to manually
  // reconnect via the Servers page just to see their deploy progress.
  const ssh = await ensureSshConnected(serverId);
  if (!ssh) {
    res.status(503).json({
      error: {
        code: "SSH_DISCONNECTED",
        message:
          "Target SSH not connected and lazy-connect failed. Check server credentials in Settings.",
      },
    });
    return;
  }

  try {
    // 1. realpath + size in one round-trip. Output: "<resolvedPath>\n<size>"
    //    or empty if the file is missing.
    const probeCmd = `set -e; p=$(realpath -e ${shQuote(path)} 2>/dev/null) || exit 2; printf '%s\\n' "$p"; stat -c %s "$p"`;
    const probe = await sshPool.exec(serverId, probeCmd, 10_000);
    if (probe.exitCode !== 0) {
      res.status(404).json({
        error: { code: "FILE_NOT_FOUND", message: `Cannot stat ${path}` },
      });
      return;
    }
    const [resolvedPath, sizeStr] = probe.stdout.trim().split("\n");
    if (!resolvedPath || !sizeStr) {
      res.status(500).json({
        error: { code: "PROBE_PARSE", message: "Unexpected probe output" },
      });
      return;
    }
    // Re-validate resolved path (defends symlink-to-/etc/shadow attacks).
    if (
      !FILE_TAIL_REGEX.test(resolvedPath) ||
      resolvedPath.includes("..") ||
      resolvedPath.includes("\\") ||
      !resolvedPath.endsWith(".log")
    ) {
      res.status(403).json({
        error: {
          code: "PATH_RESOLVED_UNSAFE",
          message: "Resolved symlink target failed safety check",
        },
      });
      return;
    }
    const fileSize = Number.parseInt(sizeStr, 10);
    if (!Number.isFinite(fileSize) || fileSize < 0) {
      res.status(500).json({
        error: { code: "PROBE_PARSE", message: "Bad file size" },
      });
      return;
    }

    // 2. Empty delta — caller is up-to-date.
    if (offset >= fileSize) {
      res.json({ chunk: "", newOffset: fileSize, fileSize, eof: true });
      return;
    }

    // 3. Read at most MAX_CHUNK_BYTES from offset+1 (1-indexed for `tail -c +N`).
    const wantBytes = Math.min(MAX_CHUNK_BYTES, fileSize - offset);
    const tailCmd = `tail -c +${offset + 1} ${shQuote(resolvedPath)} | head -c ${wantBytes}`;
    const tail = await sshPool.exec(serverId, tailCmd, 15_000);
    if (tail.exitCode !== 0) {
      logger.warn(
        { ctx: "file-tail", serverId, path, exitCode: tail.exitCode, stderr: tail.stderr },
        "tail/head exited non-zero",
      );
      res.status(500).json({
        error: { code: "READ_FAILED", message: "tail/head failed on target" },
      });
      return;
    }

    const chunk = tail.stdout;
    const newOffset = offset + Buffer.byteLength(chunk, "utf8");
    res.json({
      chunk,
      newOffset,
      fileSize,
      eof: newOffset >= fileSize,
    });
  } catch (err) {
    logger.error(
      { ctx: "file-tail", serverId, path, err },
      "file-tail unexpected failure",
    );
    res.status(500).json({
      error: {
        code: "INTERNAL",
        message: err instanceof Error ? err.message : String(err),
      },
    });
  }
});

// GET /api/servers/:serverId/logs/sources
logsRouter.get("/servers/:serverId/logs/sources", async (req, res) => {
  const serverId = req.params.serverId as string;
  const sources: string[] = [];

  if (!sshPool.isConnected(serverId)) {
    res.json(sources);
    return;
  }

  try {
    // Detect available log sources
    const checks = [
      { name: "pm2", cmd: "command -v pm2 >/dev/null 2>&1 && echo yes || echo no" },
      { name: "docker", cmd: "command -v docker >/dev/null 2>&1 && echo yes || echo no" },
      { name: "nginx-access", cmd: "test -f /var/log/nginx/access.log && echo yes || echo no" },
      { name: "nginx-error", cmd: "test -f /var/log/nginx/error.log && echo yes || echo no" },
    ];

    for (const check of checks) {
      const { stdout } = await sshPool.exec(serverId, check.cmd);
      if (stdout.trim() === "yes") {
        sources.push(check.name);
      }
    }
  } catch {
    // Return whatever we found
  }

  res.json(sources);
});
