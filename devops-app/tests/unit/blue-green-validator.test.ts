import { describe, it, expect } from "vitest";
import { validateBlueGreenConfig } from "../../server/lib/blue-green-validator.js";

const HEALTHY_COMPOSE = `
services:
  api:
    image: foo/bar:latest
    expose:
      - "3000"
    healthcheck:
      test: ["CMD", "true"]
`;

const COMPOSE_WITH_VOLUMES_STRING = `
services:
  api:
    image: foo/bar:latest
    expose:
      - "3000"
    healthcheck:
      test: ["CMD", "true"]
    volumes:
      - "./data:/data"
`;

const COMPOSE_WITH_VOLUMES_OBJECT = `
services:
  api:
    image: foo/bar:latest
    expose:
      - "3000"
    healthcheck:
      test: ["CMD", "true"]
    volumes:
      - type: bind
        source: ./data
        target: /data
`;

const COMPOSE_NETWORK_HOST = `
services:
  api:
    network_mode: host
    healthcheck:
      test: ["CMD", "true"]
`;

const COMPOSE_HOST_PORT_PINS = `
services:
  api:
    ports:
      - "8080:3000"
    healthcheck:
      test: ["CMD", "true"]
`;

const COMPOSE_NO_HEALTHCHECK = `
services:
  api:
    expose:
      - "3000"
`;

const COMPOSE_REPLICAS = `
services:
  api:
    expose:
      - "3000"
    healthcheck:
      test: ["CMD", "true"]
    deploy:
      replicas: 3
`;

describe("blue-green-validator", () => {
  it("happy path: caddy + replicas=1 + no host network + healthcheck + no volumes → ok", () => {
    const r = validateBlueGreenConfig({
      proxyType: "caddy",
      upstreamService: "api",
      composeYaml: HEALTHY_COMPOSE,
      acknowledgeVolumeSharing: undefined,
    });
    expect(r.ok).toBe(true);
  });

  it("rejects non-caddy proxy", () => {
    const r = validateBlueGreenConfig({
      proxyType: "nginx-legacy",
      upstreamService: "api",
      composeYaml: HEALTHY_COMPOSE,
      acknowledgeVolumeSharing: undefined,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("blue_green_requires_caddy");
  });

  it("rejects replicas > 1", () => {
    const r = validateBlueGreenConfig({
      proxyType: "caddy",
      upstreamService: "api",
      composeYaml: COMPOSE_REPLICAS,
      acknowledgeVolumeSharing: undefined,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("blue_green_replicas_not_supported_v1");
  });

  it("rejects network_mode: host", () => {
    const r = validateBlueGreenConfig({
      proxyType: "caddy",
      upstreamService: "api",
      composeYaml: COMPOSE_NETWORK_HOST,
      acknowledgeVolumeSharing: undefined,
    });
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.code === "blue_green_incompatible_compose") {
      expect(r.error.reason).toBe("network_mode_host");
    }
  });

  it("rejects host port pins", () => {
    const r = validateBlueGreenConfig({
      proxyType: "caddy",
      upstreamService: "api",
      composeYaml: COMPOSE_HOST_PORT_PINS,
      acknowledgeVolumeSharing: undefined,
    });
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.code === "blue_green_incompatible_compose") {
      expect(r.error.reason).toBe("host_port_pins");
    }
  });

  it("rejects missing healthcheck", () => {
    const r = validateBlueGreenConfig({
      proxyType: "caddy",
      upstreamService: "api",
      composeYaml: COMPOSE_NO_HEALTHCHECK,
      acknowledgeVolumeSharing: undefined,
    });
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.code === "blue_green_incompatible_compose") {
      expect(r.error.reason).toBe("no_healthcheck");
    }
  });

  it("rejects volumes without ack (string-form)", () => {
    const r = validateBlueGreenConfig({
      proxyType: "caddy",
      upstreamService: "api",
      composeYaml: COMPOSE_WITH_VOLUMES_STRING,
      acknowledgeVolumeSharing: false,
    });
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.code === "volume_sharing_unacknowledged") {
      expect(r.error.detectedVolumes.length).toBeGreaterThan(0);
      expect(r.error.detectedVolumes[0]?.source).toBe("./data");
    }
  });

  it("accepts volumes with ack=true (object-form)", () => {
    const r = validateBlueGreenConfig({
      proxyType: "caddy",
      upstreamService: "api",
      composeYaml: COMPOSE_WITH_VOLUMES_OBJECT,
      acknowledgeVolumeSharing: true,
    });
    expect(r.ok).toBe(true);
  });

  it("volume-less app with ack=undefined → ok (ack only required when volumes present)", () => {
    const r = validateBlueGreenConfig({
      proxyType: "caddy",
      upstreamService: "api",
      composeYaml: HEALTHY_COMPOSE,
      acknowledgeVolumeSharing: undefined,
    });
    expect(r.ok).toBe(true);
  });
});
