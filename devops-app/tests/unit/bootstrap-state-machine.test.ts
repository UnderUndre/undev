/** Feature 009 T059 — bootstrap state-machine transitions. */
import { describe, it, expect } from "vitest";
import { canTransition } from "../../server/lib/bootstrap-state-machine.js";

describe("bootstrap state machine", () => {
  it("allows the happy chain", () => {
    expect(canTransition("init", "cloning")).toBe(true);
    expect(canTransition("cloning", "compose_up")).toBe(true);
    expect(canTransition("compose_up", "healthcheck")).toBe(true);
    expect(canTransition("healthcheck", "active")).toBe(true);
    expect(canTransition("healthcheck", "proxy_applied")).toBe(true);
    expect(canTransition("proxy_applied", "cert_issued")).toBe(true);
    expect(canTransition("cert_issued", "active")).toBe(true);
  });

  it("allows failed_<step> → <step> retries", () => {
    expect(canTransition("failed_clone", "cloning")).toBe(true);
    expect(canTransition("failed_clone_pat_expired", "cloning")).toBe(true);
    expect(canTransition("failed_compose", "compose_up")).toBe(true);
    expect(canTransition("failed_compose", "cloning")).toBe(true);
    expect(canTransition("failed_healthcheck", "healthcheck")).toBe(true);
    expect(canTransition("failed_proxy", "proxy_applied")).toBe(true);
    expect(canTransition("failed_cert", "cert_issued")).toBe(true);
  });

  it("rejects backward transitions from active", () => {
    expect(canTransition("active", "cloning")).toBe(false);
    expect(canTransition("active", "compose_up")).toBe(false);
  });

  it("rejects skipping the chain", () => {
    expect(canTransition("init", "compose_up")).toBe(false);
    expect(canTransition("cloning", "active")).toBe(false);
    expect(canTransition("compose_up", "cert_issued")).toBe(false);
  });

  it("rejects retry across unrelated phases", () => {
    expect(canTransition("failed_proxy", "cloning")).toBe(false);
    expect(canTransition("failed_cert", "compose_up")).toBe(false);
    expect(canTransition("failed_clone", "compose_up")).toBe(false);
  });
});
