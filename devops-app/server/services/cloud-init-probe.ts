/**
 * Feature 011 T016 — cloud-provider detection over SSH.
 *
 * Issues a single composite SSH command that races curl probes against
 * each provider's IMDS endpoint (2s timeout each). Last `PROVIDER=<id>`
 * line in stdout wins. Vanilla = none responded.
 *
 * R-005 — see specs/011-zero-touch-onboarding/research.md.
 *
 * Probe endpoints:
 *   GCP      — http://metadata.google.internal (HTTP 200 + `Metadata-Flavor: Google`)
 *   AWS      — http://169.254.169.254/latest/meta-data/ (IMDSv1 fallback;
 *              IMDSv2 token fetch is omitted for the cheap detection probe)
 *   DO       — http://169.254.169.254/metadata/v1/id (DO returns plain text id)
 *   Hetzner  — http://169.254.169.254/hetzner/v1/metadata/instance-id
 *
 * The probe shells out via `sshPool.exec` rather than `execStream` because
 * the output is small (<1KB) and we want a single buffered read.
 */

import { sshPool } from "./ssh-pool.js";
import { logger } from "../lib/logger.js";

export type CloudProvider = "gcp" | "aws" | "do" | "hetzner" | "vanilla";

const PROBE_COMMAND = `
set +e
TIMEOUT=2

# GCP
if curl -fsS -m $TIMEOUT -H 'Metadata-Flavor: Google' \
     http://metadata.google.internal/computeMetadata/v1/instance/id \
     >/dev/null 2>&1; then
  echo "PROVIDER=gcp"
fi

# Hetzner (more specific than generic 169.254 — check first)
if curl -fsS -m $TIMEOUT \
     http://169.254.169.254/hetzner/v1/metadata/instance-id \
     >/dev/null 2>&1; then
  echo "PROVIDER=hetzner"
fi

# Digital Ocean
if curl -fsS -m $TIMEOUT \
     http://169.254.169.254/metadata/v1/id \
     >/dev/null 2>&1; then
  echo "PROVIDER=do"
fi

# AWS (IMDSv2 then v1 fallback)
TOKEN=$(curl -fsS -m $TIMEOUT -X PUT \
     -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' \
     http://169.254.169.254/latest/api/token 2>/dev/null || true)
if [ -n "$TOKEN" ]; then
  if curl -fsS -m $TIMEOUT \
       -H "X-aws-ec2-metadata-token: $TOKEN" \
       http://169.254.169.254/latest/meta-data/instance-id \
       >/dev/null 2>&1; then
    echo "PROVIDER=aws"
  fi
elif curl -fsS -m $TIMEOUT \
     http://169.254.169.254/latest/meta-data/instance-id \
     >/dev/null 2>&1; then
  echo "PROVIDER=aws"
fi
`.trim();

export function parseCloudProviderProbeOutput(stdout: string): CloudProvider {
  // Last `PROVIDER=<id>` line wins per R-005. Order in PROBE_COMMAND
  // intentionally lists Hetzner before DO and AWS so the more-specific
  // probe sticks if multiple succeed (shouldn't happen on real hosts).
  const lines = stdout.split(/\r?\n/);
  let last: CloudProvider | null = null;
  for (const line of lines) {
    const m = /^PROVIDER=(gcp|aws|do|hetzner)$/.exec(line.trim());
    if (m) last = m[1] as CloudProvider;
  }
  return last ?? "vanilla";
}

export async function probeCloudProvider(
  serverId: string,
): Promise<CloudProvider> {
  try {
    const result = await sshPool.exec(serverId, PROBE_COMMAND, 10_000);
    const provider = parseCloudProviderProbeOutput(result.stdout);
    logger.info(
      { ctx: "cloud-init-probe", serverId, provider },
      "cloud provider detection complete",
    );
    return provider;
  } catch (err) {
    logger.warn(
      { ctx: "cloud-init-probe", serverId, err },
      "cloud-init probe failed; falling back to vanilla",
    );
    return "vanilla";
  }
}
