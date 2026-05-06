/**
 * Feature 011 T018 — server-onboarding orchestration.
 *
 * Two operations (split per github P0 #1+#2):
 *
 *   probeServer(input)
 *     - stateless, no DB write.
 *     - establishes a one-shot SSH session with the supplied bootstrap auth.
 *     - runs cloud-init + compatibility probes.
 *     - captures host_key_fingerprint.
 *     - returns a probeToken (10-min TTL, in-memory) the operator passes
 *       back into createServer to skip the redundant probe.
 *
 *   createServer(input)
 *     - consumes probeToken (or runs the probes inline if absent).
 *     - applies bootstrapAuth (initial connect) + managedSshCredential
 *       (persisted shape) per R-004.
 *     - envelope-encrypts ssh_private_key + ssh_password.
 *     - persists host_key_fingerprint.
 *     - validates acknowledgedWarnings covers every `warn` row.
 *     - blocks on any `fail` row → 422 compatibility_unresolved.
 *     - audits server.added.
 */

import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { Client, type ClientChannel } from "ssh2";
import { db } from "../db/index.js";
import { auditEntries, servers } from "../db/schema.js";
import { logger } from "../lib/logger.js";
import { seal } from "../lib/envelope-cipher.js";
import {
  generateEd25519Keypair,
  fingerprintFromOpenSshLine,
} from "../lib/ssh-keygen.js";
import {
  parseCloudProviderProbeOutput,
  type CloudProvider,
} from "./cloud-init-probe.js";
import {
  buildReportFromFields,
  type CompatibilityReport,
} from "./compatibility-probe.js";

// ── Public types ────────────────────────────────────────────────────────────

export type BootstrapAuth =
  | { mode: "key"; privateKey: string }
  | { mode: "password"; password: string }
  | { mode: "generate-key" };

export type ManagedSshCredential =
  | { mode: "key"; privateKey: string; publicKey?: string }
  | { mode: "password"; password: string }
  // generated mode: server reuses the keypair created during probe
  // (cached.managedFromProbe). Client never sees the private key, so
  // no fields are required from the request body.
  | { mode: "generated" };

export interface ProbeInput {
  host: string;
  port: number;
  sshUser: string;
  bootstrapAuth: BootstrapAuth;
  /** When true and host key has been seen before with a different
   *  fingerprint, return `hostKeyMismatch: true` rather than 401. */
  acceptHostKeyChange?: boolean;
  /** Existing fingerprint to compare against. None = first probe. */
  expectedHostKeyFingerprint?: string | null;
}

export interface ProbeResult {
  probeToken: string;
  cloudProvider: CloudProvider;
  compatibility: CompatibilityReport;
  hostKeyFingerprint: string;
  hostKeyMismatch: boolean;
  /** Set only when bootstrapAuth.mode === "generate-key" — operator must
   *  install this on the target before the second probe will succeed. */
  generatedPublicKey?: string;
}

export interface CreateInput {
  label: string;
  host: string;
  port: number;
  sshUser: string;
  scriptsPath: string;
  scanRoots?: string[];
  probeToken: string;
  managedSshCredential: ManagedSshCredential;
  acceptHostKeyChange?: boolean;
  acknowledgedWarnings: string[];
}

export interface CreateResult {
  server: typeof servers.$inferSelect;
  /** Returned exactly once on generate-key mode; subsequent GETs do not
   *  expose this (FR-002). */
  generatedPublicKey?: string;
}

export class CompatibilityUnresolvedError extends Error {
  constructor(
    public details: { unresolvedFails: string[]; unacknowledgedWarns: string[] },
  ) {
    super("compatibility_unresolved");
    this.name = "CompatibilityUnresolvedError";
  }
}

export class HostKeyChangedError extends Error {
  constructor(
    public oldFingerprint: string | null,
    public newFingerprint: string,
  ) {
    super("host_key_changed");
    this.name = "HostKeyChangedError";
  }
}

export class ProbeTokenExpiredError extends Error {
  constructor() {
    super("probe_token_expired");
    this.name = "ProbeTokenExpiredError";
  }
}

export class SshAuthFailedError extends Error {
  constructor(
    message: string,
    public generatedPublicKey?: string,
  ) {
    super(message);
    this.name = "SshAuthFailedError";
  }
}

// ── Probe-token cache (10-min TTL, in-memory) ──────────────────────────────

