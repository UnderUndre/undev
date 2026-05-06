import { Router } from "express";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { db } from "../db/index.js";
import { applications, auditEntries } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { validateBody } from "../middleware/validate.js";
import {
  load as loadEnvVars,
  save as saveEnvVars,
  detectPlaceholders,
} from "../services/env-vars-store.js";
import { parseEnvExample } from "../services/env-vars-migrator.js";
import { sshPool } from "../services/ssh-pool.js";
import { shQuote } from "../lib/sh-quote.js";
import { logger } from "../lib/logger.js";
import { normalisePath } from "../services/scanner-dedup.js";
import { validateScriptPath } from "../lib/validate-script-path.js";
import { validateHookFields } from "../lib/script-hook-validator.js";
import { healthUrlFieldSchema } from "../lib/health-config-schema.js";
import { validateDomain } from "../lib/domain-validator.js";
import {
  validateBlueGreenConfig,
  type ValidationError as BlueGreenValidationError,
} from "../lib/blue-green-validator.js";
import { readFile } from "node:fs/promises";

export const appsRouter = Router();

const createAppSchema = z
  .object({
    name: z.string().min(1).max(100),
    repoUrl: z.string().min(1),
    branch: z.string().min(1).default("main"),
    remotePath: z.string().min(1).transform(normalisePath), // FR-040: canonical form at write time
    envVars: z.record(z.string(), z.string()).optional().default({}),
    githubRepo: z
      .string()
      .regex(/^[^/\s]+\/[^/\s]+$/, "Must be in 'owner/repo' format")
      .nullable()
      .optional(),
    source: z.enum(["manual", "scan"]).optional().default("manual"),
    skipInitialClone: z.boolean().optional(),
    // Feature 007: optional project-local deploy script. Strict typing —
    // non-string non-null non-absent rejected by z.union before it reaches
    // validateScriptPath. Empty/whitespace normalises to null in the handler.
    scriptPath: z.union([z.string(), z.null()]).optional(),
    // Feature 006 T038: health config fragment (additive, all optional).
    healthUrl: healthUrlFieldSchema.optional(),
    monitoringEnabled: z.boolean().optional(),
    alertsMuted: z.boolean().optional(),
    healthProbeIntervalSec: z.number().int().min(10).optional(),
    healthDebounceCount: z.number().int().min(1).optional(),
    // Feature 008 T036
    domain: z.union([z.string(), z.null()]).optional(),
    acmeEmail: z.union([z.string().email(), z.null()]).optional(),
    proxyType: z.enum(["caddy", "nginx-legacy", "none"]).optional(),
    upstreamService: z.union([z.string(), z.null()]).optional(),
    upstreamPort: z.union([z.number().int().min(1).max(65535), z.null()]).optional(),
    // Feature 009 — repo-relative compose file path. Empty/null = use
    // server-deploy.sh's default search (docker-compose.yml → compose.yml).
    composePath: z.string().max(256).optional(),
    // Feature 010 — lifecycle hook paths (FR-006). Validated by
    // `validateHookFields` after Zod accepts shape.
    preDeployScriptPath: z.union([z.string(), z.null()]).optional(),
    postDeployScriptPath: z.union([z.string(), z.null()]).optional(),
    onFailScriptPath: z.union([z.string(), z.null()]).optional(),
    preDestroyScriptPath: z.union([z.string(), z.null()]).optional(),
    // Feature 012: Blue/Green Deploy fields.
    deployStrategy: z.enum(["recreate", "blue_green"]).optional(),
    drainSeconds: z.number().int().min(0).max(600).optional(),
    greenHealthcheckTimeoutSeconds: z.number().int().min(10).max(1800).optional(),
    acknowledgeVolumeSharing: z.boolean().optional(),
  })
  .strict(); // Feature 005: reject deprecated `deployScript` field.

const updateAppSchema = createAppSchema.partial();

