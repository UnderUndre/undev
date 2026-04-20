import { randomUUID } from "node:crypto";
import { db } from "../db/index.js";
import { healthSnapshots, servers } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { sshPool } from "./ssh-pool.js";
import { channelManager } from "../ws/channels.js";

const DEFAULT_POLL_INTERVAL = 60_000; // 60s

interface PollState {
  serverId: string;
  timer: ReturnType<typeof setTimeout> | null;
  isPolling: boolean;
}

class HealthPoller {
  private polls = new Map<string, PollState>();

  startPolling(serverId: string, intervalMs = DEFAULT_POLL_INTERVAL): void {
    if (this.polls.has(serverId)) return;

    const state: PollState = {
      serverId,
      timer: null,
      isPolling: false,
    };
    this.polls.set(serverId, state);

    this.schedulePoll(state, intervalMs);
  }

  stopPolling(serverId: string): void {
    const state = this.polls.get(serverId);
    if (state?.timer) {
      clearTimeout(state.timer);
    }
    this.polls.delete(serverId);
  }

  stopAll(): void {
    for (const [id] of this.polls) {
      this.stopPolling(id);
    }
  }

  async pollOnce(serverId: string): Promise<Record<string, unknown> | null> {
    // Auto-connect if the pool doesn't have an active session. Previously an
    // unconnected server would silently return null here, leaving status
    // stuck on "unknown" — /health/refresh surfaced that as POLL_FAILED.
    if (!sshPool.isConnected(serverId)) {
      const [row] = await db.select().from(servers).where(eq(servers.id, serverId));
      if (!row) return null;
      try {
        await sshPool.connect({
          id: row.id,
          host: row.host,
          port: row.port,
          sshUser: row.sshUser,
          sshAuthMethod: (row.sshAuthMethod as "key" | "password") ?? "key",
          sshPrivateKey: row.sshPrivateKey,
          sshPassword: row.sshPassword,
        });
      } catch {
        await db
          .update(servers)
          .set({ status: "offline", lastHealthCheck: new Date().toISOString() })
          .where(eq(servers.id, serverId));
        return null;
      }
    }

    try {
      // Inline health check — no external script needed
      const healthCmd = [
        // CPU load (1-min avg as percentage of cores)
        `echo -n '"cpu":' && awk '{printf "%.1f", $1 * 100 / '$(nproc)'}' /proc/loadavg`,
        // Memory percentage
        `echo -n ',"memory":' && free | awk '/Mem:/{printf "%.1f", $3/$2*100}'`,
        // Disk percentage (root)
        `echo -n ',"disk":' && df / | awk 'NR==2{printf "%.1f", $5}'`,
        // Swap percentage
        `echo -n ',"swap":' && free | awk '/Swap:/{if($2>0) printf "%.1f", $3/$2*100; else printf "0"}'`,
        // Docker containers (JSON array)
        `echo -n ',"containers":' && (docker ps -a --format '{"name":"{{.Names}}","status":"{{.Status}}"}' 2>/dev/null | jq -s '.' 2>/dev/null || echo '[]')`,
        // Services check
        `echo -n ',"services":' && echo '[' && (systemctl is-active nginx 2>/dev/null && echo '{"name":"nginx","running":true},' || echo '{"name":"nginx","running":false},') && (systemctl is-active docker 2>/dev/null && echo '{"name":"docker","running":true}' || echo '{"name":"docker","running":false}') && echo ']'`,
      ].join(" && ");

      const { stdout } = await sshPool.exec(
        serverId,
        `echo '{' && ${healthCmd} && echo '}'`,
      );

      let data: Record<string, unknown>;
      try {
        data = JSON.parse(stdout.trim());
      } catch {
        // Fallback: parse what we can
        data = {};
      }

      const snapshot = {
        id: randomUUID(),
        serverId,
        timestamp: new Date().toISOString(),
        cpuLoadPercent: Number(data.cpu) || 0,
        memoryPercent: Number(data.memory) || 0,
        diskPercent: Number(data.disk) || 0,
        swapPercent: Number(data.swap) || 0,
        dockerContainers: (data.containers as unknown[]) ?? [],
        services: (data.services as unknown[]) ?? [],
      };

      await db.insert(healthSnapshots).values(snapshot);

      // Update server status
      await db
        .update(servers)
        .set({ status: "online", lastHealthCheck: snapshot.timestamp })
        .where(eq(servers.id, serverId));

      // Broadcast to WebSocket subscribers
      channelManager.broadcast(`health:${serverId}`, {
        type: "health",
        data: snapshot,
      });

      return snapshot;
    } catch (err) {
      await db
        .update(servers)
        .set({ status: "offline", lastHealthCheck: new Date().toISOString() })
        .where(eq(servers.id, serverId));

      return null;
    }
  }

  private schedulePoll(state: PollState, intervalMs: number): void {
    state.timer = setTimeout(async () => {
      if (!this.polls.has(state.serverId)) return;

      // Guard against overlapping polls
      if (state.isPolling) {
        this.schedulePoll(state, intervalMs);
        return;
      }

      state.isPolling = true;
      try {
        await this.pollOnce(state.serverId);
      } catch {
        // Swallow — don't crash the poller
      } finally {
        state.isPolling = false;
      }

      // Schedule next poll (recursive setTimeout, not setInterval)
      if (this.polls.has(state.serverId)) {
        this.schedulePoll(state, intervalMs);
      }
    }, intervalMs);
  }
}

export const healthPoller = new HealthPoller();