interface ProbeCacheEntry {
  cloudProvider: CloudProvider;
  compatibility: CompatibilityReport;
  hostKeyFingerprint: string;
  managedFromProbe?: { privateKey: string; publicKey: string };
  // Auth used for the probe — re-used by createServer if not overridden.
  bootstrapAuth: BootstrapAuth;
  host: string;
  port: number;
  sshUser: string;
  expiresAt: number;
}

const PROBE_TTL_MS = 10 * 60 * 1000;
const probeCache = new Map<string, ProbeCacheEntry>();

function evictExpired(): void {
  const now = Date.now();
  for (const [k, v] of probeCache) if (v.expiresAt < now) probeCache.delete(k);
}

// ── One-shot SSH session for probes ─────────────────────────────────────────

interface ProbeOutput {
  cloudInit: string;
  compatibility: string;
  hostKeyHashSha256: string;
}

const CLOUD_INIT_CMD = `set +e
TIMEOUT=2
if curl -fsS -m $TIMEOUT -H 'Metadata-Flavor: Google' http://metadata.google.internal/computeMetadata/v1/instance/id >/dev/null 2>&1; then echo "PROVIDER=gcp"; fi
if curl -fsS -m $TIMEOUT http://169.254.169.254/hetzner/v1/metadata/instance-id >/dev/null 2>&1; then echo "PROVIDER=hetzner"; fi
if curl -fsS -m $TIMEOUT http://169.254.169.254/metadata/v1/id >/dev/null 2>&1; then echo "PROVIDER=do"; fi
TOKEN=$(curl -fsS -m $TIMEOUT -X PUT -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' http://169.254.169.254/latest/api/token 2>/dev/null || true)
if [ -n "$TOKEN" ]; then
  if curl -fsS -m $TIMEOUT -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/instance-id >/dev/null 2>&1; then echo "PROVIDER=aws"; fi
elif curl -fsS -m $TIMEOUT http://169.254.169.254/latest/meta-data/instance-id >/dev/null 2>&1; then
  echo "PROVIDER=aws"
fi`;

const COMPAT_CMD = `set +e
echo "SSH_OK=true"
if sudo -n true 2>/dev/null; then echo "SUDO_NOPASSWD=true"; else echo "SUDO_NOPASSWD=false"; fi
if grep -qE '^#?UsePTY[[:space:]]+yes' /etc/ssh/sshd_config 2>/dev/null; then echo "USE_PTY=true"; else echo "USE_PTY=false"; fi
if command -v docker >/dev/null 2>&1; then echo "DOCKER=$(docker --version 2>/dev/null | awk '{print $3}' | tr -d ',')"; else echo "DOCKER="; fi
DF_LINE=$(df -PBG / 2>/dev/null | awk 'NR==2 {print $4}' | tr -d 'G')
echo "DISK_FREE_GB=\${DF_LINE:-0}"
if free -m 2>/dev/null | awk '/^Swap:/ {exit ($2 > 0) ? 0 : 1}'; then echo "SWAP=true"; else echo "SWAP=false"; fi
if [ -r /etc/os-release ]; then . /etc/os-release; echo "OS_FAMILY=\${ID_LIKE:-\${ID:-unknown}}"; echo "OS_VERSION=\${VERSION_ID:-unknown}"; else echo "OS_FAMILY=unknown"; echo "OS_VERSION=unknown"; fi
echo "ARCH=$(uname -m)"`;