// GET /api/servers/:serverId/apps
// Feature 006 T019: response surfaces the 8 health columns additively. Drizzle
// `select()` projects every column on `applications`, including healthUrl /
// healthStatus / healthCheckedAt / healthLastChangeAt / healthMessage /
// healthProbeIntervalSec / healthDebounceCount / monitoringEnabled /
// alertsMuted. No explicit field list needed — backward-compatible additive.
appsRouter.get("/servers/:serverId/apps", async (req, res) => {
  const serverId = req.params.serverId as string;
  const result = await db
    .select()
    .from(applications)
    .where(eq(applications.serverId, serverId));

  res.json(result);
});

// POST /api/servers/:serverId/apps
appsRouter.post(
  "/servers/:serverId/apps",
  validateBody(createAppSchema),
  async (req, res) => {
    const id = randomUUID();
    const now = new Date().toISOString();

    const serverId = req.params.serverId as string;

    // FR-051/052: clients cannot forge the skipInitialClone flag. It is set
    // true iff source === "scan" (backend is the sole writer).
    const body = req.body as z.infer<typeof createAppSchema>;
    const skipInitialClone = body.source === "scan";

    // Feature 007: normalise + validate scriptPath at the route boundary.
    const sp = validateScriptPath(body.scriptPath);
    if (!sp.ok) {
      res.status(400).json({
        error: {
          code: "INVALID_PARAMS",
          message: "Invalid scriptPath",
          details: { fieldErrors: { scriptPath: [sp.error] } },
        },
      });
      return;
    }

    // Feature 008 T036 — domain validator at route boundary
    const dv = validateDomain(body.domain ?? null);
    if (!dv.ok) {
      const code = dv.error.toLowerCase().includes("wildcard")
        ? "WILDCARD_NOT_SUPPORTED"
        : "INVALID_DOMAIN";
      res.status(400).json({
        error: { code, message: dv.error, details: { fieldErrors: { domain: [dv.error] } } },
      });
      return;
    }

    const [app] = await db
      .insert(applications)
      .values({
        id,
        serverId,
        name: body.name,
        repoUrl: body.repoUrl,
        branch: body.branch,
        remotePath: body.remotePath,
        envVars: body.envVars,
        githubRepo: body.githubRepo ?? null,
        scriptPath: sp.value,
        skipInitialClone,
        domain: dv.value,
        acmeEmail: body.acmeEmail ?? null,
        proxyType: body.proxyType ?? "caddy",
        upstreamService: body.upstreamService ?? null,
        upstreamPort: body.upstreamPort ?? null,
        createdAt: now,
      })
      .returning();

    res.status(201).json(app);
  },
);

// GET /api/apps/:id
// Feature 006 T019: response surfaces the 8 health columns additively (see
// note on the GET /servers/:serverId/apps handler above).
appsRouter.get("/apps/:id", async (req, res) => {
  const id = req.params.id as string;
  const [app] = await db
    .select()
    .from(applications)
    .where(eq(applications.id, id))
    .limit(1);

  if (!app) {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "Application not found" } });
    return;
  }
  res.json(app);
});

