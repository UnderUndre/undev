/**
 * Feature 012 T011 — PATCH-time validator for blue/green deploy config.
 *
 * Performs the 6 cross-field checks per data-model.md FR-006/007/008/008a +
 * A-003. Returns a discriminated union — never throws.
 *
 * Reuses existing `compose-parser.ts` for replicas / network_mode /
 * healthcheck introspection. Volumes + host-port detection is done with
 * a light additional YAML parse here (compose-parser does not surface
 * those fields publicly).
 */

import { parse as yamlParse } from "yaml";
import { parseCompose } from "./compose-parser.js";

export type SlotColor = "blue" | "green";

export interface DetectedVolume {
  source: string;
  target: string;
  mode: "bind" | "named" | "tmpfs";
}

export type ValidationError =
  | { code: "blue_green_requires_caddy"; message: string }
  | {
      code: "blue_green_replicas_not_supported_v1";
      message: string;
      detectedReplicas: number;
    }
  | {
      code: "blue_green_incompatible_compose";
      reason: "network_mode_host" | "host_port_pins" | "no_healthcheck";
      message: string;
      detail?: unknown;
    }
  | {
      code: "volume_sharing_unacknowledged";
      detectedVolumes: DetectedVolume[];
      message: string;
    };

export type ValidationResult =
  | { ok: true }
  | { ok: false; error: ValidationError };

export interface ValidatorInput {
  proxyType: string | null;
  upstreamService: string | null;
  composeYaml: string;
  acknowledgeVolumeSharing: boolean | undefined;
}

export function validateBlueGreenConfig(input: ValidatorInput): ValidationResult {
  // 1. Caddy required (FR-006)
  if (input.proxyType !== "caddy") {
    return {
      ok: false,
      error: {
        code: "blue_green_requires_caddy",
        message: `Blue/green requires proxy_type='caddy' (got '${input.proxyType ?? "null"}')`,
      },
    };
  }

  const parsed = parseCompose(input.composeYaml);
  if (parsed.kind === "yaml_invalid" || parsed.kind === "no_services") {
    return {
      ok: false,
      error: {
        code: "blue_green_incompatible_compose",
        reason: "no_healthcheck",
        message: "Compose file did not parse or has no services",
        detail: parsed,
      },
    };
  }

  const upstreamName = input.upstreamService;
  const service =
    parsed.services.find((s) => s.name === upstreamName) ?? parsed.services[0];
  if (!service) {
    return {
      ok: false,
      error: {
        code: "blue_green_incompatible_compose",
        reason: "no_healthcheck",
        message: "Upstream service not found in compose",
      },
    };
  }

  // 2. Single replica (FR-007)
  if (service.replicas > 1) {
    return {
      ok: false,
      error: {
        code: "blue_green_replicas_not_supported_v1",
        message: `Blue/green v1 supports replicas=1 only (got ${service.replicas})`,
        detectedReplicas: service.replicas,
      },
    };
  }

  // 3. No network_mode:host (FR-008)
  if (service.networkModeHost) {
    return {
      ok: false,
      error: {
        code: "blue_green_incompatible_compose",
        reason: "network_mode_host",
        message: "Blue/green incompatible with network_mode: host",
      },
    };
  }

  // 4. No host port pins (FR-008) — re-parse YAML for raw ports field
  const rawService = readRawService(input.composeYaml, service.name);
  if (hasHostPortPins(rawService?.ports)) {
    return {
      ok: false,
      error: {
        code: "blue_green_incompatible_compose",
        reason: "host_port_pins",
        message:
          "Blue/green incompatible with host port pins (use 'expose:' instead of 'ports:')",
      },
    };
  }

  // 5. Healthcheck required (A-003)
  if (!service.hasHealthcheck) {
    return {
      ok: false,
      error: {
        code: "blue_green_incompatible_compose",
        reason: "no_healthcheck",
        message: "Blue/green requires a compose healthcheck on the upstream service",
      },
    };
  }

  // 6. Volume acknowledgement (FR-008a)
  const volumes = detectVolumes(rawService?.volumes);
  if (volumes.length > 0 && input.acknowledgeVolumeSharing !== true) {
    return {
      ok: false,
      error: {
        code: "volume_sharing_unacknowledged",
        detectedVolumes: volumes,
        message:
          "Compose declares volumes — acknowledgeVolumeSharing must be true",
      },
    };
  }

  return { ok: true };
}

interface RawService {
  ports?: unknown;
  volumes?: unknown;
}

function readRawService(yamlText: string, serviceName: string): RawService | null {
  try {
    const doc = yamlParse(yamlText);
    if (!doc || typeof doc !== "object") return null;
    const services = (doc as { services?: unknown }).services;
    if (!services || typeof services !== "object") return null;
    const svc = (services as Record<string, unknown>)[serviceName];
    if (!svc || typeof svc !== "object") return null;
    return svc as RawService;
  } catch {
    return null;
  }
}

function hasHostPortPins(ports: unknown): boolean {
  if (!Array.isArray(ports)) return false;
  for (const p of ports) {
    if (typeof p === "string") {
      // "host:container" form pins a host port; "container" alone does not.
      // Strip protocol suffix "/tcp" first.
      const stripped = p.split("/")[0] ?? "";
      const segments = stripped.split(":");
      if (segments.length >= 2) return true;
    } else if (p && typeof p === "object") {
      const obj = p as { published?: unknown; host_ip?: unknown };
      if (obj.published !== undefined || obj.host_ip !== undefined) return true;
    }
  }
  return false;
}

function detectVolumes(volumes: unknown): DetectedVolume[] {
  if (!Array.isArray(volumes)) return [];
  const out: DetectedVolume[] = [];
  for (const v of volumes) {
    const parsed = parseOneVolume(v);
    if (parsed) out.push(parsed);
  }
  return out;
}

function parseOneVolume(v: unknown): DetectedVolume | null {
  if (typeof v === "string") {
    const parts = v.split(":");
    const source = parts[0] ?? "";
    const target = parts[1] ?? source;
    const mode: DetectedVolume["mode"] =
      source.startsWith("/") || source.startsWith(".") ? "bind" : "named";
    return { source, target, mode };
  }
  if (v && typeof v === "object") {
    const obj = v as { type?: unknown; source?: unknown; target?: unknown };
    const type = obj.type;
    const mode: DetectedVolume["mode"] =
      type === "tmpfs" ? "tmpfs" : type === "volume" ? "named" : "bind";
    if (mode === "tmpfs") {
      // tmpfs is per-container ephemeral, not shared — skip.
      return null;
    }
    return {
      source: typeof obj.source === "string" ? obj.source : "",
      target: typeof obj.target === "string" ? obj.target : "",
      mode,
    };
  }
  return null;
}
