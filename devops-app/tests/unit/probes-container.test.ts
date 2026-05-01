import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../server/services/ssh-pool.js", () => ({
  sshPool: {
    exec: vi.fn(),
  },
}));

import { sshPool } from "../../server/services/ssh-pool.js";
import {
  runContainerProbe,
  deriveContainerName,
} from "../../server/services/probes/container.js";

const makeApp = (over: Partial<{ id: string; name: string }> = {}) => ({
  id: over.id ?? "app-1",
  serverId: "srv-1",
  name: over.name ?? "myapp",
  remotePath: "/opt/myapp",
  healthUrl: null,
});

describe("deriveContainerName (feature 006 T008)", () => {
  it("defaults to <name>-<name>-1", () => {
    expect(deriveContainerName({ name: "myapp" })).toBe("myapp-myapp-1");
  });
  it("lowercases + sanitises", () => {
    expect(deriveContainerName({ name: "My App.X" })).toBe("my-app-x-my-app-x-1");
  });
  it("handles dashes in name", () => {
    expect(deriveContainerName({ name: "ai-twins" })).toBe("ai-twins-ai-twins-1");
  });
});

describe("runContainerProbe (feature 006 T008)", () => {
  beforeEach(() => {
    vi.mocked(sshPool.exec).mockReset();
  });

  it("healthy → outcome=healthy", async () => {
    vi.mocked(sshPool.exec).mockResolvedValue({
      stdout: "healthy\n",
      stderr: "",
      exitCode: 0,
    });
    const r = await runContainerProbe(makeApp());
    expect(r.outcome).toBe("healthy");
    expect(r.containerStatus).toBe("healthy");
  });

  it("unhealthy → outcome=unhealthy", async () => {
    vi.mocked(sshPool.exec).mockResolvedValue({
      stdout: "unhealthy\n",
      stderr: "",
      exitCode: 0,
    });
    const r = await runContainerProbe(makeApp());
    expect(r.outcome).toBe("unhealthy");
  });

  it("starting → outcome=unhealthy with message", async () => {
    vi.mocked(sshPool.exec).mockResolvedValue({
      stdout: "starting",
      stderr: "",
      exitCode: 0,
    });
    const r = await runContainerProbe(makeApp());
    expect(r.outcome).toBe("unhealthy");
    expect(r.errorMessage).toMatch(/starting/);
  });

  it("no-container → outcome=error", async () => {
    vi.mocked(sshPool.exec).mockResolvedValue({
      stdout: "no-container\n",
      stderr: "",
      exitCode: 0,
    });
    const r = await runContainerProbe(makeApp());
    expect(r.outcome).toBe("error");
    expect(r.errorMessage).toMatch(/not found/);
  });

  it("ssh exec throw → outcome=error", async () => {
    vi.mocked(sshPool.exec).mockRejectedValue(new Error("ssh dropped"));
    const r = await runContainerProbe(makeApp());
    expect(r.outcome).toBe("error");
    expect(r.errorMessage).toBe("ssh dropped");
  });

  it("unknown status → outcome=unhealthy with verbatim status", async () => {
    vi.mocked(sshPool.exec).mockResolvedValue({
      stdout: "weird-state\n",
      stderr: "",
      exitCode: 0,
    });
    const r = await runContainerProbe(makeApp());
    expect(r.outcome).toBe("unhealthy");
    expect(r.containerStatus).toBe("weird-state");
  });
});
