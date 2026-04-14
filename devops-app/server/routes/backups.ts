import { Router } from "express";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { db } from "../db/index.js";
import { backups, servers } from "../db/schema.js";
import { eq, desc } from "drizzle-orm";
import { validateBody } from "../middleware/validate.js";
import { scriptRunner } from "../services/script-runner.js";
import { jobManager } from "../services/job-manager.js";
import { sshPool } from "../services/ssh-pool.js";
import type { Request } from "express";

export const backupsRouter = Router();

const createBackupSchema = z.object({
  databaseName: z.string().min(1),
});

// GET /api/servers/:serverId/backups
backupsRouter.get("/servers/:serverId/backups", async (req, res) => {
  const serverId = req.params.serverId as string;
  const result = await db
    .select()
    .from(backups)
    .where(eq(backups.serverId, serverId))
    .orderBy(desc(backups.createdAt));

  res.json(result);
});

// POST /api/servers/:serverId/backups
backupsRouter.post(
  "/servers/:serverId/backups",
  validateBody(createBackupSchema),
  async (req, res) => {
    const serverId = req.params.serverId as string;
    const { databaseName } = req.body;

    const [server] = await db
      .select()
      .from(servers)
      .where(eq(servers.id, serverId))
      .limit(1);

    if (!server) {
      res.status(404).json({ error: { code: "NOT_FOUND", message: "Server not found" } });
      return;
    }

    const backupId = randomUUID();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();

    await db.insert(backups).values({
      id: backupId,
      serverId,
      databaseName,
      filePath: "",
      fileSize: 0,
      retentionDays: 30,
      expiresAt,
      createdAt: now.toISOString(),
      status: "in-progress",
    });

    try {
      const { jobId } = await scriptRunner.runScript(
        serverId,
        `${server.scriptsPath}/scripts/backup/backup.sh`,
        [`--db=${databaseName}`],
      );

      jobManager.onJobEvent(jobId, async (_id, event) => {
        if (event.type === "status") {
          const status = (event.data as { status: string }).status;
          if (status === "success") {
            await db
              .update(backups)
              .set({ status: "complete" })
              .where(eq(backups.id, backupId));
          } else if (status === "failed") {
            await db
              .update(backups)
              .set({ status: "failed" })
              .where(eq(backups.id, backupId));
          }
        }
      });

      res.status(201).json({ backupId, jobId });
    } catch {
      await db
        .update(backups)
        .set({ status: "failed" })
        .where(eq(backups.id, backupId));

      res.status(500).json({
        error: { code: "BACKUP_ERROR", message: "Failed to start backup" },
      });
    }
  },
);

// POST /api/backups/:id/restore
backupsRouter.post("/backups/:id/restore", async (req, res) => {
  const id = req.params.id as string;
  // Require confirmation header
  if (req.headers["x-confirm-destructive"] !== "true") {
    res.status(400).json({
      error: {
        code: "CONFIRMATION_REQUIRED",
        message: "Restore requires X-Confirm-Destructive: true header",
      },
    });
    return;
  }

  const [backup] = await db
    .select()
    .from(backups)
    .where(eq(backups.id, id))
    .limit(1);

  if (!backup) {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "Backup not found" } });
    return;
  }

  const [server] = await db
    .select()
    .from(servers)
    .where(eq(servers.id, backup.serverId))
    .limit(1);

  if (!server) {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "Server not found" } });
    return;
  }

  try {
    const { jobId } = await scriptRunner.runScript(
      server.id,
      `${server.scriptsPath}/scripts/backup/restore.sh`,
      [`--db=${backup.databaseName}`, `--file=${backup.filePath}`],
    );

    res.json({ jobId });
  } catch {
    res.status(500).json({
      error: { code: "RESTORE_ERROR", message: "Failed to start restore" },
    });
  }
});

// DELETE /api/backups/:id
backupsRouter.delete("/backups/:id", async (req, res) => {
  const id = req.params.id as string;
  const [deleted] = await db
    .delete(backups)
    .where(eq(backups.id, id))
    .returning({ id: backups.id });

  if (!deleted) {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "Backup not found" } });
    return;
  }
  res.status(204).end();
});
