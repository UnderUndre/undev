import { describe, it, expect } from "vitest";
import { parseCompose } from "../../server/lib/compose-parser.js";

describe("parseCompose (FR-004)", () => {
  it("happy path: single service with ports", () => {
    const yaml = `
services:
  api:
    image: node:20
    ports:
      - "3000:3000"
`;
    const r = parseCompose(yaml);
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.services).toHaveLength(1);
    const svc = r.services[0];
    expect(svc.name).toBe("api");
    expect(svc.kind).toBe("ok");
    if (svc.kind === "ok") expect(svc.port).toBe(3000);
  });

  it("expose: takes priority over ports:", () => {
    const yaml = `
services:
  api:
    expose:
      - "8080"
    ports:
      - "3000:3000"
`;
    const r = parseCompose(yaml);
    if (r.kind !== "ok") throw new Error("expected ok");
    const svc = r.services[0];
    if (svc.kind !== "ok") throw new Error("expected port");
    expect(svc.port).toBe(8080);
  });

  it("env-var interpolation marks service ambiguous (no throw)", () => {
    const yaml = `
services:
  api:
    ports:
      - "\${APP_PORT}:80"
`;
    const r = parseCompose(yaml);
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    const svc = r.services[0];
    expect(svc.kind).toBe("ambiguous_port");
    if (svc.kind === "ambiguous_port") {
      expect(svc.rawValue).toContain("${APP_PORT}");
    }
  });

  it("env-var with default also marked ambiguous", () => {
    const yaml = `
services:
  api:
    ports:
      - "\${HOST_PORT:-3000}:\${CONTAINER_PORT}"
`;
    const r = parseCompose(yaml);
    if (r.kind !== "ok") throw new Error("expected ok");
    expect(r.services[0].kind).toBe("ambiguous_port");
  });

  it("malformed YAML returns yaml_invalid (no throw)", () => {
    const yaml = `
services:
  api:
    ports: ["3000:3000"
    image: broken
`;
    const r = parseCompose(yaml);
    expect(r.kind).toBe("yaml_invalid");
  });

  it("empty services map returns no_services", () => {
    expect(parseCompose("services: {}").kind).toBe("no_services");
  });

  it("missing services key returns no_services", () => {
    expect(parseCompose("version: '3.8'").kind).toBe("no_services");
  });

  it("network_mode: host emits warning", () => {
    const yaml = `
services:
  api:
    network_mode: host
    ports:
      - "3000:3000"
`;
    const r = parseCompose(yaml);
    if (r.kind !== "ok") throw new Error("expected ok");
    expect(r.services[0].networkModeHost).toBe(true);
    expect(r.warnings.some((w) => w.includes("network_mode: host"))).toBe(true);
  });

  it("deploy.replicas > 1 emits warning", () => {
    const yaml = `
services:
  api:
    image: foo
    deploy:
      replicas: 3
    expose:
      - "8080"
`;
    const r = parseCompose(yaml);
    if (r.kind !== "ok") throw new Error("expected ok");
    expect(r.services[0].replicas).toBe(3);
    expect(r.warnings.some((w) => w.includes("replicas"))).toBe(true);
  });

  it("multi-service detection", () => {
    const yaml = `
services:
  web:
    expose: ["80"]
  worker:
    image: foo
  db:
    expose: ["5432"]
`;
    const r = parseCompose(yaml);
    if (r.kind !== "ok") throw new Error("expected ok");
    expect(r.services).toHaveLength(3);
    expect(r.services.map((s) => s.name).sort()).toEqual(["db", "web", "worker"]);
  });

  it("healthcheck presence detected", () => {
    const yaml = `
services:
  api:
    image: foo
    expose: ["80"]
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost"]
`;
    const r = parseCompose(yaml);
    if (r.kind !== "ok") throw new Error("expected ok");
    expect(r.services[0].hasHealthcheck).toBe(true);
  });

  it("ports with /tcp suffix", () => {
    const yaml = `
services:
  api:
    ports:
      - "3000:3000/tcp"
`;
    const r = parseCompose(yaml);
    if (r.kind !== "ok") throw new Error("expected ok");
    const svc = r.services[0];
    if (svc.kind !== "ok") throw new Error("expected port");
    expect(svc.port).toBe(3000);
  });

  it("long-form ports object with target", () => {
    const yaml = `
services:
  api:
    ports:
      - target: 8080
        published: 80
`;
    const r = parseCompose(yaml);
    if (r.kind !== "ok") throw new Error("expected ok");
    const svc = r.services[0];
    if (svc.kind !== "ok") throw new Error("expected port");
    expect(svc.port).toBe(8080);
  });

  it("service with no ports/expose returns no_port kind", () => {
    const yaml = `
services:
  worker:
    image: foo
`;
    const r = parseCompose(yaml);
    if (r.kind !== "ok") throw new Error("expected ok");
    expect(r.services[0].kind).toBe("no_port");
  });
});
