/**
 * Feature 009: docker-compose YAML parser per FR-004.
 *
 * Contract: NEVER throws on operator-supplied compose. Returns a
 * discriminated union covering every observable failure mode:
 *
 *   - `yaml_invalid`   — YAML parse failure (operator must fix file)
 *   - `no_services`    — file parses but lacks a `services:` map
 *   - `ok`             — parsed; per-service kind narrows further
 *
 * Per service:
 *   - `ambiguous_port` — `${ENV_VAR}` interpolation in `ports:`/`expose:`,
 *                        cannot resolve at parse time → caller prompts
 *   - `ok`             — port resolved to integer
 *   - `no_port`        — service exposes nothing
 *
 * The parser deliberately does NOT eval env vars. Those belong to the
 * target compose runtime, not the dashboard's Node process.
 */

import { parse as yamlParse } from "yaml";

export interface ComposeServiceOk {
  kind: "ok";
  name: string;
  port: number;
  networkModeHost: boolean;
  replicas: number;
  hasHealthcheck: boolean;
}

export interface ComposeServiceAmbiguous {
  kind: "ambiguous_port";
  name: string;
  rawValue: string;
  networkModeHost: boolean;
  replicas: number;
  hasHealthcheck: boolean;
}

export interface ComposeServiceNoPort {
  kind: "no_port";
  name: string;
  networkModeHost: boolean;
  replicas: number;
  hasHealthcheck: boolean;
}

export type ComposeService =
  | ComposeServiceOk
  | ComposeServiceAmbiguous
  | ComposeServiceNoPort;

export type ParsedCompose =
  | { kind: "yaml_invalid"; error: string }
  | { kind: "no_services" }
  | { kind: "ok"; services: ComposeService[]; warnings: string[] };

const ENV_VAR_RE = /\$\{[^}]+\}|\$[A-Z_][A-Z0-9_]*/i;

export function parseCompose(yamlText: string): ParsedCompose {
  let doc: unknown;
  try {
    doc = yamlParse(yamlText);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { kind: "yaml_invalid", error: message };
  }

  if (
    doc === null ||
    typeof doc !== "object" ||
    !("services" in doc) ||
    typeof (doc as Record<string, unknown>).services !== "object" ||
    (doc as Record<string, unknown>).services === null
  ) {
    return { kind: "no_services" };
  }

  const servicesMap = (doc as { services: Record<string, unknown> }).services;
  const entries = Object.entries(servicesMap);
  if (entries.length === 0) {
    return { kind: "no_services" };
  }

  const services: ComposeService[] = [];
  const warnings: string[] = [];

  for (const [name, raw] of entries) {
    if (raw === null || typeof raw !== "object") {
      services.push({
        kind: "no_port",
        name,
        networkModeHost: false,
        replicas: 1,
        hasHealthcheck: false,
      });
      continue;
    }
    const svc = raw as {
      expose?: unknown;
      ports?: unknown;
      network_mode?: unknown;
      deploy?: unknown;
      healthcheck?: unknown;
    };

    const networkModeHost = svc.network_mode === "host";
    if (networkModeHost) {
      warnings.push(
        `Service "${name}" uses network_mode: host — reverse-proxy upstream becomes <server-ip>:<port> instead of Docker DNS.`,
      );
    }

    const replicas = readReplicas(svc.deploy);
    if (replicas > 1) {
      warnings.push(
        `Service "${name}" declares ${replicas} replicas — Caddy directive will fan out to all upstreams.`,
      );
    }

    const hasHealthcheck =
      svc.healthcheck !== undefined && svc.healthcheck !== null;

    const portResult = pickPort(svc.expose, svc.ports);
    if (portResult.kind === "ambiguous") {
      services.push({
        kind: "ambiguous_port",
        name,
        rawValue: portResult.raw,
        networkModeHost,
        replicas,
        hasHealthcheck,
      });
    } else if (portResult.kind === "ok") {
      services.push({
        kind: "ok",
        name,
        port: portResult.port,
        networkModeHost,
        replicas,
        hasHealthcheck,
      });
    } else {
      services.push({
        kind: "no_port",
        name,
        networkModeHost,
        replicas,
        hasHealthcheck,
      });
    }
  }

  return { kind: "ok", services, warnings };
}

type PickPortResult =
  | { kind: "ok"; port: number }
  | { kind: "ambiguous"; raw: string }
  | { kind: "none" };

function pickPort(expose: unknown, ports: unknown): PickPortResult {
  // `expose:` priority — declares container-internal ports.
  if (Array.isArray(expose) && expose.length > 0) {
    const first = expose[0];
    return parsePortValue(first);
  }
  // Fall back to `ports:` — right-hand side of "host:container" or { target }.
  if (Array.isArray(ports) && ports.length > 0) {
    const first = ports[0];
    return parsePortMapping(first);
  }
  return { kind: "none" };
}

function parsePortValue(raw: unknown): PickPortResult {
  if (typeof raw === "number") {
    return isValidPort(raw) ? { kind: "ok", port: raw } : { kind: "none" };
  }
  if (typeof raw === "string") {
    if (ENV_VAR_RE.test(raw)) return { kind: "ambiguous", raw };
    const n = Number(raw);
    return Number.isInteger(n) && isValidPort(n)
      ? { kind: "ok", port: n }
      : { kind: "none" };
  }
  return { kind: "none" };
}

function parsePortMapping(raw: unknown): PickPortResult {
  if (typeof raw === "number") {
    return isValidPort(raw) ? { kind: "ok", port: raw } : { kind: "none" };
  }
  if (typeof raw === "string") {
    if (ENV_VAR_RE.test(raw)) return { kind: "ambiguous", raw };
    // "host:container[/proto]" or "container" or "ip:host:container"
    const parts = raw.split(":");
    const containerPart = parts[parts.length - 1] ?? "";
    const portStr = containerPart.split("/")[0] ?? "";
    if (ENV_VAR_RE.test(portStr)) return { kind: "ambiguous", raw };
    const n = Number(portStr);
    return Number.isInteger(n) && isValidPort(n)
      ? { kind: "ok", port: n }
      : { kind: "none" };
  }
  if (raw !== null && typeof raw === "object") {
    const target = (raw as { target?: unknown }).target;
    return parsePortValue(target);
  }
  return { kind: "none" };
}

function isValidPort(n: number): boolean {
  return Number.isInteger(n) && n >= 1 && n <= 65535;
}

function readReplicas(deploy: unknown): number {
  if (deploy === null || typeof deploy !== "object") return 1;
  const replicas = (deploy as { replicas?: unknown }).replicas;
  if (typeof replicas === "number" && Number.isInteger(replicas) && replicas >= 1) {
    return replicas;
  }
  return 1;
}
