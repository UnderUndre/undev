/**
 * Feature 011 T028 — Initialise a fresh VPS via scripts-runner.
 *
 * Drives the server through `setup_state`:
 *   needs_initialisation → initialising → ready (on success)
 *                       → needs_initialisation (on failure, allowing retry)
 *
 * Atomic credential mutation per spec US1/US2 password-mutation edge case:
 *   when pre-init `ssh_auth_method === "password"`, the success-callback
 *   single-tx flips to the new managed key + clears the password column.
 *
 * State transitions on success/failure are wired through the jobManager
 * status events emitted by scriptsRunner.
 */

import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "../db/index.js";
import { auditEntries, servers } from "../db/schema.js";
import { logger } from "../lib/logger.js";
import { scriptsRunner } from "./scripts-runner.js";
import { jobManager } from "./job-manager.js";
import { gate as notificationGate } from "./notification-gate.js";

export interface InitialiseOptions {
  deployUser: string;
  swapSize: string;
  ufwPorts: number[];
  useNoPty: boolean;
  pubkey: string;
  /** Optional managed-key replacement, used when the server was added in
   *  password mode and Initialise is the moment of credential rotation
   *  (US1/US2 edge case). */
  managedKey?: {
    privateKey: string;
    publicKey: string;
    fingerprint: string;
  };
}

export interface InitialiseResult {
  scriptRunId: string;
  jobId: string;
  wsTopic: string;
}

export class InvalidStateError extends Error {
  constructor(public state: string) {
    super(`server in setup_state="${state}"; cannot initialise`);
  }
}

export async function initialiseServer(
  serverId: string,
  options: InitialiseOptions,
  userId: string,
): Promise<InitialiseResult> {
  const [server] = await db
    .select()
    .from(servers)
    .where(eq(servers.id, serverId))
    .limit(1);
  if (!server) throw new Error("server not found");
  if (server.setupState === "initialising") {
    throw new InvalidStateError("initialising");
  }
  if (server.setupState === "ready") {
    // Idempotent re-run: re-allow but re-tag back to initialising for the
    // duration. Operator may need to recover from drift.
  }

  // Pre-flight: flag setup_state. Single update — fits in one tx already.
  await db
    .update(servers)
    .set({ setupState: "initialising" })
    .where(eq(servers.id, serverId));

  const wasPasswordMode = server.sshAuthMethod === "password";
  const result = await scriptsRunner.runScript(
    "server-ops/initialise",
    serverId,
    {
      deployUser: options.deployUser,
      swapSize: options.swapSize,
      ufwPorts: options.ufwPorts,
      useNoPty: options.useNoPty,
      pubkey: options.pubkey,
    },
    userId,
  );

  // Subscribe to terminal status; flip setup_state and (if needed) rotate
  // credentials on exit 0.
  const unsubscribe = jobManager.onJobEvent(result.jobId, (_, event) => {
    if (event.type !== "status") return;
    const status = (event.data as { status: string }).status;
    if (
      status !== "success" &&
      status !== "failed" &&
      status !== "cancelled"
    ) {
      return;
    }

    void (async () => {
      try {
        if (status === "success") {
          // Atomic credential mutation in password→key flip.
          if (
            wasPasswordMode &&
            options.managedKey &&
            options.deployUser
          ) {
            await db
              .update(servers)
              .set({
                setupState: "ready",
                sshUser: options.deployUser,
                sshAuthMethod: "key",
                sshPasswordEncrypted: null,
                // Caller is expected to seal the new key; in the API
                // route, env-vars-store-style helpers run first.
                sshPrivateKeyEncrypted: options.managedKey.privateKey,
                sshKeyFingerprint: options.managedKey.fingerprint,
              })
              .where(eq(servers.id, serverId));
          } else {
            await db
              .update(servers)
              .set({ setupState: "ready" })
              .where(eq(servers.id, serverId));
          }

          await db.insert(auditEntries).values({
            id: randomUUID(),
            userId,
            action: "server.initialised",
            targetType: "server",
            targetId: serverId,
            details: JSON.stringify({
              deployUser: options.deployUser,
              options: {
                swapSize: options.swapSize,
                ufwPorts: options.ufwPorts,
                useNoPty: options.useNoPty,
              },
            }),
            result: "success",
            timestamp: new Date().toISOString(),
          });

          await notificationGate.dispatch({
            eventType: "server.init.succeeded",
            resourceId: serverId,
            payloadFormatter: (suppressed) =>
              `✅ Server initialised: ${server.label}` +
              (suppressed > 0 ? ` (+${suppressed} suppressed)` : ""),
          });
        } else {
          await db
            .update(servers)
            .set({ setupState: "needs_initialisation" })
            .where(eq(servers.id, serverId));

          await notificationGate.dispatch({
            eventType: "server.init.failed",
            resourceId: serverId,
            payloadFormatter: (suppressed) =>
              `❌ Server initialisation failed: ${server.label}` +
              (suppressed > 0 ? ` (+${suppressed} suppressed)` : ""),
          });
        }
      } catch (err) {
        logger.error(
          { ctx: "server-bootstrap", serverId, err },
          "post-init state mutation failed",
        );
      } finally {
        unsubscribe();
      }
    })();
  });

  return {
    scriptRunId: result.runId,
    jobId: result.jobId,
    wsTopic: "script.run.tail",
  };
}
