/**
 * Feature 011 T052 — Per-provider quirks table (FR-025).
 *
 * Code-only table. Adding a new provider entry requires a PR — no DB
 * involvement. Banners surface in the Compatibility Report; remediation
 * conveyed via wizard defaults rather than click-throughs.
 */

export type CloudProvider = "gcp" | "aws" | "do" | "hetzner" | "vanilla";

export interface ProviderQuirk {
  id: string;
  banner: string;
  remediation: "auto" | "manual";
  appliedBy?: string;
}

export const PROVIDER_QUIRKS: Record<CloudProvider, ProviderQuirk[]> = {
  gcp: [
    {
      id: "gcp.use_pty",
      banner:
        "GCP default sshd has `use_pty` set, which blocks non-TTY sudo. Initialise will set !use_pty so deploy automation works.",
      remediation: "auto",
      appliedBy: "server-ops/initialise",
    },
  ],
  aws: [
    {
      id: "aws.sudo_timeout",
      banner:
        "AWS Ubuntu AMIs have a 5-minute sudo password timeout. Long-running multi-step deploys may re-prompt.",
      remediation: "manual",
    },
  ],
  do: [],
  hetzner: [
    {
      id: "hetzner.python3_apt",
      banner:
        "Hetzner cloud images ship without `python3-apt`. Initialise installs it before configuring unattended-upgrades.",
      remediation: "auto",
      appliedBy: "server-ops/initialise",
    },
  ],
  vanilla: [],
};
