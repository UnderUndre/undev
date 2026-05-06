/** Feature 011 T008 — envelope cipher round-trip + tamper detection. */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { randomBytes } from "node:crypto";

const VALID_KEY = randomBytes(32).toString("base64");

beforeEach(() => {
  vi.resetModules();
});

async function loadCipher(key: string | undefined) {
  if (key === undefined) {
    vi.stubEnv("DASHBOARD_MASTER_KEY", "");
  } else {
    vi.stubEnv("DASHBOARD_MASTER_KEY", key);
  }
  return await import("../../server/lib/envelope-cipher.js");
}

describe("envelope-cipher", () => {
  it("seal/open round-trips identity", async () => {
    const { seal, open } = await loadCipher(VALID_KEY);
    const pt = "hunter2-secret-jwt";
    const blob = seal(pt);
    expect(blob.ct).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(blob.iv).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(blob.tag).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(open(blob)).toBe(pt);
  });

  it("produces unique IVs across 1000 seals (no collisions)", async () => {
    const { seal } = await loadCipher(VALID_KEY);
    const ivs = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      ivs.add(seal("x").iv);
    }
    expect(ivs.size).toBe(1000);
  });

  it("rejects tampered ciphertext (GCM auth-tag check)", async () => {
    const { seal, open } = await loadCipher(VALID_KEY);
    const blob = seal("payload");
    const ctBuf = Buffer.from(blob.ct, "base64");
    ctBuf[0] ^= 0x01;
    const tampered = { ...blob, ct: ctBuf.toString("base64") };
    expect(() => open(tampered)).toThrow();
  });

  it("rejects blob sealed under a different master key", async () => {
    const { seal } = await loadCipher(VALID_KEY);
    const blob = seal("payload");
    vi.resetModules();
    const { open: openOther } = await loadCipher(
      randomBytes(32).toString("base64"),
    );
    expect(() => openOther(blob)).toThrow();
  });

  it("fails fast at module load when DASHBOARD_MASTER_KEY missing", async () => {
    await expect(loadCipher(undefined)).rejects.toThrow(
      /DASHBOARD_MASTER_KEY required/,
    );
  });

  it("fails fast on wrong-length key", async () => {
    await expect(
      loadCipher(Buffer.alloc(16).toString("base64")),
    ).rejects.toThrow(/length/);
  });

  it("master-key canary semantics: seal under K1, open under K2 throws", async () => {
    const k1 = randomBytes(32).toString("base64");
    const k2 = randomBytes(32).toString("base64");
    const { seal } = await loadCipher(k1);
    const canary = seal("ok");
    vi.resetModules();
    const { open: openK2 } = await loadCipher(k2);
    expect(() => openK2(canary)).toThrow();
  });
});
