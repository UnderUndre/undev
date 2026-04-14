import { Client, type ConnectConfig, type ClientChannel } from "ssh2";
import { readFileSync } from "node:fs";
import { Readable } from "node:stream";

export interface ServerConfig {
  id: string;
  host: string;
  port: number;
  sshUser: string;
  sshKeyPath: string;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface PoolEntry {
  client: Client;
  config: ServerConfig;
  connected: boolean;
  reconnecting: boolean;
  retryCount: number;
}

const MAX_RETRY_DELAY = 30_000;
const BASE_RETRY_DELAY = 1_000;

class SSHPool {
  private pool = new Map<string, PoolEntry>();

  async connect(server: ServerConfig): Promise<void> {
    if (this.pool.has(server.id)) {
      const entry = this.pool.get(server.id)!;
      if (entry.connected) return;
    }

    const client = new Client();
    const entry: PoolEntry = {
      client,
      config: server,
      connected: false,
      reconnecting: false,
      retryCount: 0,
    };

    this.pool.set(server.id, entry);

    await this.connectClient(entry);
  }

  private connectClient(entry: PoolEntry): Promise<void> {
    return new Promise((resolve, reject) => {
      const privateKey = readFileSync(entry.config.sshKeyPath);

      const connectConfig: ConnectConfig = {
        host: entry.config.host,
        port: entry.config.port,
        username: entry.config.sshUser,
        privateKey,
        readyTimeout: 10_000,
        keepaliveInterval: 30_000,
        keepaliveCountMax: 3,
      };

      entry.client.on("ready", () => {
        entry.connected = true;
        entry.retryCount = 0;
        entry.reconnecting = false;
        resolve();
      });

      entry.client.on("error", (err) => {
        console.error(
          `[ssh-pool] Connection error for ${entry.config.id}: ${err.message}`,
        );
        entry.connected = false;
        if (!entry.reconnecting) {
          this.scheduleReconnect(entry);
        }
      });

      entry.client.on("close", () => {
        entry.connected = false;
        if (!entry.reconnecting && this.pool.has(entry.config.id)) {
          this.scheduleReconnect(entry);
        }
      });

      entry.client.on("end", () => {
        entry.connected = false;
      });

      entry.client.connect(connectConfig);

      // Reject on initial connection error
      entry.client.once("error", reject);
    });
  }

  private scheduleReconnect(entry: PoolEntry): void {
    entry.reconnecting = true;
    const delay = Math.min(
      BASE_RETRY_DELAY * 2 ** entry.retryCount,
      MAX_RETRY_DELAY,
    );
    entry.retryCount++;

    console.log(
      `[ssh-pool] Reconnecting ${entry.config.id} in ${delay}ms (attempt ${entry.retryCount})`,
    );

    setTimeout(async () => {
      if (!this.pool.has(entry.config.id)) return;

      // Create fresh client for reconnect
      entry.client = new Client();
      try {
        await this.connectClient(entry);
        console.log(
          `[ssh-pool] Reconnected to ${entry.config.id}`,
        );
      } catch {
        // connectClient will trigger error → scheduleReconnect again
      }
    }, delay);
  }

  async exec(serverId: string, command: string): Promise<ExecResult> {
    const entry = this.pool.get(serverId);
    if (!entry?.connected) {
      throw new Error(`No active SSH connection for server ${serverId}`);
    }

    return new Promise((resolve, reject) => {
      entry.client.exec(command, (err, stream) => {
        if (err) return reject(err);

        let stdout = "";
        let stderr = "";

        stream.on("data", (data: Buffer) => {
          stdout += data.toString();
        });

        stream.stderr.on("data", (data: Buffer) => {
          stderr += data.toString();
        });

        stream.on("close", (code: number) => {
          resolve({ stdout, stderr, exitCode: code ?? 0 });
        });

        stream.on("error", reject);
      });
    });
  }

  execStream(
    serverId: string,
    command: string,
  ): Promise<{ stream: ClientChannel; kill: () => void }> {
    const entry = this.pool.get(serverId);
    if (!entry?.connected) {
      throw new Error(`No active SSH connection for server ${serverId}`);
    }

    return new Promise((resolve, reject) => {
      entry.client.exec(command, (err, stream) => {
        if (err) return reject(err);
        resolve({
          stream,
          kill: () => {
            stream.signal("KILL");
            stream.close();
          },
        });
      });
    });
  }

  disconnect(serverId: string): void {
    const entry = this.pool.get(serverId);
    if (entry) {
      entry.reconnecting = true; // prevent auto-reconnect
      entry.client.end();
      this.pool.delete(serverId);
    }
  }

  disconnectAll(): void {
    for (const [id] of this.pool) {
      this.disconnect(id);
    }
  }

  isConnected(serverId: string): boolean {
    return this.pool.get(serverId)?.connected ?? false;
  }
}

export const sshPool = new SSHPool();
