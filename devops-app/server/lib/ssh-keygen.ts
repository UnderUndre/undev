/**
 * Feature 011 T009 — Ed25519 keypair generation in pure Node (no shellout).
 *
 * R-001/R-002:
 *   - Private key: PEM (PKCS#8). `ssh2` accepts this directly via the
 *     `privateKey` option of `Client.connect`.
 *   - Public key: OpenSSH single-line format `ssh-ed25519 <base64-blob>`,
 *     hand-built per RFC 4253 length-prefixed wire format. Suitable for
 *     `authorized_keys`.
 *   - Fingerprint: `SHA256:<base64-no-padding>` over the binary OpenSSH
 *     wire blob — matches `ssh-keygen -lf <pubfile>` output.
 */

import {
  createHash,
  generateKeyPairSync,
  createPublicKey,
} from "node:crypto";

export interface Ed25519Keypair {
  privateKeyPem: string;
  publicKeyOpenSsh: string;
  fingerprint: string;
}

const KEY_TYPE = "ssh-ed25519";

function lengthPrefixed(buf: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(buf.length, 0);
  return Buffer.concat([len, buf]);
}

/**
 * Build the OpenSSH wire blob for an ed25519 public key.
 * Format: string "ssh-ed25519" || string <32-byte-pubkey>
 */
export function buildOpenSshEd25519Blob(rawPubkey: Buffer): Buffer {
  if (rawPubkey.length !== 32) {
    throw new Error(
      `ed25519 raw pubkey must be 32 bytes, got ${rawPubkey.length}`,
    );
  }
  return Buffer.concat([
    lengthPrefixed(Buffer.from(KEY_TYPE, "utf8")),
    lengthPrefixed(rawPubkey),
  ]);
}

/**
 * Extract the 32-byte raw ed25519 public key from a SubjectPublicKeyInfo
 * DER blob. The DER structure is fixed-width for ed25519:
 *   30 2a                       SEQUENCE (42 bytes)
 *     30 05                     SEQUENCE (5)
 *       06 03 2b 65 70          OID 1.3.101.112 (Ed25519)
 *     03 21 00 <32 bytes>       BIT STRING (33), unused-bits=0, raw key
 * Total: 44 bytes; raw key occupies bytes 12..43.
 */
export function rawPubkeyFromSpkiDer(der: Buffer): Buffer {
  if (der.length !== 44) {
    throw new Error(`unexpected ed25519 SPKI DER length: ${der.length}`);
  }
  return der.subarray(12, 44);
}

export function computeFingerprint(opensshWire: Buffer): string {
  const digest = createHash("sha256").update(opensshWire).digest();
  // Trim trailing '=' padding, per OpenSSH convention.
  const b64 = digest.toString("base64").replace(/=+$/, "");
  return `SHA256:${b64}`;
}

export function generateEd25519Keypair(): Ed25519Keypair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const privateKeyPem = privateKey
    .export({ type: "pkcs8", format: "pem" })
    .toString();
  const spkiDer = publicKey.export({ type: "spki", format: "der" });
  const rawPub = rawPubkeyFromSpkiDer(spkiDer);
  const wire = buildOpenSshEd25519Blob(rawPub);
  const publicKeyOpenSsh = `${KEY_TYPE} ${wire.toString("base64")}`;
  const fingerprint = computeFingerprint(wire);
  return { privateKeyPem, publicKeyOpenSsh, fingerprint };
}

/**
 * Compute the SHA256 fingerprint of an externally-supplied OpenSSH public
 * key string (`ssh-ed25519 <base64>` or any other algo). Used at probe
 * time to record host_key_fingerprint without re-deriving from the key
 * object.
 */
export function fingerprintFromOpenSshLine(line: string): string {
  const parts = line.trim().split(/\s+/);
  if (parts.length < 2 || !parts[1]) {
    throw new Error("openssh pubkey line missing base64 blob");
  }
  const wire = Buffer.from(parts[1], "base64");
  return computeFingerprint(wire);
}

/**
 * Re-derive the OpenSSH public key + fingerprint from a stored PEM
 * private key. Used by the rotation flow when only the private side is
 * persisted.
 */
export function publicFromPem(pem: string): {
  publicKeyOpenSsh: string;
  fingerprint: string;
} {
  const pub = createPublicKey(pem);
  const der = pub.export({ type: "spki", format: "der" });
  const raw = rawPubkeyFromSpkiDer(der);
  const wire = buildOpenSshEd25519Blob(raw);
  return {
    publicKeyOpenSsh: `${KEY_TYPE} ${wire.toString("base64")}`,
    fingerprint: computeFingerprint(wire),
  };
}
