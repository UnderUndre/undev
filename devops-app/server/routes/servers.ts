import { Router } from "express";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { db } from "../db/index.js";
import { servers } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { validateBody } from "../middleware/validate.js";
import { sshPool } from "../services/ssh-pool.js";
import { serializeServer, serializeServers } from "../lib/serializer.js";
import { scriptRunner } from "../services/ssh-executor.js";

export const serversRouter = Router();

const createServerSchema = z.object({
  label: z.string().min(1).max(100),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535).default(22),
  sshUser: z.string().min(1),
  sshAuthMethod: z.enum(["key", "password"]).default("key"),
  sshPrivateKey: z.string().optional(),
  sshPassword: z.string().optional(),
  scriptsPath: z.string().default(""),
  scanRoots: z
    .array(
      z
        .string()
        .regex(/^\//, "scanRoot must be absolute")
        .max(512, "scanRoot exceeds 512 chars")
        .refine(
          (s) => !/["'`;&|<>()\\\n]/.test(s),
          "scanRoot contains shell metacharacters",
        ),
    )
    .max(20, "scanRoots exceeds maximum of 20 entries")
    .optional(),
});

const updateServerSchema = createServerSchema.partial();

/**
 * Appends `scriptsPath` to the `scanRoots` array when set and not already
 * present. Applied on create only — updates leave an admin-provided list intact.
 */
function applyDefaultScanRoots(body: {
  scanRoots?: string[];
  scriptsPath?: string;
}): string[] | undefined {
  const roots = body.scanRoots;
  const scriptsPath = body.scriptsPath?.trim();
  if (!scriptsPath) return roots;
  if (!roots) {
    // Fall back to column default + scriptsPath; column default is applied by
    // Postgres when scanRoots is omitted, so we only need to return a value
    // when we actually want to override the default.
    return ["/opt", "/srv", "/var/www", "/home", scriptsPath];
  }
  return roots.includes(scriptsPath) ? roots : [...roots, scriptsPath];
}

// GET /api/servers
serversRouter.get("/", async (_req, res) => {
  const result = await db.select().from(servers);
  res.json(serializeServers(result));
});

// POST /api/servers
serversRouter.post("/", validateBody(createServerSchema), async (req, res) => {
  const id = randomUUID();
  const now = new Date().toISOString();
  const scanRoots = applyDefaultScanRoots(req.body);

  const [server] = await db
    .insert(servers)
    .values({ id, ...req.body, scanRoots, createdAt: now })
    .returning();

  res.status(201).json(serializeServer(server!));
});

// GET /api/servers/:id
serversRouter.get("/:id", async (req, res) => {
  const id = req.params.id as string;
  const [server] = await db
    .select()
    .from(servers)
    .where(eq(servers.id, id))
    .limit(1);

  if (!server) {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "Server not found" } });
    return;
  }
  res.json(serializeServer(server));
});

// PUT /api/servers/:id
serversRouter.put("/:id", validateBody(updateServerSchema), async (req, res) => {
  const id = req.params.id as string;
  const [server] = await db
    .update(servers)
    .set(req.body)
    .where(eq(servers.id, id))
    .returning();

  if (!server) {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "Server not found" } });
    return;
  }
  res.json(serializeServer(server));
});

// DELETE /api/servers/:id
serversRouter.delete("/:id", async (req, res) => {
  const id = req.params.id as string;
  sshPool.disconnect(id);

  const [deleted] = await db
    .delete(servers)
    .where(eq(servers.id, id))
    .returning({ id: servers.id });

  if (!deleted) {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "Server not found" } });
    return;
  }
  res.status(204).end();
});

