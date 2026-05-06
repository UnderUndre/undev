/**
 * Feature 011 T013 — secret-aware row serialisation.
 *
 * Whitelist excludes the columns that ever carry plaintext or
 * envelope-blob secrets:
 *   - servers: ssh_private_key, ssh_password, ssh_private_key_encrypted,
 *     ssh_password_encrypted
 *   - applications: env_vars (legacy plaintext) + env_vars_encrypted
 *
 * Every API response that returns a server or application row should run
 * it through `serializeServer` / `serializeApplication` first. The new
 * `GET /api/apps/:id/env-vars` endpoint is the single sanctioned path
 * through which decrypted env-var values reach the client.
 */

export interface ServerSerialised {
  id: string;
  label: string;
  host: string;
  port: number;
  sshUser: string;
  sshAuthMethod: string;
  scriptsPath: string;
  status: string;
  lastHealthCheck: string | null;
  scanRoots: string[];
  sshKeyFingerprint: string | null;
  sshKeyRotatedAt: string | null;
  hostKeyFingerprint: string | null;
  cloudProvider: string | null;
  setupState: string;
  createdAt: string;
}

const SERVER_SECRET_KEYS = new Set([
  "sshPrivateKey",
  "sshPassword",
  "sshPrivateKeyEncrypted",
  "sshPasswordEncrypted",
  // snake_case variants for raw rows that escaped Drizzle
  "ssh_private_key",
  "ssh_password",
  "ssh_private_key_encrypted",
  "ssh_password_encrypted",
]);

const APPLICATION_SECRET_KEYS = new Set([
  "envVarsEncrypted",
  "env_vars_encrypted",
]);

function omitKeys<T extends Record<string, unknown>>(
  row: T,
  keys: ReadonlySet<string>,
): Omit<T, never> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (!keys.has(k)) out[k] = v;
  }
  return out as T;
}

export function serializeServer<T extends Record<string, unknown>>(
  row: T,
): Omit<T, "sshPrivateKey" | "sshPassword" | "sshPrivateKeyEncrypted" | "sshPasswordEncrypted"> {
  return omitKeys(row, SERVER_SECRET_KEYS) as Omit<
    T,
    | "sshPrivateKey"
    | "sshPassword"
    | "sshPrivateKeyEncrypted"
    | "sshPasswordEncrypted"
  >;
}

export function serializeApplication<T extends Record<string, unknown>>(
  row: T,
): Omit<T, "envVarsEncrypted"> {
  // env_vars (plaintext) is preserved for legacy callers; values are still
  // not the encrypted ones (those live in env_vars_encrypted, omitted).
  return omitKeys(row, APPLICATION_SECRET_KEYS) as Omit<T, "envVarsEncrypted">;
}

export function serializeServers<T extends Record<string, unknown>>(
  rows: ReadonlyArray<T>,
): Array<Omit<T, "sshPrivateKey" | "sshPassword" | "sshPrivateKeyEncrypted" | "sshPasswordEncrypted">> {
  return rows.map(serializeServer);
}

export function serializeApplications<T extends Record<string, unknown>>(
  rows: ReadonlyArray<T>,
): Array<Omit<T, "envVarsEncrypted">> {
  return rows.map(serializeApplication);
}
