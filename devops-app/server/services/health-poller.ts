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
    if (!sshPool.isConnected(serverId)) return null;

    try {
      // Fetch server config to use configured scriptsPath
      const [server] = await db
        .select({ scriptsPath: servers.scriptsPath })
        .from(servers)
        .where(eq(servers.id, serverId))
        .limit(1);

      const scriptsPath = server?.scriptsPath ?? "~/scripts";

      const { stdout, exitCode } = await sshPool.exec(
        serverId,
        `bash ${scriptsPath}/monitoring/health-check.sh --json 2>/dev/null || echo '{}'`,
      );

      if (exitCode !== 0) return null;

      const data = JSON.parse(stdout.trim());
      const snapshot = {
        id: randomUUID(),
        serverId,
        timestamp: new Date().toISOString(),
        cpuLoadPercent: data.cpu ?? 0,
        memoryPercent: data.memory ?? 0,
        diskPercent: data.disk ?? 0,
        swapPercent: data.swap ?? 0,
        dockerContainers: data.containers ?? [],
        services: data.services ?? [],
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