// POST /api/servers/:id/verify
serversRouter.post("/:id/verify", async (req, res) => {
  const id = req.params.id as string;
  const [server] = await db
    .select()
    .from(servers)
    .where(eq(servers.id, id))
    .limit(1);

  if (!server) {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "Server not found" } });
    return;
  }

  const start = Date.now();
  try {
    await sshPool.connect({
      id: server.id,
      host: server.host,
      port: server.port,
      sshUser: server.sshUser,
      sshAuthMethod: (server.sshAuthMethod as "key" | "password") ?? "key",
      sshPrivateKey: server.sshPrivateKey,
      sshPassword: server.sshPassword,
    });

    const latencyMs = Date.now() - start;

    await db
      .update(servers)
      .set({ status: "online", lastHealthCheck: new Date().toISOString() })
      .where(eq(servers.id, server.id));

    res.json({ status: "online", latencyMs });
  } catch (err) {
    const latencyMs = Date.now() - start;

    await db
      .update(servers)
      .set({ status: "offline", lastHealthCheck: new Date().toISOString() })
      .where(eq(servers.id, server.id));

    res.json({
      status: "offline",
      latencyMs,
      error: err instanceof Error ? err.message : "Connection failed",
    });
  }
});

// POST /api/servers/:id/setup (T046)
const setupSchema = z.object({
  tasks: z.array(z.string().min(1)).min(1),
});

serversRouter.post("/:id/setup", validateBody(setupSchema), async (req, res) => {
  const id = req.params.id as string;
  const [server] = await db
    .select()
    .from(servers)
    .where(eq(servers.id, id))
    .limit(1);

  if (!server) {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "Server not found" } });
    return;
  }

  const { tasks } = req.body;

  try {
    // Run tasks sequentially as one job
    const scriptArgs = tasks.map((t: string) => `--task=${t}`);
    const { jobId } = await scriptRunner.runScript(
      server.id,
      "~/.undev/scripts/setup/setup-vps.sh",
      scriptArgs,
    );

    res.json({ jobId });
  } catch {
    res.status(500).json({
      error: { code: "SETUP_ERROR", message: "Failed to start server setup" },
    });
  }
});

// ── Feature 011 — server onboarding (US1) ───────────────────────────────────

import {
  probeServer,
  createServer,
  CompatibilityUnresolvedError,
  HostKeyChangedError,
  ProbeTokenExpiredError,
  SshAuthFailedError,
  type BootstrapAuth,
  type ManagedSshCredential,
} from "../services/server-onboarding.js";
import {
  probeCloudProvider,
} from "../services/cloud-init-probe.js";
import { probeCompatibility } from "../services/compatibility-probe.js";

// POST /api/servers/probe — stateless connection + cloud + compat probe.
const probeBodySchema = z
  .object({
    host: z.string().min(1),
    port: z.number().int().min(1).max(65535).default(22),
    sshUser: z.string().min(1),
    bootstrapAuth: z.discriminatedUnion("mode", [
      z.object({ mode: z.literal("key"), privateKey: z.string().min(1) }),
      z.object({ mode: z.literal("password"), password: z.string().min(1) }),
      z.object({ mode: z.literal("generate-key") }),
    ]),
    acceptHostKeyChange: z.boolean().optional(),
    expectedHostKeyFingerprint: z.string().nullable().optional(),
  })
  .strict();

serversRouter.post(
  "/probe",
  validateBody(probeBodySchema),
  async (req, res) => {
    const body = req.body as z.infer<typeof probeBodySchema>;
    try {
      const result = await probeServer({
        host: body.host,
        port: body.port,
        sshUser: body.sshUser,
        bootstrapAuth: body.bootstrapAuth as BootstrapAuth,
        acceptHostKeyChange: body.acceptHostKeyChange ?? false,
        expectedHostKeyFingerprint: body.expectedHostKeyFingerprint ?? null,
      });
      res.json(result);
    } catch (err) {
      if (err instanceof SshAuthFailedError) {
        res.status(401).json({
          error: {
            code: "ssh_auth_failed",
            message: err.message,
            details: err.generatedPublicKey
              ? { generatedPublicKey: err.generatedPublicKey }
              : undefined,
          },
        });
        return;
      }
      if (err instanceof HostKeyChangedError) {
        res.status(409).json({
          error: {
            code: "host_key_changed",
            message: "Target host key changed since last connection",
            details: {
              oldFingerprint: err.oldFingerprint,
              newFingerprint: err.newFingerprint,
            },
          },
        });
        return;
      }
      throw err;
    }
  },
);