// PUT /api/apps/:id
appsRouter.put("/apps/:id", validateBody(updateAppSchema), async (req, res) => {
  const id = req.params.id as string;
  const body = req.body as z.infer<typeof updateAppSchema>;

  // Feature 007: normalise scriptPath. Three states:
  //   absent (key missing)  → leave row column untouched
  //   explicit null          → clear (set to null)
  //   string                 → trim + validate; "" or whitespace → null
  const updates = { ...body };
  if ("scriptPath" in body) {
    const sp = validateScriptPath(body.scriptPath);
    if (!sp.ok) {
      res.status(400).json({
        error: {
          code: "INVALID_PARAMS",
          message: "Invalid scriptPath",
          details: { fieldErrors: { scriptPath: [sp.error] } },
        },
      });
      return;
    }
    updates.scriptPath = sp.value;
  }
  if ("domain" in body) {
    const dv = validateDomain(body.domain ?? null);
    if (!dv.ok) {
      const code = dv.error.toLowerCase().includes("wildcard")
        ? "WILDCARD_NOT_SUPPORTED"
        : "INVALID_DOMAIN";
      res.status(400).json({
        error: { code, message: dv.error, details: { fieldErrors: { domain: [dv.error] } } },
      });
      return;
    }
    updates.domain = dv.value;
  }

  // Feature 010 T017 — validate hook fields + enforce mutual exclusion.
  const hookKeys = [
    "preDeployScriptPath",
    "postDeployScriptPath",
    "onFailScriptPath",
    "preDestroyScriptPath",
  ] as const;
  const hookTouched = hookKeys.some((k) => k in body);
  const scriptPathTouched = "scriptPath" in body;
  if (hookTouched || scriptPathTouched) {
    const [current] = await db
      .select()
      .from(applications)
      .where(eq(applications.id, id))
      .limit(1);
    if (!current) {
      res.status(404).json({ error: { code: "NOT_FOUND", message: "Application not found" } });
      return;
    }
    const merged = {
      scriptPath: scriptPathTouched ? updates.scriptPath ?? null : current.scriptPath,
      preDeployScriptPath: "preDeployScriptPath" in body ? body.preDeployScriptPath ?? null : current.preDeployScriptPath,
      postDeployScriptPath: "postDeployScriptPath" in body ? body.postDeployScriptPath ?? null : current.postDeployScriptPath,
      onFailScriptPath: "onFailScriptPath" in body ? body.onFailScriptPath ?? null : current.onFailScriptPath,
      preDestroyScriptPath: "preDestroyScriptPath" in body ? body.preDestroyScriptPath ?? null : current.preDestroyScriptPath,
    };
    const verdict = validateHookFields(merged);
    if (!verdict.ok) {
      res.status(400).json({
        error: {
          code: verdict.error.code,
          message:
            verdict.error.code === "script_path_hooks_mutually_exclusive"
              ? "Pick either script_path OR lifecycle hooks, not both."
              : `Invalid hook path on ${verdict.error.field}: ${verdict.error.reason}`,
          details:
            verdict.error.code === "script_path_hooks_mutually_exclusive"
              ? { setHooks: verdict.error.setHooks, setScriptPath: merged.scriptPath }
              : { field: verdict.error.field, reason: verdict.error.reason },
        },
      });
      return;
    }
    // Apply normalised hook values into updates.
    for (const k of hookKeys) {
      if (k in body) updates[k] = verdict.value[k];
    }
  }

  // Feature 012 T017 — blue/green deploy validation.
  const bgFieldsTouched =
    "deployStrategy" in body ||
    "drainSeconds" in body ||
    "greenHealthcheckTimeoutSeconds" in body ||
    "acknowledgeVolumeSharing" in body;

  if (bgFieldsTouched) {
    const [current] = await db
      .select()
      .from(applications)
      .where(eq(applications.id, id))
      .limit(1);
    if (!current) {
      res.status(404).json({ error: { code: "NOT_FOUND", message: "Application not found" } });
      return;
    }
    const effectiveStrategy = body.deployStrategy ?? current.deployStrategy;
    if (effectiveStrategy === "blue_green") {
      const composeYaml = await readComposeYaml(current.remotePath, current.composePath).catch(
        () => "",
      );
      const verdict = validateBlueGreenConfig({
        proxyType: current.proxyType,
        upstreamService: current.upstreamService,
        composeYaml,
        acknowledgeVolumeSharing: body.acknowledgeVolumeSharing,
      });
      if (!verdict.ok) {
        res.status(400).json(buildBlueGreenErrorResponse(verdict.error));
        return;
      }
    }
    // FR-028: switching back to recreate clears active_color.
    if (body.deployStrategy === "recreate" && current.deployStrategy === "blue_green") {
      (updates as Record<string, unknown>).activeColor = null;
    }
  }

  const [app] = await db
    .update(applications)
    .set(updates)
    .where(eq(applications.id, id))
    .returning();

  if (!app) {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "Application not found" } });
    return;
  }
  res.json(app);
});

// Feature 012 — best-effort compose-yaml read for validator.
// NOTE: PATCH-time read is best-effort; failures degrade to empty-string,
// which the validator treats as "no_healthcheck". This is acceptable
// because deploy-time validation in the orchestrator is the authoritative
// gate. See contracts/api.md § Validator pipeline.
async function readComposeYaml(remotePath: string, composePath: string): Promise<string> {
  // PATCH route does not have SSH context to remote-read the compose file.
  // For now, read from a local mirror if present; otherwise return empty
  // string. Deploy-time orchestrator does the authoritative remote read.
  const localPath = `${remotePath}/${composePath}`;
  try {
    return await readFile(localPath, "utf8");
  } catch {
    return "";
  }
}

