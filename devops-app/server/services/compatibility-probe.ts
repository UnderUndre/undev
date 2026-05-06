/**
 * Feature 011 T017 — pre-save compatibility probe.
 *
 * Single composite SSH command collects key=value lines:
 *   SSH_OK / SUDO_NOPASSWD / USE_PTY / DOCKER / DISK_FREE_GB / SWAP /
 *   OS_FAMILY / OS_VERSION / ARCH
 *
 * Parser maps each to one CompatibilityCheck per R-010. Auto-fixable
 * issues (Docker missing, swap absent, use_pty set) come back as `warn`
 * — Initialise can resolve them. Hard `fail` rows block save.
 *
 * Uses `df -PBG /` so long mount-source names don't wrap output (gemini #6).
 */

import { sshPool } from "./ssh-pool.js";
import { logger } from "../lib/logger.js";
import {
  PROVIDER_QUIRKS,
  type CloudProvider,
} from "../lib/cloud-provider-quirks.js";

export type CheckStatus = "pass" | "warn" | "fail";

export interface CompatibilityCheck {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  autoFixableByInitialise: boolean;
  action?: "initialise" | "edit-server" | "manual";
}

export interface CompatibilityReport {
  overall: CheckStatus;
  checks: CompatibilityCheck[];
  hints: string[];
  /** Captured for the parent caller — moves into servers.host_key_fingerprint
   *  on createServer. NOT part of the user-facing report. */
  hostKeyFingerprint?: string | null;
}

const PROBE_COMMAND = `
set +e
echo "SSH_OK=true"

if sudo -n true 2>/dev/null; then echo "SUDO_NOPASSWD=true"; else echo "SUDO_NOPASSWD=false"; fi

if grep -qE '^#?UsePTY[[:space:]]+yes' /etc/ssh/sshd_config 2>/dev/null; then
  echo "USE_PTY=true"
else
  echo "USE_PTY=false"
fi

if command -v docker >/dev/null 2>&1; then
  echo "DOCKER=$(docker --version 2>/dev/null | awk '{print $3}' | tr -d ',')"
else
  echo "DOCKER="
fi

# -PBG: POSIX flag prevents output wrap on long mount-source names (per gemini #6).
DF_LINE=$(df -PBG / 2>/dev/null | awk 'NR==2 {print $4}' | tr -d 'G')
echo "DISK_FREE_GB=\${DF_LINE:-0}"

if free -m 2>/dev/null | awk '/^Swap:/ {exit ($2 > 0) ? 0 : 1}'; then
  echo "SWAP=true"
else
  echo "SWAP=false"
fi

if [ -r /etc/os-release ]; then
  . /etc/os-release
  echo "OS_FAMILY=\${ID_LIKE:-\${ID:-unknown}}"
  echo "OS_VERSION=\${VERSION_ID:-unknown}"
else
  echo "OS_FAMILY=unknown"
  echo "OS_VERSION=unknown"
fi

echo "ARCH=$(uname -m)"
`.trim();

interface ParsedFields {
  SSH_OK?: string;
  SUDO_NOPASSWD?: string;
  USE_PTY?: string;
  DOCKER?: string;
  DISK_FREE_GB?: string;
  SWAP?: string;
  OS_FAMILY?: string;
  OS_VERSION?: string;
  ARCH?: string;
}

function parseFields(stdout: string): ParsedFields {
  const out: Record<string, string> = {};
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || !line.includes("=")) continue;
    const eq = line.indexOf("=");
    const k = line.slice(0, eq).trim();
    const v = line.slice(eq + 1).trim();
    out[k] = v;
  }
  return out as ParsedFields;
}

const SUPPORTED_OS_FAMILIES = new Set([
  "debian",
  "ubuntu",
  "ubuntu debian",
  "debian ubuntu",
]);