// POST /api/servers (split from legacy `/`) — consume probeToken and persist.
const createBodySchema = z
  .object({
    label: z.string().min(1),
    host: z.string().min(1),
    port: z.number().int().min(1).max(65535).default(22),
    sshUser: z.string().min(1),
    scriptsPath: z.string().min(1).default("/opt/devops-scripts"),
    scanRoots: z.array(z.string()).optional(),
    probeToken: z.string().uuid(),
    managedSshCredential: z.discriminatedUnion("mode", [
      z.object({
        mode: z.literal("key"),
        privateKey: z.string().min(1),
        publicKey: z.string().min(1),
      }),
      z.object({ mode: z.literal("password"), password: z.string().min(1) }),
      z.object({
        mode: z.literal("generated"),
        privateKey: z.string().min(1),
        publicKey: z.string().min(1),
      }),
    ]),
    acceptHostKeyChange: z.boolean().optional(),
    acknowledgedWarnings: z.array(z.string()).default([]),
  })
  .strict();

serversRouter.post(
  "/onboard",
  validateBody(createBodySchema),
  async (req, res) => {
    const body = req.body as z.infer<typeof createBodySchema>;
    const userId =
      (req as typeof req & { userId?: string }).userId ?? "unknown";
    try {
      const result = await createServer(
        {
          label: body.label,
          host: body.host,
          port: body.port,
          sshUser: body.sshUser,
          scriptsPath: body.scriptsPath,
          ...(body.scanRoots ? { scanRoots: body.scanRoots } : {}),
          probeToken: body.probeToken,
          managedSshCredential:
            body.managedSshCredential as ManagedSshCredential,
          acceptHostKeyChange: body.acceptHostKeyChange ?? false,
          acknowledgedWarnings: body.acknowledgedWarnings,
        },
        userId,
      );
      res.status(201).json({
        server: serializeServer(result.server as unknown as Record<string, unknown>),
        ...(result.generatedPublicKey
          ? { generatedPublicKey: result.generatedPublicKey }
          : {}),
      });
    } catch (err) {
      if (err instanceof CompatibilityUnresolvedError) {
        res.status(422).json({
          error: {
            code: "compatibility_unresolved",
            message:
              "Compatibility report has unresolved fail rows or unacknowledged warnings",
            details: err.details,
          },
        });
        return;
      }
      if (err instanceof ProbeTokenExpiredError) {
        res.status(401).json({
          error: {
            code: "probe_token_expired",
            message: "Probe token expired or unknown — re-probe and retry",
          },
        });
        return;
      }
      if (err instanceof HostKeyChangedError) {
        res.status(409).json({
          error: {
            code: "host_key_changed",
            message: "Target host key changed since last connection",
          },
        });
        return;
      }
      throw err;
    }
  },
);

// POST /api/servers/:id/compatibility — re-run probes and persist outcome.
serversRouter.post(
  "/:id/compatibility",
  validateBody(z.object({}).strict()),
  async (req, res) => {
    const id = req.params.id as string;
    const [server] = await db
      .select({ id: servers.id })
      .from(servers)
      .where(eq(servers.id, id))
      .limit(1);
    if (!server) {
      res.status(404).json({
        error: { code: "NOT_FOUND", message: "Server not found" },
      });
      return;
    }

    const cloudProvider = await probeCloudProvider(id);
    const report = await probeCompatibility(id, cloudProvider);
    const setupState =
      report.overall === "pass" &&
      report.checks.find((c) => c.id === "docker.present")?.status === "pass"
        ? "ready"
        : "needs_initialisation";

    await db
      .update(servers)
      .set({ cloudProvider, setupState })
      .where(eq(servers.id, id));

    res.json({ report, cloudProvider, setupState });
  },
);