function buildBlueGreenErrorResponse(err: BlueGreenValidationError): unknown {
  switch (err.code) {
    case "blue_green_requires_caddy":
      return { error: { code: "blue_green_requires_caddy", message: err.message } };
    case "blue_green_replicas_not_supported_v1":
      return {
        error: {
          code: "blue_green_replicas_not_supported_v1",
          message: err.message,
          details: { detectedReplicas: err.detectedReplicas },
        },
      };
    case "blue_green_incompatible_compose":
      return {
        error: {
          code: "blue_green_incompatible_compose",
          message: err.message,
          details: { reason: err.reason, detail: err.detail },
        },
      };
    case "volume_sharing_unacknowledged":
      return {
        error: {
          code: "volume_sharing_unacknowledged",
          message: err.message,
          details: { detectedVolumes: err.detectedVolumes },
        },
      };
  }
}

// DELETE /api/apps/:id  (Feature 008 T055)
//
// Default path: DELETE the app row. `app_certs` + `app_cert_events` cascade.
//   v1 limitation: spec asks for soft-retain (30d grace), but cascade defeats
//   that. Re-enable when `applications.deleted_at` (or `ON DELETE SET NULL`)
//   ships. Documented below at the soft-path branch.
//
// Hard path (?hard=true, FR-018a — best-effort Caddy + authoritative DB):
//   1-3 (best-effort) — revoke each cert via Caddy, remove site, rm files;
//                       failures audited as `hard_delete_partial` events.
//   4-5 (authoritative) — DELETE app_certs rows, DELETE app row.
appsRouter.delete("/apps/:id", async (req, res) => {
  const id = req.params.id as string;
  const hard = req.query.hard === "true";
  const force = req.query.force === "true";
  const userId = (req as { userId?: string }).userId ?? "system";
  const confirmName =
    typeof req.headers["x-confirm-name"] === "string" ? req.headers["x-confirm-name"] : null;

  const [app] = await (await import("../db/schema.js")).applications
    ? await db.select().from(applications).where(eq(applications.id, id)).limit(1)
    : [];
  if (!app) {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "Application not found" } });
    return;
  }

  if (hard) {
    // Feature 010 T018 — wrap inline delete with pre_destroy hook decorator.
    if (app.preDestroyScriptPath || force) {
      try {
        const { hardDeleteWithHooks } = await import(
          "../services/hard-delete-with-hooks.js"
        );
        // Run the hook gate; the actual destruction continues below in the
        // existing inline block. We pass a no-op delegate that resolves —
        // the inline code path persists DB delete via the lines following.
        await hardDeleteWithHooks(
          id,
          userId,
          async () => ({ removed: { remotePath: app.remotePath } }),
          { force },
        );
      } catch (err) {
        if (err instanceof Error && err.name === "PreDestroyHookFailed") {
          const e = err as Error & { hookPath: string; exitCode: number; sshStderr: string };
          res.status(422).json({
            error: {
              code: "pre_destroy_hook_failed",
              message: e.message,
              details: {
                hookPath: e.hookPath,
                exitCode: e.exitCode,
                sshStderr: e.sshStderr,
              },
            },
          });
          return;
        }
        if (err instanceof Error && err.name === "HardDeleteAppNotFound") {
          res.status(404).json({
            error: { code: "NOT_FOUND", message: "Application not found" },
          });
          return;
        }
        throw err;
      }
    }
    if (confirmName !== app.name) {
      res.status(400).json({
        error: {
          code: "HARD_DELETE_NAME_MISMATCH",
          message: "Application name does not match confirmation",
          details: { expected: app.name, got: confirmName },
        },
      });
      return;
    }

    const { appCerts: appCertsTable, appCertEvents: appCertEventsTable } = await import(
      "../db/schema.js"
    );
    const { caddyAdminClient: cac, CaddyAdminError: CAE } = await import(
      "../services/caddy-admin-client.js"
    );
    const { reconcile: rec } = await import("../services/caddy-reconciler.js");
    const { sshPool: sp } = await import("../services/ssh-pool.js");
    const { shQuote } = await import("../lib/sh-quote.js");
    const { logger } = await import("../lib/logger.js");
    const { randomUUID } = await import("node:crypto");

    const certs = await db.select().from(appCertsTable).where(eq(appCertsTable.appId, id));

    // Step 1 — revoke each cert (best-effort)
    for (const c of certs) {
      try {
        await cac.revokeCert(app.serverId, c.domain);
      } catch (err) {
        if (err instanceof CAE) {
          logger.warn(
            { ctx: "hard-delete", err, certId: c.id, step: "revoke" },
            "caddy cleanup failed during hard delete",
          );
          await db.insert(appCertEventsTable).values({
            id: randomUUID(),
            certId: c.id,
            eventType: "hard_delete_partial",
            eventData: { failed_step: "revoke", error_message: err.message },
            actor: "system",
            occurredAt: new Date().toISOString(),
          });
        } else {
          throw err;
        }
      }
    }

    // Step 2 — Caddy site removal via reconcile (after we delete the app rows below).
    // Step 3 — rm cert files (best-effort).
    for (const c of certs) {
      try {
        await sp.exec(
          app.serverId,
          `rm -rf /var/lib/caddy/.local/share/caddy/certificates/*/${shQuote(c.domain)} 2>/dev/null || true`,
          15_000,
        );
      } catch (err) {
        logger.warn(
          { ctx: "hard-delete", err, certId: c.id, step: "rm" },
          "caddy cleanup failed during hard delete",
        );
        await db.insert(appCertEventsTable).values({
          id: randomUUID(),
          certId: c.id,
          eventType: "hard_delete_partial",
          eventData: { failed_step: "rm", error_message: (err as Error).message },
          actor: "system",
          occurredAt: new Date().toISOString(),
        });
      }
    }

    // Steps 4-5 — authoritative DB cleanup. CASCADE removes app_certs + app_cert_events.
    await db.delete(applications).where(eq(applications.id, id));

    // Post-delete reconcile to trim the Caddy site (step 2).
    void rec(app.serverId).catch((err) => {
      logger.warn({ ctx: "hard-delete-reconcile", err }, "post-delete reconcile failed");
    });

    res.status(204).end();
    return;
  }

  // Soft path — DELETE the app row. `app_certs` and `app_cert_events` cascade.
  //
  // v1 limitation (per gemini-code-assist review): the spec calls for marking
  // certs `orphaned (app_soft_delete)` with a 30-day grace window, but the
  // current schema has `ON DELETE CASCADE` on app_certs.app_id, so any UPDATE
  // we make here is undone immediately by the DELETE below. Until a
  // `applications.deleted_at` column ships (or the FK becomes
  // `ON DELETE SET NULL`), the orphan-marking has no lasting effect — so we
  // omit it rather than mislead future readers.
  const [deleted] = await db
    .delete(applications)
    .where(eq(applications.id, id))
    .returning({ id: applications.id });
  if (!deleted) {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "Application not found" } });
    return;
  }
  res.status(204).end();
});

