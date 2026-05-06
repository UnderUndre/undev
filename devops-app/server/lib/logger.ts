/**
 * Structured logger (pino).
 *
 * Usage:
 *   logger.info({ ctx: "scanner-start", serverId }, "Scan started");
 *   logger.error({ err }, "something went wrong");
 *
 * The house style from `.github/instructions/coding/copilot-instructions.md`
 * is `logger.info({ ctx }, 'msg')` — first arg = context object (serialised
 * as JSON fields), second arg = human-readable message.
 *
 * In development, a pretty-printed output is produced via pino's built-in
 * transport. In production (LOG_PRETTY unset), raw NDJSON is emitted for
 * ingestion by log aggregators.
 */

import pino from "pino";

const isProd = process.env.NODE_ENV === "production";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? (isProd ? "info" : "debug"),
  // Redact well-known secret-carrying fields at serialisation time as a
  // defence-in-depth measure against accidental leaks.
  redact: {
    paths: [
      "*.token",
      "*.sshPrivateKey",
      "*.sshPassword",
      "*.password",
      "req.headers.cookie",
      "req.headers.authorization",
      // Feature 005: secret-carrying request bodies + env exports.
      "*.params.*",
      "*.body.params.*",
      "SECRET_*",
      // Feature 011: zero-touch onboarding secret-carrying fields.
      "req.body.botToken",
      "req.body.privateKey",
      "req.body.password",
      "req.body.vars.*",
      "req.body.bootstrapAuth.password",
      "req.body.bootstrapAuth.privateKey",
      "req.body.managedSshCredential.privateKey",
      "auditEntry.payload.botToken",
      "scriptRun.params.pubkey",
      "scriptRun.params.password",
      "scriptRun.params.privateKey",
    ],
    remove: true,
  },
});
