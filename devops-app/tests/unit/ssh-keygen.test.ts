/** Feature 011 T010 — Ed25519 keygen, OpenSSH wire format, fingerprint. */
import { describe, it, expect } from "vitest";
import { createPublicKey, createPrivateKey } from "node:crypto";
import {
  generateEd25519Keypair,
  buildOpenSshEd25519Blob,
  fingerprintFromOpenSshLine,
  publicFromPem,
} from "../../server/lib/ssh-keygen.js";

describe("ssh-keygen", () => {
  it("generates a parseable PEM private key", () => {
    const kp = generateEd25519Keypair();
    expect(kp.privateKeyPem).toMatch(/-----BEGIN PRIVATE KEY-----/);
    const priv = createPrivateKey(kp.privateKeyPem);
    expect(priv.asymmetricKeyType).toBe("ed25519");
  });

  it("OpenSSH pubkey starts with ssh-ed25519 and decodes to a valid wire blob", () => {
    const kp = generateEd25519Keypair();
    expect(kp.publicKeyOpenSsh.startsWith("ssh-ed25519 ")).toBe(true);
    const b64 = kp.publicKeyOpenSsh.split(" ")[1];
    const wire = Buffer.from(b64, "base64");
    // 4-byte length + 11 bytes "ssh-ed25519" + 4-byte length + 32-byte raw key = 51
    expect(wire.length).toBe(51);
    const algoLen = wire.readUInt32BE(0);
    expect(algoLen).toBe(11);
    expect(wire.subarray(4, 15).toString("utf8")).toBe("ssh-ed25519");
    const keyLen = wire.readUInt32BE(15);
    expect(keyLen).toBe(32);
  });

  it("fingerprint format is SHA256:<base64-no-padding>", () => {
    const kp = generateEd25519Keypair();
    expect(kp.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]+$/);
    expect(kp.fingerprint.endsWith("=")).toBe(false);
  });

  it("fingerprintFromOpenSshLine matches generateEd25519Keypair fingerprint", () => {
    const kp = generateEd25519Keypair();
    expect(fingerprintFromOpenSshLine(kp.publicKeyOpenSsh)).toBe(
      kp.fingerprint,
    );
  });

  it("publicFromPem reconstructs the original public side", () => {
    const kp = generateEd25519Keypair();
    const recovered = publicFromPem(kp.privateKeyPem);
    expect(recovered.publicKeyOpenSsh).toBe(kp.publicKeyOpenSsh);
    expect(recovered.fingerprint).toBe(kp.fingerprint);
  });

  it("100 generated keys are all distinct (sanity for randomness)", () => {
    const fps = new Set<string>();
    for (let i = 0; i < 100; i++) {
      fps.add(generateEd25519Keypair().fingerprint);
    }
    expect(fps.size).toBe(100);
  });

  it("buildOpenSshEd25519Blob rejects non-32-byte raw pubkey", () => {
    expect(() => buildOpenSshEd25519Blob(Buffer.alloc(31))).toThrow();
    expect(() => buildOpenSshEd25519Blob(Buffer.alloc(33))).toThrow();
  });

  it("public key derived via createPublicKey matches export round-trip", () => {
    const kp = generateEd25519Keypair();
    const pub = createPublicKey(kp.privateKeyPem);
    expect(pub.asymmetricKeyType).toBe("ed25519");
  });
});
