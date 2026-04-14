import { Router } from "express";
import { sshPool } from "../services/ssh-pool.js";
import { channelManager } from "../ws/channels.js";

export const logsRouter = Router();

// GET /api/servers/:serverId/logs/sources
logsRouter.get("/servers/:serverId/logs/sources", async (req, res) => {
  const { serverId } = req.params;
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
