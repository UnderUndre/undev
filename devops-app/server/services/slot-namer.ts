/**
 * Feature 012 T026 — first-deploy slot migration ritual per research.md R-008.
 *
 * On first blue/green deploy when `active_color IS NULL`, run
 * `docker rename <existing> <service>-blue` over SSH (metadata-only per
 * R-002 — zero downtime). Idempotent: no-op if container is already
 * named correctly.
 */

import { sshPool } from "./ssh-pool.js";
import { shQuote } from "../lib/sh-quote.js";
import { logger } from "../lib/logger.js";

export type SlotColor = "blue" | "green";

export class SlotMigrationError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "SlotMigrationError";
  }
}

/**
 * Pure function: returns the canonical container name for a given slot.
 */
export function resolveContainerName(serviceName: string, color: SlotColor): string {
  return `${serviceName}-${color}`;
}

/**
 * Best-effort container detection: tries common compose naming patterns.
 * Returns the first match or null. Operators with non-default project
 * naming may need manual intervention — flagged by upstream caller.
 */
async function detectExistingContainerName(
  serverId: string,
  appDir: string,
  serviceName: string,
): Promise<string | null> {
  // docker compose ps formats: <project>_<service>_<idx>, <project>-<service>-<idx>,
  // or explicit container_name. Use compose's own ps to resolve.
  const cmd = `cd ${shQuote(appDir)} && docker compose ps -q ${shQuote(serviceName)} | head -n 1`;
  const result = await sshPool.exec(serverId, cmd, 15_000);
  if (result.exitCode !== 0 || !result.stdout.trim()) return null;
  const containerId = result.stdout.trim();
  // Resolve container ID → name.
  const nameCmd = `docker inspect --format '{{.Name}}' ${shQuote(containerId)}`;
  const nameRes = await sshPool.exec(serverId, nameCmd, 15_000);
  if (nameRes.exitCode !== 0) return null;
  // docker inspect returns "/<name>"; strip leading slash.
  return nameRes.stdout.trim().replace(/^\//, "") || null;
}

export async function migrateExistingToBlueSlot(
  serverId: string,
  appDir: string,
  serviceName: string,
): Promise<void> {
  const target = resolveContainerName(serviceName, "blue");
  const existing = await detectExistingContainerName(serverId, appDir, serviceName);
  if (!existing) {
    // Nothing to migrate — first deploy ever, or container already gone.
    // Idempotent: caller proceeds with normal flow.
    logger.info(
      { ctx: "slot-namer", serverId, serviceName, target },
      "no existing container found; skip rename",
    );
    return;
  }
  if (existing === target) {
    logger.info(
      { ctx: "slot-namer", serverId, serviceName, existing },
      "container already at target name; idempotent skip",
    );
    return;
  }
  // Perform the rename — Docker docs confirm this is metadata-only.
  const cmd = `docker rename ${shQuote(existing)} ${shQuote(target)}`;
  const result = await sshPool.exec(serverId, cmd, 15_000);
  if (result.exitCode !== 0) {
    throw new SlotMigrationError(
      `slot_migration_failed: docker rename exited ${result.exitCode}: ${result.stderr}`,
    );
  }
  logger.info(
    { ctx: "slot-namer", serverId, serviceName, from: existing, to: target },
    "renamed container to blue slot",
  );
}

export const slotNamer = {
  migrateExistingToBlueSlot,
  resolveContainerName,
};