async function runProbeSession(
  host: string,
  port: number,
  sshUser: string,
  auth: BootstrapAuth,
  privateKeyOverride?: string,
): Promise<ProbeOutput> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    let hostKeyHashSha256 = "";
    let timer: ReturnType<typeof setTimeout> | null = null;

    function safeReject(err: Error): void {
      if (timer) clearTimeout(timer);
      try {
        client.end();
      } catch {
        /* ignore */
      }
      reject(err);
    }

    timer = setTimeout(() => {
      safeReject(new Error("ssh probe timeout (15s)"));
    }, 15_000);

    client.on("error", (err) => safeReject(err));
    client.on("ready", () => {
      const composite = `${CLOUD_INIT_CMD}\necho "---SEPARATOR---"\n${COMPAT_CMD}`;
      client.exec(composite, (err: Error | undefined, stream: ClientChannel) => {
        if (err) return safeReject(err);
        let stdout = "";
        stream.on("data", (data: Buffer) => {
          stdout += data.toString();
        });
        stream.on("close", () => {
          if (timer) clearTimeout(timer);
          client.end();
          const idx = stdout.indexOf("---SEPARATOR---");
          const cloudInit = idx === -1 ? "" : stdout.slice(0, idx);
          const compat = idx === -1 ? stdout : stdout.slice(idx + "---SEPARATOR---".length);
          resolve({
            cloudInit,
            compatibility: compat,
            hostKeyHashSha256,
          });
        });
        stream.stderr.on("data", () => {
          /* swallow — probe commands tolerate missing tools */
        });
      });
    });

    const config: Parameters<Client["connect"]>[0] = {
      host,
      port,
      username: sshUser,
      readyTimeout: 10_000,
      // Capture host key fingerprint for the MITM check.
      hostVerifier: (key: Buffer | string) => {
        const buf =
          typeof key === "string" ? Buffer.from(key, "base64") : key;
        const { createHash } = require("node:crypto") as typeof import("node:crypto");
        const digest = createHash("sha256").update(buf).digest("base64");
        hostKeyHashSha256 = `SHA256:${digest.replace(/=+$/, "")}`;
        return true; // accept; comparison happens after the session.
      },
    };

    if (privateKeyOverride !== undefined) {
      config.privateKey = privateKeyOverride;
    } else if (auth.mode === "key") {
      config.privateKey = auth.privateKey;
    } else if (auth.mode === "password") {
      config.password = auth.password;
    }
    // generate-key probes need to use the freshly-generated key — caller
    // passes it via privateKeyOverride.

    client.connect(config);
  });
}

function parseCompatFields(stdout: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || !line.includes("=")) continue;
    const eq = line.indexOf("=");
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

// ── Operations ──────────────────────────────────────────────────────────────

