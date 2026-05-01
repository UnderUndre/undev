/**
 * Feature 008 T020 — DNS pre-check (FR-012..FR-015).
 *
 * Resolves A + AAAA via Node `dns.promises`, classifies the outcome against
 * the server IP and the Cloudflare CIDR list (T017). 5s timeout per query.
 */

import { promises as dns } from "node:dns";
import { getCloudflareCidrs, isCloudflareIp } from "../lib/cloudflare-cidrs.js";
import { logger } from "../lib/logger.js";

export type PrecheckOutcome =
  | { kind: "match"; resolvedIps: string[] }
  | { kind: "cloudflare"; resolvedIps: string[]; cfRanges: string[] }
  | { kind: "mismatch"; resolvedIps: string[]; serverIp: string }
  | { kind: "nxdomain" };

const TIMEOUT_MS = 5_000;

interface DnsLike {
  resolve4(host: string): Promise<string[]>;
  resolve6(host: string): Promise<string[]>;
}

const defaultDns: DnsLike = {
  resolve4: (h) => dns.resolve4(h),
  resolve6: (h) => dns.resolve6(h),
};

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("dns-timeout")), ms);
    timer.unref();
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function isNxDomainErr(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOTFOUND" || code === "ENODATA";
}

export async function precheck(
  domain: string,
  serverIp: string,
  deps: DnsLike = defaultDns,
): Promise<PrecheckOutcome> {
  // Ensure the CF cache is hot — first call may fetch.
  await getCloudflareCidrs();

  const v4Result = await safeResolve(() => withTimeout(deps.resolve4(domain), TIMEOUT_MS));
  const v6Result = await safeResolve(() => withTimeout(deps.resolve6(domain), TIMEOUT_MS));

  if (v4Result.kind === "nxdomain" && v6Result.kind === "nxdomain") {
    return { kind: "nxdomain" };
  }

  const resolved = [
    ...(v4Result.kind === "ok" ? v4Result.ips : []),
    ...(v6Result.kind === "ok" ? v6Result.ips : []),
  ];

  if (resolved.length === 0) {
    // Both calls failed for non-NXDOMAIN reasons — treat as nxdomain to avoid
    // burning a rate-limit slot on what looks like a missing record.
    logger.warn(
      { ctx: "dns-precheck", domain, v4: v4Result, v6: v6Result },
      "no IPs resolved (treating as nxdomain)",
    );
    return { kind: "nxdomain" };
  }

  if (resolved.includes(serverIp)) {
    return { kind: "match", resolvedIps: resolved };
  }

  const cfHits: string[] = resolved.filter((ip) => isCloudflareIp(ip));
  if (cfHits.length > 0) {
    return { kind: "cloudflare", resolvedIps: resolved, cfRanges: cfHits };
  }

  return { kind: "mismatch", resolvedIps: resolved, serverIp };
}

async function safeResolve(
  fn: () => Promise<string[]>,
): Promise<{ kind: "ok"; ips: string[] } | { kind: "nxdomain" } | { kind: "error"; err: unknown }> {
  try {
    const ips = await fn();
    return { kind: "ok", ips };
  } catch (err) {
    if (isNxDomainErr(err)) return { kind: "nxdomain" };
    return { kind: "error", err };
  }
}
