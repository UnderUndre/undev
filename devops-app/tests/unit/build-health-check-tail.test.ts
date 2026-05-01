import { describe, it, expect } from "vitest";
import { buildHealthCheckTail } from "../../server/services/build-health-check-tail.js";

describe("buildHealthCheckTail (feature 006 T031)", () => {
  it("(a) baseline __WFH_DEADLINE math correct for timeoutMs=180000", () => {
    const out = buildHealthCheckTail({ container: "myapp-myapp-1", timeoutMs: 180_000 });
    expect(out).toMatch(/__WFH_DEADLINE=\$\(\( \$\(date \+%s\) \+ 180 \)\)/);
  });

  it("(b) container name with dashes single-quoted", () => {
    const out = buildHealthCheckTail({ container: "my-app-name-1", timeoutMs: 60_000 });
    expect(out).toContain("__WFH_CONTAINER='my-app-name-1'");
  });

  it("(c) container name with single quote escaped via shQuote", () => {
    const out = buildHealthCheckTail({ container: "weird'name", timeoutMs: 60_000 });
    expect(out).toContain("__WFH_CONTAINER='weird'\\''name'");
  });

  it("(d) __WFH_HAS_HC=0 branch produces silent-skip output and exit 0 (FR-028)", () => {
    const out = buildHealthCheckTail({ container: "x", timeoutMs: 1_000 });
    expect(out).toMatch(/has no healthcheck; skipping/);
    expect(out).toMatch(/if \[ "\$__WFH_HAS_HC" != "1" \]; then[\s\S]*?exit 0[\s\S]*?fi/);
  });

  it("(e) status 'healthy' branch → exit 0", () => {
    const out = buildHealthCheckTail({ container: "x", timeoutMs: 1_000 });
    expect(out).toMatch(/healthy\)\s+echo[^\n]+exit 0/);
  });

  it("(f) 'unhealthy' → exit 1", () => {
    const out = buildHealthCheckTail({ container: "x", timeoutMs: 1_000 });
    expect(out).toMatch(/unhealthy\)\s+echo[^\n]+exit 1/);
  });

  it("(g) 'starting' → keep polling (no exit)", () => {
    const out = buildHealthCheckTail({ container: "x", timeoutMs: 1_000 });
    expect(out).toMatch(/starting\)\s+;;/);
  });

  it("(h) timeout → exit 124 with the 'timeout waiting for healthy' message", () => {
    const out = buildHealthCheckTail({ container: "x", timeoutMs: 1_000 });
    expect(out).toMatch(/timeout waiting for healthy/);
    expect(out).toMatch(/exit 124/);
  });

  it("(i) FR-025 5s polling cadence", () => {
    const out = buildHealthCheckTail({ container: "x", timeoutMs: 1_000 });
    expect(out).toMatch(/sleep 5/);
  });

  it("(j) zero console.log / dangerouslySetInnerHTML markers in output (sanity)", () => {
    const out = buildHealthCheckTail({ container: "x", timeoutMs: 1_000 });
    expect(out).not.toMatch(/console\.log|dangerouslySetInnerHTML/);
  });

  it("(k) heredoc-safe quoting against $ injection in container name", () => {
    const out = buildHealthCheckTail({
      container: "$EVIL && rm -rf /",
      timeoutMs: 1_000,
    });
    // Single quotes prevent variable expansion
    expect(out).toContain("__WFH_CONTAINER='$EVIL && rm -rf /'");
  });

  it("(l) regression: starts with the comment header", () => {
    const out = buildHealthCheckTail({ container: "x", timeoutMs: 1_000 });
    expect(out.startsWith("# Feature 006 wait-for-healthy gate")).toBe(true);
  });

  it("(m) timeoutMs rounds up via Math.ceil for sub-second residuals", () => {
    const out = buildHealthCheckTail({ container: "x", timeoutMs: 1_500 });
    expect(out).toMatch(/__WFH_DEADLINE=\$\(\( \$\(date \+%s\) \+ 2 \)\)/);
  });
});
