/**
 * Feature 006 FR-029a / FR-029b — SSRF guard.
 *
 * Resolves a URL's hostname to IPv4/IPv6 addresses and rejects probe targets
 * that resolve into private / link-local / loopback ranges. Block list:
 *   - RFC 1918   private IPv4 (10/8, 172.16/12, 192.168/16)
 *   - RFC 3927   link-local IPv4 169.254/16 (incl. AWS/GCP/Azure IMDS at 169.254.169.254)
 *   - RFC 6890   loopback (127/8, ::1/128)
 *   - RFC 4193   ULA IPv6  (fc00::/7)
 *   - RFC 4291   link-local IPv6 (fe80::/10)
 *   - "this network" 0.0.0.0/8
 *
 * The block list is applied to **every** resolved address (multi-A-record
 * defence). Re-resolution happens at probe time, defending against DNS
 * rebinding between form-write and probe-time.
 *
 * Authoritative gate: `validateUrlForProbe` is called inside the HTTP probe
 * runner (T053). Form-time validation (T054) is UX only.
 */
import { resolve4, resolve6 } from "node:dns/promises";

export type SsrfFailureCode = "private_ip" | "invalid_url" | "nxdomain";

export interface SsrfValidationOk {
  ok: true;
  resolvedIps: string[];
}

export interface SsrfValidationFail {
  ok: false;
  code: SsrfFailureCode;
  resolvedIps: string[];
}

export type SsrfValidationResult = SsrfValidationOk | SsrfValidationFail;

/** Convert dotted-quad to 32-bit unsigned int. Returns null on parse failure. */
function ipv4ToUint(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let acc = 0;
  for (const p of parts) {
    const n = Number.parseInt(p, 10);
    if (!Number.isInteger(n) || n < 0 || n > 255 || String(n) !== p) return null;
    acc = (acc << 8) >>> 0;
    acc = (acc | n) >>> 0;
  }
  return acc;
}

/** Expand "::1", "fe80::1", etc. into a normalised lowercase 8-group form. */
function normaliseIpv6(ip: string): string | null {
  // Strip optional zone-id (fe80::1%eth0)
  const stripped = ip.split("%")[0]?.toLowerCase() ?? "";
  if (stripped === "") return null;
  // IPv4-mapped (::ffff:1.2.3.4) — collapse the v4 tail to two hex groups.
  let work = stripped;
  const v4Match = work.match(/^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (v4Match) {
    const head = v4Match[1] ?? "";
    const v4 = v4Match[2] ?? "";
    const v4n = ipv4ToUint(v4);
    if (v4n === null) return null;
    const hi = ((v4n >>> 16) & 0xffff).toString(16);
    const lo = (v4n & 0xffff).toString(16);
    work = `${head}${hi}:${lo}`;
  }
  const dblIdx = work.indexOf("::");
  let groups: string[];
  if (dblIdx === -1) {
    groups = work.split(":");
  } else {
    const left = work.slice(0, dblIdx) === "" ? [] : work.slice(0, dblIdx).split(":");
    const right = work.slice(dblIdx + 2) === "" ? [] : work.slice(dblIdx + 2).split(":");
    const fill = 8 - left.length - right.length;
    if (fill < 0) return null;
    groups = [...left, ...Array<string>(fill).fill("0"), ...right];
  }
  if (groups.length !== 8) return null;
  return groups
    .map((g) => {
      const n = Number.parseInt(g, 16);
      if (!Number.isInteger(n) || n < 0 || n > 0xffff) return null;
      return n.toString(16);
    })
    .join(":");
}

function isBlockedIpv4(ip: string): boolean {
  const u = ipv4ToUint(ip);
  if (u === null) return true; // unparseable v4 → reject
  // 0.0.0.0/8
  if ((u & 0xff000000) >>> 0 === 0x00000000) return true;
  // 10.0.0.0/8
  if ((u & 0xff000000) >>> 0 === 0x0a000000) return true;
  // 127.0.0.0/8 (loopback)
  if ((u & 0xff000000) >>> 0 === 0x7f000000) return true;
  // 169.254.0.0/16 (link-local incl. cloud IMDS)
  if ((u & 0xffff0000) >>> 0 === 0xa9fe0000) return true;
  // 172.16.0.0/12
  if ((u & 0xfff00000) >>> 0 === 0xac100000) return true;
  // 192.168.0.0/16
  if ((u & 0xffff0000) >>> 0 === 0xc0a80000) return true;
  return false;
}

function isBlockedIpv6(ip: string): boolean {
  const norm = normaliseIpv6(ip);
  if (norm === null) return true;
  const groups = norm.split(":").map((g) => Number.parseInt(g, 16));
  if (groups.length !== 8 || groups.some((g) => !Number.isFinite(g))) return true;
  // ::1 loopback
  if (groups.every((g, i) => (i < 7 ? g === 0 : g === 1))) return true;
  // ::  unspecified
  if (groups.every((g) => g === 0)) return true;
  // fc00::/7  (ULA)
  if ((groups[0]! & 0xfe00) === 0xfc00) return true;
  // fe80::/10 (link-local)
  if ((groups[0]! & 0xffc0) === 0xfe80) return true;
  return false;
}

/** Public: returns true when the IP is in any blocked range. */
export function isBlockedIp(ip: string): boolean {
  if (ip.includes(":")) return isBlockedIpv6(ip);
  return isBlockedIpv4(ip);
}

/**
 * Validate a probe URL: parse it, resolve DNS, ensure NO resolved address is
 * in the block list. Re-resolves on every call — never cache the result.
 */
export async function validateUrlForProbe(
  url: string,
): Promise<SsrfValidationResult> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, code: "invalid_url", resolvedIps: [] };
  }
  const host = parsed.hostname;
  if (host === "") return { ok: false, code: "invalid_url", resolvedIps: [] };

  // Literal IP — skip DNS, validate directly.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":")) {
    if (isBlockedIp(host)) return { ok: false, code: "private_ip", resolvedIps: [host] };
    return { ok: true, resolvedIps: [host] };
  }

  const v4 = await safeResolve(() => resolve4(host));
  const v6 = await safeResolve(() => resolve6(host));
  const all = [...v4, ...v6];
  if (all.length === 0) return { ok: false, code: "nxdomain", resolvedIps: [] };

  for (const ip of all) {
    if (isBlockedIp(ip)) return { ok: false, code: "private_ip", resolvedIps: all };
  }
  return { ok: true, resolvedIps: all };
}

async function safeResolve(fn: () => Promise<string[]>): Promise<string[]> {
  try {
    return await fn();
  } catch {
    return [];
  }
}
