import { Client, type ConnectConfig, type ClientChannel } from "ssh2";
import { createServer, type AddressInfo, type Server, type Socket } from "node:net";

export interface ServerConfig {
  id: string;
  host: string;
  port: number;
  sshUser: string;
  sshAuthMethod: "key" | "password";
  sshPrivateKey?: string | null; // PEM key content
  sshPassword?: string | null;   // password
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
      const { sshAuthMethod, sshPrivateKey, sshPassword } = entry.config;

      const connectConfig: ConnectConfig = {
        host: entry.config.host,
        port: entry.config.port,
        username: entry.config.sshUser,
        readyTimeout: 10_000,
        keepaliveInterval: 30_000,
        keepaliveCountMax: 3,
      };

      if (sshAuthMethod === "key" && sshPrivateKey) {
        connectConfig.privateKey = sshPrivateKey;
      } else if (sshAuthMethod === "password" && sshPassword) {
        connectConfig.password = sshPassword;
      } else {
        reject(new Error("No SSH credentials configured"));
        return;
      }

      entry.client.on("ready", () => {
        entry.connected = true;
        entry.retryCount = 0;
        entry.reconnecting = false;
        resolve();
      });

      entry.client.on("error", (err: Error) => {
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

  async exec(
    serverId: string,
    command: string,
    timeoutMs = 60_000,
  ): Promise<ExecResult> {
    const entry = this.pool.get(serverId);
    if (!entry?.connected) {
      throw new Error(`No active SSH connection for server ${serverId}`);
    }

    return new Promise((resolve, reject) => {
      entry.client.exec(command, (err: Error | undefined, stream: ClientChannel) => {
        if (err) return reject(err);

        let stdout = "";
        let stderr = "";
        let settled = false;

        const timer = setTimeout(() => {
          if (!settled) {
            settled = true;
            stream.close();
            reject(new Error(`SSH exec timed out after ${timeoutMs}ms`));
          }
        }, timeoutMs);

        stream.on("data", (data: Buffer) => {
          stdout += data.toString();
        });

        stream.stderr.on("data", (data: Buffer) => {
          stderr += data.toString();
        });

        stream.on("close", (code: number) => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve({ stdout, stderr, exitCode: code ?? 0 });
          }
        });

        stream.on("error", (e: Error) => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            reject(e);
          }
        });
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
      entry.client.exec(command, (err: Error | undefined, stream: ClientChannel) => {
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

  /**
   * Feature 006 T012 — short-lived TCP tunnel to a remote host:port via the
   * existing pooled SSH session. Reuses the same auth (no new credentials).
   * Returns a local TCP server bound to an ephemeral 127.0.0.1:port; each
   * incoming connection is forwarded over `ssh2.forwardOut`.
   *
   * Caller MUST call `close()` when done — typically inside a `try/finally`.
   */
  openTunnel(
    serverId: string,
    opts: { remoteHost: string; remotePort: number },
  ): Promise<{ localPort: number; close: () => void }> {
    const entry = this.pool.get(serverId);
    if (!entry?.connected) {
      return Promise.reject(
        new Error(`No active SSH connection for server ${serverId}`),
      );
    }
    const sshClient = entry.client;
    return new Promise((resolve, reject) => {
      const sockets = new Set<Socket>();
      const server: Server = createServer((local) => {
        sockets.add(local);
        local.on("close", () => sockets.delete(local));
        sshClient.forwardOut(
          "127.0.0.1",
          0,
          opts.remoteHost,
          opts.remotePort,
          (err, remote) => {
            if (err) {
              local.destroy(err);
              return;
            }
            local.pipe(remote).pipe(local);
          },
        );
      });
      server.on("error", (err) => reject(err));
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address() as AddressInfo | null;
        if (addr === null) {
          server.close();
          reject(new Error("tunnel: failed to acquire local port"));
          return;
        }
        resolve({
          localPort: addr.port,
          close: () => {
            for (const s of sockets) {
              try {
                s.destroy();
              } catch {
                // ignore
              }
            }
            sockets.clear();
            try {
              server.close();
            } catch {
              // ignore
            }
          },
        });
      });
    });
  }
}

export const sshPool = new SSHPool();
