/**
 * Feature 011 T007 — AES-256-GCM envelope encryption.
 *
 * Master key is sourced from `DASHBOARD_MASTER_KEY` env var (base64-encoded
 * 32 raw bytes). The key MUST be present and well-formed at module-load
 * time; failure here is fatal — the dashboard cannot operate without it.
 *
 * Per-row IV is 12 random bytes (GCM standard). Auth tag is 16 bytes.
 * `seal()` returns `{ ct, iv, tag }` as base64 strings; `open()` rejects
 * any blob whose tag does not authenticate (tampering / wrong key).
 *
 * R-003 — see specs/011-zero-touch-onboarding/research.md.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export interface EnvelopeBlob {
  ct: string; // ciphertext, base64
  iv: string; // 12-byte IV, base64
  tag: string; // 16-byte GCM auth tag, base64
}

const KEY_LEN = 32;
const IV_LEN = 12;
const TAG_LEN = 16;
const ALGO = "aes-256-gcm" as const;

function loadMasterKey(): Buffer {
  const raw = process.env.DASHBOARD_MASTER_KEY;
  if (!raw) {
    throw new Error(
      "DASHBOARD_MASTER_KEY required (base64-encoded 32 random bytes; generate with `openssl rand -base64 32`)",
    );
  }
  let buf: Buffer;
  try {
    buf = Buffer.from(raw, "base64");
  } catch {
    throw new Error("DASHBOARD_MASTER_KEY: not valid base64");
  }
  if (buf.length !== KEY_LEN) {
    throw new Error(
      `DASHBOARD_MASTER_KEY: decoded length ${buf.length} bytes, expected ${KEY_LEN}`,
    );
  }
  return buf;
}

// Fail-fast at module load. Tests stub `process.env` BEFORE importing.
const MASTER_KEY = loadMasterKey();

export function seal(plaintext: string): EnvelopeBlob {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, MASTER_KEY, iv);
  const ct = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return {
    ct: ct.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
  };
}

export function open(blob: EnvelopeBlob): string {
  const iv = Buffer.from(blob.iv, "base64");
  const tag = Buffer.from(blob.tag, "base64");
  const ct = Buffer.from(blob.ct, "base64");
  if (iv.length !== IV_LEN) {
    throw new Error("envelope: iv length mismatch");
  }
  if (tag.length !== TAG_LEN) {
    throw new Error("envelope: tag length mismatch");
  }
  const decipher = createDecipheriv(ALGO, MASTER_KEY, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString("utf8");
}