export function buildReportFromFields(
  fields: ParsedFields,
  cloudProvider: CloudProvider,
): CompatibilityReport {
  const checks: CompatibilityCheck[] = [];

  // SSH connectivity (always true if probe ran at all, but explicit row
  // helps the UI show the cascade).
  checks.push({
    id: "ssh.connect",
    label: "SSH connectivity",
    status: fields.SSH_OK === "true" ? "pass" : "fail",
    detail:
      fields.SSH_OK === "true"
        ? "Connected as the configured user"
        : "Could not connect — check credentials and reachability",
    autoFixableByInitialise: false,
    action: fields.SSH_OK === "true" ? undefined : "edit-server",
  });

  // Passwordless sudo
  checks.push({
    id: "sudo.nopasswd",
    label: "Passwordless sudo",
    status: fields.SUDO_NOPASSWD === "true" ? "pass" : "warn",
    detail:
      fields.SUDO_NOPASSWD === "true"
        ? "sudo -n true succeeds"
        : "Deploy user needs NOPASSWD sudo for unattended runs (Initialise will configure)",
    autoFixableByInitialise: true,
    action:
      fields.SUDO_NOPASSWD === "true" ? undefined : "initialise",
  });

  // UsePTY (warn if set; Initialise can flip)
  checks.push({
    id: "ssh.use_pty",
    label: "sshd UsePTY",
    status: fields.USE_PTY === "true" ? "warn" : "pass",
    detail:
      fields.USE_PTY === "true"
        ? "UsePTY is on — non-TTY sudo from the dashboard will fail. Initialise can switch this off."
        : "UsePTY off (or unset; default off)",
    autoFixableByInitialise: true,
    action: fields.USE_PTY === "true" ? "initialise" : undefined,
  });

  // Docker
  const hasDocker = fields.DOCKER !== undefined && fields.DOCKER !== "";
  checks.push({
    id: "docker.present",
    label: "Docker installed",
    status: hasDocker ? "pass" : "warn",
    detail: hasDocker
      ? `Docker ${fields.DOCKER}`
      : "Docker is missing — Initialise will install it",
    autoFixableByInitialise: true,
    action: hasDocker ? undefined : "initialise",
  });

  // Disk free
  const diskGb = Number.parseInt(fields.DISK_FREE_GB ?? "0", 10);
  let diskStatus: CheckStatus = "pass";
  let diskDetail = `${diskGb}G free on /`;
  if (Number.isNaN(diskGb) || diskGb < 5) {
    diskStatus = "fail";
    diskDetail = `Only ${diskGb}G free — deploys may fail. Free up space first.`;
  } else if (diskGb < 10) {
    diskStatus = "warn";
    diskDetail = `${diskGb}G free — tight for image rebuilds.`;
  }
  checks.push({
    id: "disk.free",
    label: "Disk space",
    status: diskStatus,
    detail: diskDetail,
    autoFixableByInitialise: false,
    action: diskStatus === "pass" ? undefined : "manual",
  });

  // Swap
  checks.push({
    id: "swap.present",
    label: "Swap configured",
    status: fields.SWAP === "true" ? "pass" : "warn",
    detail:
      fields.SWAP === "true"
        ? "Swap active"
        : "No swap — Initialise will create a swap file",
    autoFixableByInitialise: true,
    action: fields.SWAP === "true" ? undefined : "initialise",
  });

  // OS family
  const family = (fields.OS_FAMILY ?? "unknown").toLowerCase();
  const supported = SUPPORTED_OS_FAMILIES.has(family) || family.includes("debian");
  checks.push({
    id: "os.family",
    label: "OS family",
    status: supported ? "pass" : "warn",
    detail: `${fields.OS_FAMILY ?? "unknown"} ${fields.OS_VERSION ?? ""}`.trim(),
    autoFixableByInitialise: false,
    action: supported ? undefined : "manual",
  });

  // Architecture
  const arch = fields.ARCH ?? "unknown";
  const archOk = arch === "x86_64" || arch === "amd64";
  checks.push({
    id: "arch",
    label: "CPU architecture",
    status: archOk ? "pass" : "warn",
    detail: `${arch}${archOk ? "" : " — not all images may be available"}`,
    autoFixableByInitialise: false,
    action: archOk ? undefined : "manual",
  });

  // Aggregate
  const hasFail = checks.some((c) => c.status === "fail");
  const hasWarn = checks.some((c) => c.status === "warn");
  const overall: CheckStatus = hasFail ? "fail" : hasWarn ? "warn" : "pass";

  // Hints from PROVIDER_QUIRKS — stringly to keep the wire shape simple.
  const hints = PROVIDER_QUIRKS[cloudProvider].map((q) => q.banner);

  return { overall, checks, hints };
}

export async function probeCompatibility(
  serverId: string,
  cloudProvider: CloudProvider,
): Promise<CompatibilityReport> {
  try {
    const result = await sshPool.exec(serverId, PROBE_COMMAND, 15_000);
    const fields = parseFields(result.stdout);
    return buildReportFromFields(fields, cloudProvider);
  } catch (err) {
    logger.error(
      { ctx: "compatibility-probe", serverId, err },
      "probe failed; returning fail row",
    );
    return {
      overall: "fail",
      checks: [
        {
          id: "ssh.connect",
          label: "SSH connectivity",
          status: "fail",
          detail:
            err instanceof Error ? err.message : "SSH session failed",
          autoFixableByInitialise: false,
          action: "edit-server",
        },
      ],
      hints: PROVIDER_QUIRKS[cloudProvider].map((q) => q.banner),
    };
  }
}
