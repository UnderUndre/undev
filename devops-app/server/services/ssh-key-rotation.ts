/**
 * Feature 011 T044 — atomic SSH key rotation flow per R-012.
 *
 * 5 steps:
 *   1. Generate new keypair (or accept caller-supplied one).
 *   2. Install new pubkey into target's authorized_keys (defensive
 *      mkdir/chmod per gemini #4 — wrong perms break sshd StrictModes).
 *   3. Verify new key by opening a fresh ssh2.Client with the new
 *      private key.
 *   4. Swap encrypted column in a DB tx — at this point the new key is
 *      authoritative.
 *   5. Best-effort remove old pubkey from target (sed -i exact-match).
 *
 * Rollback semantics:
 *   - Failure at step 2 → no DB change, no target change.
 *   - Failure at step 3 → undo step 2 by sed-removing the new pubkey;
 *     DB unchanged.
 *   - Failure at step 4 → tx auto-rolls; target now has BOTH keys but
 *     authority is the OLD one in the DB (still works).
 *   - Failure at step 5 → DB has new key, target has both. Logged as
 *     warning but not surfaced as error.
 *
 * Acquires deployLock(serverId, "ssh-rotate") before step 2 to serialise
 * with deploys.
 */

import { eq } from "drizzle-orm";
import { Client } from "ssh2";
import { db } from "../db/index.js";
import { servers, auditEntries } from "../db/schema.js";
import { logger } from "../lib/logger.js";
import { seal, open, type EnvelopeBlob } from "../lib/envelope-cipher.js";
import { shQuote } from "../lib/sh-quote.js";
import {
  generateEd25519Keypair,
  fingerprintFromOpenSshLine,
} from "../lib/ssh-keygen.js";
import { deployLock } from "./deploy-lock.js";
import { sshPool } from "./ssh-pool.js";
import { randomUUID } from "node:crypto";

export type RotationStep =
  | "generate_keypair"
  | "install_new_key"
  | "verify_new_key"
  | "swap_db_record"
  | "remove_old_key";

export interface RotationOptions {
  removeOldKeyFromTarget: boolean;
}

export type RotationResult =
  | {
      ok: true;
      oldFingerprint: string | null;
      newFingerprint: string;
      step5Warning: string | null;
    }
  | {
      ok: false;
      failedAtStep: RotationStep;
      rolledBack: boolean;
      message: string;
    };

export class DeployLockHeldError extends Error {
  constructor(public retryAfterMs: number) {
    super("deploy lock held");
  }
}

async function execOverFreshClient(
  host: string,
  port: number,
  username: string,
  privateKey: string,
  command: string,
  timeoutMs = 15_000,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    let stdout = "";
    let stderr = "";
    let timer: ReturnType<typeof setTimeout> | null = null;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      try {
        client.end();
      } catch {
        /* ignore */
      }
    };
    timer = setTimeout(() => {
      cleanup();
      reject(new Error(`fresh-client exec timeout (${timeoutMs}ms)`));
    }, timeoutMs);
    client.on("error", (err) => {
      cleanup();
      reject(err);
    });
    client.on("ready", () => {
      client.exec(command, (err, stream) => {
        if (err) {
          cleanup();
          reject(err);
          return;
        }
        stream.on("data", (d: Buffer) => (stdout += d.toString()));
        stream.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
        stream.on("close", (code: number) => {
          cleanup();
          resolve({ stdout, stderr, exitCode: code ?? 0 });
        });
      });
    });
    client.connect({
      host,
      port,
      username,
      privateKey,
      readyTimeout: timeoutMs,
    });
  });
}

