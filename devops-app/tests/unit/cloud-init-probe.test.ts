/** Feature 011 T024 — cloud-init probe parser invariants. */
import { describe, it, expect } from "vitest";
import { parseCloudProviderProbeOutput } from "../../server/services/cloud-init-probe.js";

describe("parseCloudProviderProbeOutput", () => {
  it("returns vanilla on empty stdout", () => {
    expect(parseCloudProviderProbeOutput("")).toBe("vanilla");
  });

  it("returns vanilla when no PROVIDER line", () => {
    expect(parseCloudProviderProbeOutput("noise\nmore noise")).toBe("vanilla");
  });

  it("detects gcp", () => {
    expect(parseCloudProviderProbeOutput("PROVIDER=gcp")).toBe("gcp");
  });

  it("detects aws via IMDSv2", () => {
    const out = "PROVIDER=aws\n";
    expect(parseCloudProviderProbeOutput(out)).toBe("aws");
  });

  it("detects digital ocean", () => {
    expect(parseCloudProviderProbeOutput("PROVIDER=do")).toBe("do");
  });

  it("detects hetzner", () => {
    expect(parseCloudProviderProbeOutput("PROVIDER=hetzner")).toBe("hetzner");
  });

  it("last PROVIDER line wins when multiple succeed", () => {
    const out = "PROVIDER=do\nPROVIDER=aws\n";
    expect(parseCloudProviderProbeOutput(out)).toBe("aws");
  });

  it("ignores invalid PROVIDER values", () => {
    const out = "PROVIDER=azure\nnoise\n";
    expect(parseCloudProviderProbeOutput(out)).toBe("vanilla");
  });

  it("tolerates surrounding whitespace and CRLF", () => {
    expect(parseCloudProviderProbeOutput("  PROVIDER=gcp  \r\n")).toBe("gcp");
  });
});