// ── Feature 011 T037 / T038 — env-vars editor + .env.example import ─────────

/**
 * GET /api/apps/:id/env-vars
 *
 * Returns the decrypted env-var map for the editor UI. The values are
 * surfaced ONLY through this dedicated endpoint (not via GET /api/apps/:id),
 * so the values do not appear in the generic app-detail response that
 * other parts of the UI cache.
 */
appsRouter.get("/apps/:id/env-vars", async (req, res) => {
  const id = req.params.id as string;
  const [app] = await db
    .select({ id: applications.id })
    .from(applications)
    .where(eq(applications.id, id))
    .limit(1);
  if (!app) {
    res.status(404).json({
      error: { code: "NOT_FOUND", message: "Application not found" },
    });
    return;
  }
  const vars = await loadEnvVars(id);
  res.json({ vars });
});

/**
 * PATCH /api/apps/:id/env-vars
 *
 * Full-set replacement: `vars` is the COMPLETE post-edit state, NOT a
 * delta. Server replaces env_vars_encrypted wholesale; absent keys are
 * removed. This makes concurrent PATCH from two operators safe
 * (last-write-wins on a complete state, no partial-overwrite race).
 */
const patchEnvVarsSchema = z
  .object({
    vars: z.record(
      z.string().regex(/^[A-Z_][A-Z0-9_]*$/, "POSIX env-name only"),
      z.string(),
    ),
    acknowledgePlaceholders: z.boolean().optional().default(false),
  })
  .strict();