// ── Feature 011 — Initialise wizard (US2) ───────────────────────────────────

import {
  initialiseServer,
  InvalidStateError,
} from "../services/server-bootstrap.js";

const initialiseBodySchema = z
  .object({
    deployUser: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/),
    swapSize: z.string().regex(/^\d+G$/),
    ufwPorts: z.array(z.number().int().min(1).max(65535)),
    useNoPty: z.boolean(),
    typedAcknowledgement: z.literal("INITIALISE"),
  })
  .strict();

serversRouter.post(
  "/:id/initialise",
  validateBody(initialiseBodySchema),
  async (req, res) => {
    const id = req.params.id as string;
    const body = req.body as z.infer<typeof initialiseBodySchema>;
    const userId =
      (req as typeof req & { userId?: string }).userId ?? "unknown";

    const [server] = await db
      .select()
      .from(servers)
      .where(eq(servers.id, id))
      .limit(1);
    if (!server) {
      res.status(404).json({
        error: { code: "NOT_FOUND", message: "Server not found" },
      });
      return;
    }
    if (server.setupState === "initialising") {
      res.status(409).json({
        error: {
          code: "already_initialising",
          message: "Initialisation already in progress",
        },
      });
      return;
    }

    // Derive pubkey: re-use existing managed key fingerprint's pubkey.
    // If absent (initial bootstrap), require client to have called the
    // generate-key flow during onboarding.
    const pubkey = server.sshKeyFingerprint
      ? `# managed key — fingerprint ${server.sshKeyFingerprint}`
      : "# pubkey not configured";
    // Real pubkey is reconstructed from the encrypted private key by
    // server-bootstrap if needed; this stub signals "use whatever we have".

    try {
      const result = await initialiseServer(
        id,
        {
          deployUser: body.deployUser,
          swapSize: body.swapSize,
          ufwPorts: body.ufwPorts,
          useNoPty: body.useNoPty,
          pubkey,
        },
        userId,
      );
      res.status(202).json(result);
    } catch (err) {
      if (err instanceof InvalidStateError) {
        res.status(409).json({
          error: {
            code: "invalid_setup_state",
            message: err.message,
          },
        });
        return;
      }
      throw err;
    }
  },
);

// ── Feature 011 — SSH key rotation (US4) ────────────────────────────────────

import {
  rotateKey,
  DeployLockHeldError,
} from "../services/ssh-key-rotation.js";

const rotateKeyBodySchema = z
  .object({
    removeOldKeyFromTarget: z.boolean().default(true),
    typedAcknowledgement: z.literal("ROTATE"),
  })
  .strict();

serversRouter.post(
  "/:id/rotate-key",
  validateBody(rotateKeyBodySchema),
  async (req, res) => {
    const id = req.params.id as string;
    const body = req.body as z.infer<typeof rotateKeyBodySchema>;
    const userId =
      (req as typeof req & { userId?: string }).userId ?? "unknown";
    try {
      const result = await rotateKey(
        id,
        { removeOldKeyFromTarget: body.removeOldKeyFromTarget },
        userId,
      );
      if (result.ok) {
        res.json({
          ok: true,
          oldFingerprint: result.oldFingerprint,
          newFingerprint: result.newFingerprint,
          step5Warning: result.step5Warning,
        });
      } else {
        res.status(500).json({
          error: {
            code: "rotation_failed",
            message: result.message,
            details: {
              failedAtStep: result.failedAtStep,
              rolledBack: result.rolledBack,
            },
          },
        });
      }
    } catch (err) {
      if (err instanceof DeployLockHeldError) {
        res.status(409).json({
          error: {
            code: "deploy_lock_held",
            message: "Deploy in progress; retry shortly",
            details: { retryAfterMs: err.retryAfterMs },
          },
        });
        return;
      }
      throw err;
    }
  },
);
