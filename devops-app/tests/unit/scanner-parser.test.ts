import { describe, it, expect } from "vitest";
import { parseScanOutput } from "../../server/services/scanner-parser.js";

function lines(...ls: string[]): string {
  return ls.join("\n");
}

describe("parseScanOutput", () => {
  describe("TOOL availability", () => {
    it("reads git/docker flags", () => {
      const out = parseScanOutput(lines("TOOL\tgit\tyes", "TOOL\tdocker\tno"));
      expect(out.gitAvailable).toBe(true);
      expect(out.dockerAvailable).toBe(false);
    });

    it("defaults to false when TOOL lines missing", () => {
      const out = parseScanOutput("");
      expect(out.gitAvailable).toBe(false);
      expect(out.dockerAvailable).toBe(false);
    });
  });

  describe("tri-state dirty", () => {
    it("returns 'dirty' when GIT_DIRTY emitted", () => {
      const out = parseScanOutput(
        lines("GIT_BRANCH\t/opt/a\tmain", "GIT_DIRTY\t/opt/a\t1"),
      );
      expect(out.git[0].dirty).toBe("dirty");
    });

    it("returns 'clean' when no GIT_DIRTY and no status error", () => {
      const out = parseScanOutput(lines("GIT_BRANCH\t/opt/a\tmain"));
      expect(out.git[0].dirty).toBe("clean");
    });

    it("returns 'unknown' when GIT_ERROR for status", () => {
      const out = parseScanOutput(
        lines("GIT_BRANCH\t/opt/a\tmain", "GIT_ERROR\t/opt/a\tstatus"),
      );
      expect(out.git[0].dirty).toBe("unknown");
    });
  });

  describe("detached HEAD", () => {
    it("sets detached=true on DETACHED marker", () => {
      const out = parseScanOutput(lines("GIT_BRANCH\t/opt/a\tDETACHED"));
      expect(out.git[0].detached).toBe(true);
      expect(out.git[0].branch).toBe("");
    });

    it("keeps detached=false on named branch", () => {
      const out = parseScanOutput(lines("GIT_BRANCH\t/opt/a\tfeature/x"));
      expect(out.git[0].detached).toBe(false);
      expect(out.git[0].branch).toBe("feature/x");
    });
  });

  describe("compose candidates", () => {
    it("collects COMPOSE lines with extras CSV split", () => {
      const out = parseScanOutput(
        lines(
          "COMPOSE\t/srv/a/docker-compose.yml\t/srv/a/docker-compose.override.yml,/srv/a/docker-compose.prod.yml",
        ),
      );
      expect(out.compose[0].primaryPath).toBe("/srv/a/docker-compose.yml");
      expect(out.compose[0].extraPaths).toEqual([
        "/srv/a/docker-compose.override.yml",
        "/srv/a/docker-compose.prod.yml",
      ]);
    });

    it("attaches services from COMPOSE_CONFIG (base64 JSON)", () => {
      const config = JSON.stringify({
        services: {
          api: { image: "ghcr.io/x/api:1" },
          db: { image: "postgres:16" },
        },
      });
      const b64 = Buffer.from(config).toString("base64");
      const out = parseScanOutput(
        lines(
          "COMPOSE\t/srv/a/docker-compose.yml\t",
          `COMPOSE_CONFIG\t/srv/a/docker-compose.yml\t${b64}`,
        ),
      );
      const services = out.compose[0].services;
      expect(services).toHaveLength(2);
      expect(services.find((s) => s.name === "api")?.image).toBe("ghcr.io/x/api:1");
      expect(services.find((s) => s.name === "db")?.image).toBe("postgres:16");
    });

    it("falls back to services:[] when COMPOSE_CONFIG is missing", () => {
      const out = parseScanOutput(lines("COMPOSE\t/srv/a/docker-compose.yml\t"));
      expect(out.compose[0].services).toEqual([]);
    });

    it("tolerates malformed base64 / JSON", () => {
      const out = parseScanOutput(
        lines(
          "COMPOSE\t/srv/a/docker-compose.yml\t",
          "COMPOSE_CONFIG\t/srv/a/docker-compose.yml\tnot-base64-!@#$",
        ),
      );
      expect(out.compose[0].services).toEqual([]);
    });
  });

  describe("robustness", () => {
    it("handles CRLF line endings", () => {
      const out = parseScanOutput("TOOL\tgit\tyes\r\nGIT_BRANCH\t/opt/a\tmain\r\n");
      expect(out.git).toHaveLength(1);
    });

    it("ignores empty lines and unknown tags", () => {
      const out = parseScanOutput(
        "\nTOOL\tgit\tyes\nUNKNOWN\tgarbage\n\nGIT_BRANCH\t/opt/a\tmain\n",
      );
      expect(out.git).toHaveLength(1);
    });

    it("tolerates truncated line mid-stream", () => {
      const out = parseScanOutput("TOOL\tgit\tyes\nGIT_BRANCH\t/opt/a"); // missing branch value
      // Parser shouldn't crash; no GIT_BRANCH value → candidate may or may not
      // be created, but no exception should be thrown.
      expect(out.gitAvailable).toBe(true);
    });
  });

  describe("containers", () => {
    it("parses docker ps JSON rows", () => {
      const row = JSON.stringify({
        Names: "stack_api_1",
        Image: "ghcr.io/x/api:1",
        State: "running",
        Status: "Up 2 hours",
        Labels: "com.docker.compose.project=stack,other=1",
      });
      const out = parseScanOutput(`TOOL\tdocker\tyes\nCONTAINER\t${row}`);
      expect(out.containers).toHaveLength(1);
      expect(out.containers[0].name).toBe("stack_api_1");
      expect(out.containers[0].labels["com.docker.compose.project"]).toBe("stack");
    });
  });
});
