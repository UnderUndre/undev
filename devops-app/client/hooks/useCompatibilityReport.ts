/**
 * Feature 011 T022 — typed hook for stateless server probe.
 *
 * Triggered explicitly by the operator's "Test connection" click — no
 * auto-debounce per OQ-004 resolution. Calls POST /api/servers/probe and
 * surfaces the cached probe-token + cloud + compatibility result.
 */

import { useMutation } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api.js";
import type { CompatibilityReportData } from "../components/servers/CompatibilityReport.js";

export type CloudProvider = "gcp" | "aws" | "do" | "hetzner" | "vanilla";

export type BootstrapAuth =
  | { mode: "key"; privateKey: string }
  | { mode: "password"; password: string }
  | { mode: "generate-key" };

export interface ProbeRequest {
  host: string;
  port: number;
  sshUser: string;
  bootstrapAuth: BootstrapAuth;
  acceptHostKeyChange?: boolean;
  expectedHostKeyFingerprint?: string | null;
}

export interface ProbeResult {
  probeToken: string;
  cloudProvider: CloudProvider;
  compatibility: CompatibilityReportData;
  hostKeyFingerprint: string;
  hostKeyMismatch: boolean;
  generatedPublicKey?: string;
}

export function useCompatibilityReport() {
  return useMutation<ProbeResult, ApiError, ProbeRequest>({
    mutationFn: (req) => api.post<ProbeResult>("/servers/probe", req),
  });
}
