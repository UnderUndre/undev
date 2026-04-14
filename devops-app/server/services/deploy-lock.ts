import { sshPool } from "./ssh-pool.js";

const LOCK_PATH = "/tmp/deploy.lock";

class DeployLock {
  async acquireLock(serverId: string, appId: string): Promise<boolean> {
    try {
      const { exitCode } = await sshPool.exec(
        serverId,
        `mkdir ${LOCK_PATH} && echo "${appId}" > ${LOCK_PATH}/owner`,
      );
      return exitCode === 0;
    } catch {
      return false;
    }
  }

  async releaseLock(serverId: string): Promise<void> {
    try {
      await sshPool.exec(serverId, `rm -rf ${LOCK_PATH}`);
    } catch (err) {
      console.error(`[deploy-lock] Failed to release lock on ${serverId}:`, err);
    }
  }

  async checkLock(serverId: string): Promise<string | null> {
    try {
      const { stdout, exitCode } = await sshPool.exec(
        serverId,
        `cat ${LOCK_PATH}/owner 2>/dev/null`,
      );
      if (exitCode === 0 && stdout.trim()) {
        return stdout.trim();
      }
      return null;
    } catch {
      return null;
    }
  }
}

export const deployLock = new DeployLock();