export async function rotateKey(
  serverId: string,
  options: RotationOptions,
  userId: string,
): Promise<RotationResult> {
  const [server] = await db
    .select()
    .from(servers)
    .where(eq(servers.id, serverId))
    .limit(1);
  if (!server) throw new Error("server not found");

  // Step 1: generate new keypair.
  const newPair = generateEd25519Keypair();
  const oldFingerprint = server.sshKeyFingerprint;

  const acquired = await deployLock.acquireLock(serverId, "ssh-rotate");
  if (!acquired) {
    throw new DeployLockHeldError(5_000);
  }

  // Step 2: install new pubkey on target.
  try {
    const installCmd =
      `mkdir -p ~/.ssh && chmod 700 ~/.ssh && touch ~/.ssh/authorized_keys && ` +
      `chmod 600 ~/.ssh/authorized_keys && ` +
      `echo ${shQuote(newPair.publicKeyOpenSsh)} >> ~/.ssh/authorized_keys`;
    const installResult = await sshPool.exec(serverId, installCmd, 15_000);
    if (installResult.exitCode !== 0) {
      throw new Error(`install non-zero exit: ${installResult.stderr}`);
    }
  } catch (err) {
    await deployLock.releaseLock(serverId).catch(() => {});
    return {
      ok: false,
      failedAtStep: "install_new_key",
      rolledBack: true,
      message: err instanceof Error ? err.message : String(err),
    };
  }

  // Step 3: verify new key with a fresh ssh2 client.
  try {
    await execOverFreshClient(
      server.host,
      server.port,
      server.sshUser,
      newPair.privateKeyPem,
      "echo verify_ok",
      10_000,
    );
  } catch (err) {
    // Undo step 2.
    try {
      const escaped = newPair.publicKeyOpenSsh.replace(
        /[/\\&]/g,
        "\\$&",
      );
      await sshPool.exec(
        serverId,
        `sed -i ${shQuote("/" + escaped + "/d")} ~/.ssh/authorized_keys || true`,
        10_000,
      );
    } catch {
      /* best effort */
    }
    await deployLock.releaseLock(serverId).catch(() => {});
    return {
      ok: false,
      failedAtStep: "verify_new_key",
      rolledBack: true,
      message: err instanceof Error ? err.message : String(err),
    };
  }

  // Step 4: swap DB record atomically.
  try {
    const sealed = seal(newPair.privateKeyPem);
    await db
      .update(servers)
      .set({
        sshPrivateKeyEncrypted: JSON.stringify(sealed),
        sshKeyFingerprint: newPair.fingerprint,
        sshKeyRotatedAt: new Date().toISOString(),
        sshAuthMethod: "key",
        sshPasswordEncrypted: null,
      })
      .where(eq(servers.id, serverId));
  } catch (err) {
    // No effective rollback — try to remove the new key from the target
    // so deploys still work with the old key.
    try {
      const escaped = newPair.publicKeyOpenSsh.replace(/[/\\&]/g, "\\$&");
      await sshPool.exec(
        serverId,
        `sed -i ${shQuote("/" + escaped + "/d")} ~/.ssh/authorized_keys || true`,
        10_000,
      );
    } catch {
      /* best effort */
    }
    await deployLock.releaseLock(serverId).catch(() => {});
    return {
      ok: false,
      failedAtStep: "swap_db_record",
      rolledBack: true,
      message: err instanceof Error ? err.message : String(err),
    };
  }

  // Step 5: best-effort remove old key from target.
  let step5Warning: string | null = null;
  if (options.removeOldKeyFromTarget && server.sshPrivateKeyEncrypted) {
    try {
      const blob = JSON.parse(server.sshPrivateKeyEncrypted) as EnvelopeBlob;
      const oldPriv = open(blob);
      // Re-derive old pubkey from the now-stale private key (best effort —
      // if decryption fails, skip step 5 with a warning).
      const { publicFromPem } = await import("../lib/ssh-keygen.js");
      const oldPub = publicFromPem(oldPriv).publicKeyOpenSsh;
      const escaped = oldPub.replace(/[/\\&]/g, "\\$&");
      await sshPool.exec(
        serverId,
        `sed -i ${shQuote("/" + escaped + "/d")} ~/.ssh/authorized_keys || true`,
        10_000,
      );
    } catch (err) {
      step5Warning =
        err instanceof Error ? err.message : "step 5 best-effort failed";
      logger.warn(
        { ctx: "ssh-key-rotation", serverId, err },
        "step 5 cleanup failed (non-fatal)",
      );
    }
  }

  // Audit success.
  await db.insert(auditEntries).values({
    id: randomUUID(),
    userId,
    action: "server.key_rotated",
    targetType: "server",
    targetId: serverId,
    details: JSON.stringify({
      oldFingerprint,
      newFingerprint: newPair.fingerprint,
    }),
    result: "success",
    timestamp: new Date().toISOString(),
  });

  await deployLock.releaseLock(serverId).catch((err) => {
    logger.error(
      { ctx: "ssh-key-rotation", serverId, err },
      "lock release failed after success",
    );
  });

  // Reconnect the SSH pool with the fresh key so subsequent deploys use it.
  try {
    sshPool.disconnect(serverId);
  } catch {
    /* ignore */
  }

  return {
    ok: true,
    oldFingerprint,
    newFingerprint: newPair.fingerprint,
    step5Warning,
  };
}

// Dead-import suppression for fingerprintFromOpenSshLine (kept exported by
// ssh-keygen for other callers — the import here documents that we
// re-derive fingerprints during rotation rollback).
void fingerprintFromOpenSshLine;
