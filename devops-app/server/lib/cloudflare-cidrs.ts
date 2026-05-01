/**
 * Feature 008 T017 — Cloudflare CIDR fetcher with hardcoded fallback (R-003).
 *
 * Boot-time fetch from cloudflare.com; falls back to an in-source snapshot
 * if the network is unreachable. Cached in memory; no disk persistence.
 */

import { logger } from "./logger.js";

// Snapshot from https://www.cloudflare.com/ips-v{4,6}/ as of 2026-04-28.
// Refreshed manually per release.
const HARDCODED_FALLBACK_V4: readonly string[] = [
  "173.245.48.0/20",
  "103.21.244.0/22",
  "103.22.200.0/22",
  "103.31.4.0/22",
  "141.101.64.0/18",
  "108.162.192.0/18",
  "190.93.240.0/20",
  "188.114.96.0/20",
  "197.234.240.0/22",
  "198.41.128.0/17",
  "162.158.0.0/15",
  "104.16.0.0/13",
  "104.24.0.0/14",
  "172.64.0.0/13",
  "131.0.72.0/22",
];

const HARDCODED_FALLBACK_V6: readonly string[] = [
  "2400:cb00::/32",
  "2606:4700::/32",
  "2803:f800::/32",
  "2405:b500::/32",
  "2405:8100::/32",
  "2a06:98c0::/29",
  "2c0f:f248::/32",
];

interface Cached {
  v4: string[];
  v6: string[];
  fetchedAt: number;
}

let cache: Cached | null = null;
let inflight: Promise<Cached> | null = null;

async function fetchOnce(): Promise<Cached> {
  try {
    const [v4Resp, v6Resp] = await Promise.all([
      fetch("https://www.cloudflare.com/ips-v4/"),
      fetch("https://www.cloudflare.com/ips-v6/"),
    ]);
    if (!v4Resp.ok || !v6Resp.ok) {
      throw new Error(`HTTP ${v4Resp.status}/${v6Resp.status}`);
    }
    const [v4Text, v6Text] = await Promise.all([v4Resp.text(), v6Resp.text()]);
    const v4 = v4Text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => /^\d/.test(l));
    const v6 = v6Text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => /^[0-9a-f:]/i.test(l));
    if (v4.length === 0 || v6.length === 0) {
      throw new Error("empty CIDR list");
    }
    logger.info(
      { ctx: "cloudflare-cidrs", v4: v4.length, v6: v6.length },
      "fetched fresh CIDR ranges",
    );
    return { v4, v6, fetchedAt: Date.now() };
  } catch (err) {
    logger.warn({ ctx: "cloudflare-cidrs", err }, "fallback to hardcoded snapshot");
    return {
      v4: [...HARDCODED_FALLBACK_V4],
      v6: [...HARDCODED_FALLBACK_V6],
      fetchedAt: Date.now(),
    };
  }
}

export async function getCloudflareCidrs(): Promise<{ v4: string[]; v6: string[] }> {
  if (cache !== null) return { v4: cache.v4, v6: cache.v6 };
  if (inflight !== null) {
    const c = await inflight;
    return { v4: c.v4, v6: c.v6 };
  }
  inflight = fetchOnce();
  cache = await inflight;
  inflight = null;
  return { v4: cache.v4, v6: cache.v6 };
}

/** Synchronous lookup — caller must have awaited `getCloudflareCidrs()` first. */
export function isCloudflareIp(ip: string): boolean {
  if (cache === null) return false;
  const ranges = ip.includes(":") ? cache.v6 : cache.v4;
  for (const cidr of ranges) {
    if (ipInCidr(ip, cidr)) return true;
  }
  return false;
}

/** Test-only — reset module-level cache between cases. */
export function __resetForTests(): void {
  cache = null;
  inflight = null;
}

/** Test-only — preload cache without network. */
export function __seedCacheForTests(v4: string[], v6: string[]): void {
  cache = { v4, v6, fetchedAt: Date.now() };
}

// ── CIDR matching ──────────────────────────────────────────────────────────
function ipInCidr(ip: string, cidr: string): boolean {
  const slash = cidr.indexOf("/");
  if (slash < 0) return false;
  const network = cidr.slice(0, slash);
  const prefix = Number(cidr.slice(slash + 1));
  if (!Number.isFinite(prefix)) return false;

  if (ip.includes(":") || network.includes(":")) {
    if (!ip.includes(":") || !network.includes(":")) return false;
    return v6InCidr(ip, network, prefix);
  }
  return v4InCidr(ip, network, prefix);
}

function v4InCidr(ip: string, network: string, prefix: number): boolean {
  const ipNum = v4ToInt(ip);
  const netNum = v4ToInt(network);
  if (ipNum === null || netNum === null) return false;
  if (prefix === 0) return true;
  const mask = prefix === 32 ? 0xffffffff : (~0 << (32 - prefix)) >>> 0;
  return (ipNum & mask) === (netNum & mask);
}

function v4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    const v = Number(part);
    if (!Number.isInteger(v) || v < 0 || v > 255) return null;
    n = (n << 8) | v;
  }
  return n >>> 0;
}

function v6InCidr(ip: string, network: string, prefix: number): boolean {
  const a = v6ToBytes(ip);
  const b = v6ToBytes(network);
  if (a === null || b === null) return false;
  if (a.length !== 16 || b.length !== 16) return false;
  let bitsLeft = prefix;
  for (let i = 0; i < 16 && bitsLeft > 0; i++) {
    const take = Math.min(8, bitsLeft);
    const mask = take === 8 ? 0xff : (0xff << (8 - take)) & 0xff;
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    if ((ai & mask) !== (bi & mask)) return false;
    bitsLeft -= take;
  }
  return true;
}

function v6ToBytes(ip: string): number[] | null {
  // Expand `::` shorthand.
  let head: string[] = [];
  let tail: string[] = [];
  if (ip.includes("::")) {
    const [h, t] = ip.split("::");
    head = h ? h.split(":") : [];
    tail = t ? t.split(":") : [];
    const fill = 8 - head.length - tail.length;
    if (fill < 0) return null;
    head = [...head, ...new Array<string>(fill).fill("0"), ...tail];
  } else {
    head = ip.split(":");
    if (head.length !== 8) return null;
  }
  const bytes: number[] = [];
  for (const group of head) {
    const v = parseInt(group, 16);
    if (!Number.isInteger(v) || v < 0 || v > 0xffff) return null;
    bytes.push((v >> 8) & 0xff, v & 0xff);
  }
  return bytes;
}