export async function probeServer(input: ProbeInput): Promise<ProbeResult> {
  evictExpired();

  // Generate-key mode: new key pair created BEFORE the probe so the same
  // key is used for both the probe-side connect AND persisted later.
  let generated: { privateKey: string; publicKey: string } | undefined;
  let probeAuth: BootstrapAuth = input.bootstrapAuth;
  let privateKeyOverride: string | undefined;

  if (input.bootstrapAuth.mode === "generate-key") {
    const kp = generateEd25519Keypair();
    generated = {
      privateKey: kp.privateKeyPem,
      publicKey: kp.publicKeyOpenSsh,
    };
    privateKeyOverride = kp.privateKeyPem;
    probeAuth = { mode: "key", privateKey: kp.privateKeyPem };
  }

  let session: ProbeOutput;
  try {
    session = await runProbeSession(
      input.host,
      input.port,
      input.sshUser,
      probeAuth,
      privateKeyOverride,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new SshAuthFailedError(
      message,
      generated?.publicKey,
    );
  }

  // Host-key change detection.
  const newFp = session.hostKeyHashSha256;
  const expected = input.expectedHostKeyFingerprint ?? null;
  const mismatch =
    expected !== null && expected !== "" && expected !== newFp;
  if (mismatch && !input.acceptHostKeyChange) {
    throw new HostKeyChangedError(expected, newFp);
  }

  const cloudProvider = parseCloudProviderProbeOutput(session.cloudInit);
  const compatibility = buildReportFromFields(
    parseCompatFields(session.compatibility),
    cloudProvider,
  );

  const probeToken = randomUUID();
  probeCache.set(probeToken, {
    cloudProvider,
    compatibility,
    hostKeyFingerprint: newFp,
    bootstrapAuth: input.bootstrapAuth,
    host: input.host,
    port: input.port,
    sshUser: input.sshUser,
    expiresAt: Date.now() + PROBE_TTL_MS,
    ...(generated ? { managedFromProbe: generated } : {}),
  });

  const result: ProbeResult = {
    probeToken,
    cloudProvider,
    compatibility,
    hostKeyFingerprint: newFp,
    hostKeyMismatch: mismatch,
  };
  if (generated) result.generatedPublicKey = generated.publicKey;
  return result;
}

function gateOnCompatibility(
  report: CompatibilityReport,
  acknowledged: ReadonlySet<string>,
): void {
  const fails = report.checks.filter((c) => c.status === "fail").map((c) => c.id);
  const unackedWarns = report.checks
    .filter((c) => c.status === "warn" && !acknowledged.has(c.id))
    .map((c) => c.id);
  if (fails.length > 0 || unackedWarns.length > 0) {
    throw new CompatibilityUnresolvedError({
      unresolvedFails: fails,
      unacknowledgedWarns: unackedWarns,
    });
  }
}

export async function createServer(
  input: CreateInput,
  userId: string,
): Promise<CreateResult> {
  const cached = probeCache.get(input.probeToken);
  if (!cached || cached.expiresAt < Date.now()) {
    throw new ProbeTokenExpiredError();
  }

  gateOnCompatibility(
    cached.compatibility,
    new Set(input.acknowledgedWarnings),
  );

  // Build the persisted credential per the requested managedSshCredential
  // shape. `generated` mode falls back to the probe-side keypair when the
  // caller doesn't include the private key explicitly.
  let sshAuthMethod: "key" | "password";
  let privateKeyEnc: string | null = null;
  let passwordEnc: string | null = null;
  let keyFingerprint: string | null = null;
  let generatedPublicKey: string | undefined;

  if (input.managedSshCredential.mode === "key") {
    sshAuthMethod = "key";
    const priv = input.managedSshCredential.privateKey;
    privateKeyEnc = JSON.stringify(seal(priv));
    // Public key derivation: prefer client-supplied OpenSSH line, else
    // derive from the PEM private key. This keeps key-fingerprint truthful
    // even when the client only has the private side (common case for
    // operators who paste a key blob).
    let pub = input.managedSshCredential.publicKey;
    if (!pub) {
      try {
        const { publicFromPem } = await import("../lib/ssh-keygen.js");
        pub = publicFromPem(priv).publicKeyOpenSsh;
      } catch (err) {
        logger.warn(
          { ctx: "server-onboarding", err },
          "could not derive pubkey from PEM (non-Ed25519 key?); fingerprint will be null",
        );
      }
    }
    if (pub) {
      keyFingerprint = fingerprintFromOpenSshLine(pub);
    }
  } else if (input.managedSshCredential.mode === "password") {
    sshAuthMethod = "password";
    passwordEnc = JSON.stringify(seal(input.managedSshCredential.password));
  } else {
    // generated — re-use the keypair the server created during probe.
    // Client never sees the private key (FR-002), so we MUST source it
    // from cached.managedFromProbe. Fail fast if absent.
    sshAuthMethod = "key";
    const fromProbe = cached.managedFromProbe;
    if (!fromProbe) {
      throw new Error(
        "managedSshCredential.mode='generated' requires a probeServer call with bootstrapAuth.mode='generate-key'",
      );
    }
    privateKeyEnc = JSON.stringify(seal(fromProbe.privateKey));
    keyFingerprint = fingerprintFromOpenSshLine(fromProbe.publicKey);
    generatedPublicKey = fromProbe.publicKey;
  }

  const setupState =
    cached.compatibility.overall === "pass" &&
    cached.compatibility.checks.find((c) => c.id === "docker.present")?.status === "pass"
      ? "ready"
      : "needs_initialisation";

  const id = randomUUID();
  const now = new Date().toISOString();
  const [server] = await db
    .insert(servers)
    .values({
      id,
      label: input.label,
      host: input.host,
      port: input.port,
      sshUser: input.sshUser,
      sshAuthMethod,
      sshPrivateKeyEncrypted: privateKeyEnc,
      sshPasswordEncrypted: passwordEnc,
      sshKeyFingerprint: keyFingerprint,
      hostKeyFingerprint: cached.hostKeyFingerprint,
      cloudProvider: cached.cloudProvider,
      setupState,
      scriptsPath: input.scriptsPath,
      ...(input.scanRoots ? { scanRoots: input.scanRoots } : {}),
      status: "online",
      createdAt: now,
    })
    .returning();

  await db.insert(auditEntries).values({
    id: randomUUID(),
    userId,
    action: "server.added",
    targetType: "server",
    targetId: id,
    details: JSON.stringify({
      authMethod:
        input.managedSshCredential.mode === "generated"
          ? "generated"
          : input.managedSshCredential.mode,
      keyFingerprint,
      cloudProvider: cached.cloudProvider,
    }),
    result: "success",
    timestamp: now,
  });

  probeCache.delete(input.probeToken);

  logger.info(
    {
      ctx: "server-onboarding",
      serverId: id,
      cloudProvider: cached.cloudProvider,
      setupState,
    },
    "server created",
  );

  if (!server) {
    throw new Error("server insert returned no row");
  }
  const result: CreateResult = { server };
  if (generatedPublicKey) result.generatedPublicKey = generatedPublicKey;
  return result;
}

// ── Test/inspection helper ──────────────────────────────────────────────────

export const __testHooks = {
  setProbeCacheEntry(token: string, entry: ProbeCacheEntry) {
    probeCache.set(token, entry);
  },
  clearProbeCache() {
    probeCache.clear();
  },
  buildReportFromFieldsForTest: buildReportFromFields,
};
