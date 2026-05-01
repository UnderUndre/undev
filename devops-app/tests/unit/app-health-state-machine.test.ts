import { describe, it, expect, vi, beforeEach } from "vitest";

// We test the pure compute helpers exported from the poller module.
// State-machine commit goes through the DB; integration tests cover that
// pathway. Here we cover effective-outcome computation per FR-006.

vi.mock("../../server/db/index.js", () => ({
  db: {},
  client: () => Promise.resolve([]),
}));
vi.mock("../../server/ws/channels.js", () => ({
  channelManager: { broadcast: vi.fn() },
}));
vi.mock("../../server/services/notifier.js", () => ({
  notifier: {
    notifyAppHealthChange: vi.fn(async () => true),
    notifyCaddyUnreachable: vi.fn(async () => true),
    notifyCaddyRecovered: vi.fn(async () => true),
    notifyCertExpiring: vi.fn(async () => true),
    notify: vi.fn(async () => true),
  },
}));

import { computeEffectiveOutcome } from "../../server/services/app-health-poller.js";

describe("computeEffectiveOutcome (feature 006 FR-006)", () => {
  const makeOutcome = (
    outcome: "healthy" | "unhealthy" | "warning" | "error",
    probeType: "container" | "http" | "cert_expiry" | "caddy_admin" = "container",
  ) => ({
    outcome,
    probeType,
    latencyMs: 1,
    statusCode: null,
    containerStatus: null,
    errorMessage: null,
  });

  beforeEach(() => vi.clearAllMocks());

  it("any unhealthy → unhealthy", () => {
    expect(
      computeEffectiveOutcome(
        makeOutcome("unhealthy"),
        makeOutcome("healthy", "http"),
      ),
    ).toBe("unhealthy");
  });

  it("all healthy → healthy", () => {
    expect(
      computeEffectiveOutcome(
        makeOutcome("healthy"),
        makeOutcome("healthy", "http"),
      ),
    ).toBe("healthy");
  });

  it("only container healthy, no http → healthy", () => {
    expect(computeEffectiveOutcome(makeOutcome("healthy"), null)).toBe("healthy");
  });

  it("error + healthy mix → unknown (insufficient evidence)", () => {
    expect(
      computeEffectiveOutcome(
        makeOutcome("error"),
        makeOutcome("healthy", "http"),
      ),
    ).toBe("unknown");
  });

  it("no probes considered → unknown", () => {
    expect(computeEffectiveOutcome(null, null)).toBe("unknown");
  });

  it("FR-006a: cert_expiry probe excluded from overall state", () => {
    // Even an unhealthy cert probe doesn't flip the app state — but we
    // never feed cert probes to computeEffectiveOutcome via the poller.
    // Verify the function ignores cert_expiry if accidentally included.
    const cert = makeOutcome("unhealthy", "cert_expiry");
    const http = makeOutcome("healthy", "http");
    expect(computeEffectiveOutcome(cert, http)).toBe("healthy");
  });
});