appsRouter.patch(
  "/apps/:id/env-vars",
  validateBody(patchEnvVarsSchema),
  async (req, res) => {
    const id = req.params.id as string;
    const body = req.body as z.infer<typeof patchEnvVarsSchema>;
    const userId =
      (req as typeof req & { userId?: string }).userId ?? "unknown";

    const [app] = await db
      .select({ id: applications.id })
      .from(applications)
      .where(eq(applications.id, id))
      .limit(1);
    if (!app) {
      res.status(404).json({
        error: { code: "NOT_FOUND", message: "Application not found" },
      });
      return;
    }

    if (!body.acknowledgePlaceholders) {
      const changeMeKeys = detectPlaceholders(body.vars);
      if (changeMeKeys.length > 0) {
        res.status(400).json({
          error: {
            code: "placeholder_values_detected",
            message:
              "One or more values look like placeholders (CHANGE_ME...). Set `acknowledgePlaceholders: true` to save anyway.",
            details: { changeMeKeys },
          },
        });
        return;
      }
    }

    const diff = await saveEnvVars(id, body.vars, userId);
    res.json({ ok: true, ...diff });
  },
);

/**
 * POST /api/apps/:id/env-vars/import
 *
 * Reads `.env.example` over SSH from the application's remotePath,
 * parses it, and merges new keys into the existing env-var set
 * (existing keys are preserved per OQ-002).
 */
appsRouter.post("/apps/:id/env-vars/import", async (req, res) => {
  const id = req.params.id as string;
  const userId =
    (req as typeof req & { userId?: string }).userId ?? "unknown";

  const [app] = await db
    .select({
      id: applications.id,
      serverId: applications.serverId,
      remotePath: applications.remotePath,
    })
    .from(applications)
    .where(eq(applications.id, id))
    .limit(1);
  if (!app) {
    res.status(404).json({
      error: { code: "NOT_FOUND", message: "Application not found" },
    });
    return;
  }

  const exPath = `${app.remotePath.replace(/\/$/, "")}/.env.example`;
  let result;
  try {
    result = await sshPool.exec(
      app.serverId,
      `cat ${shQuote(exPath)}`,
      30_000,
    );
  } catch (err) {
    logger.warn({ ctx: "env-vars-import", appId: id, err }, "ssh exec failed");
    res.status(502).json({
      error: { code: "ssh_exec_failed", message: "Failed to read .env.example" },
    });
    return;
  }

  if (result.exitCode !== 0) {
    res.status(404).json({
      error: {
        code: "env_example_not_found",
        message: `.env.example not found at ${exPath}`,
      },
    });
    return;
  }

  const parsed = parseEnvExample(result.stdout);
  const existing = await loadEnvVars(id);
  const merged: Record<string, string> = { ...existing };
  const newKeys: string[] = [];
  for (const [k, v] of Object.entries(parsed)) {
    if (!(k in existing)) {
      merged[k] = v;
      newKeys.push(k);
    }
  }

  await saveEnvVars(id, merged, userId);

  // Additional audit row for the import-from-example event.
  await db.insert(auditEntries).values({
    id: randomUUID(),
    userId,
    action: "app.env_vars_imported_from_example",
    targetType: "application",
    targetId: id,
    details: JSON.stringify({
      importedKeys: newKeys,
      changeMeKeys: detectPlaceholders(merged),
    }),
    result: "success",
    timestamp: new Date().toISOString(),
  });

  res.json({
    ok: true,
    importedKeys: newKeys,
    skippedExistingKeys: Object.keys(parsed).filter((k) => k in existing),
  });
});
