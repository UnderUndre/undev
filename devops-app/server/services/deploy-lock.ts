import { sshPool } from "./ssh-pool.js";

// Namespaced under a dashboard-specific prefix to avoid name collisions with
// imported apps' own deploy locks. `/tmp/deploy.lock` is a famously generic
// path — most Bash deploy scripts pick it. We used to park a DIRECTORY there
// (mkdir-based atomic lock), which broke apps that expected the same path to
// be a plain FILE (`echo $$ > /tmp/deploy.lock`). The `.d` suffix telegraphs
// "directory, not file" so nobody collides with us either.
const LOCK_PATH = "/tmp/devops-dashboard-deploy.lock.d";

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
