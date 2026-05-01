/**
 * Feature 006 — shared probe types.
 */
export type ProbeType = "container" | "http" | "cert_expiry" | "caddy_admin";
export type ProbeOutcomeStatus = "healthy" | "unhealthy" | "warning" | "error";

export interface ProbeOutcome {
  outcome: ProbeOutcomeStatus;
  probeType: ProbeType;
  latencyMs: number | null;
  statusCode: number | null;
  containerStatus: string | null;
  errorMessage: string | null;
}

/** Subset of `applications` row needed by probe runners. */
export interface AppProbeRow {
  id: string;
  serverId: string;
  name: string;
  remotePath: string;
  healthUrl: string | null;
  domain?: string | null; // feature 008 column; optional here
}

/** Subset of `servers` row needed by per-server probes. */
export interface ServerProbeRow {
  id: string;
  label: string;
}
