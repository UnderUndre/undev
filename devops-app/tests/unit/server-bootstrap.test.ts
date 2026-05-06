/**
 * Feature 011 T032 — server-bootstrap pure-validation tests.
 *
 * Full state-machine assertions live in the integration test (T033) where
 * the DB + scriptsRunner + jobManager all run real. The unit-level test
 * here just exercises the InvalidStateError surface and module shape.
 */
import { describe, it, expect } from "vitest";
import {
  InvalidStateError,
} from "../../server/services/server-bootstrap.js";

describe("server-bootstrap", () => {
  it("InvalidStateError carries the offending state", () => {
    const e = new InvalidStateError("initialising");
    expect(e.state).toBe("initialising");
    expect(e.message).toContain("initialising");
  });

  it("module exports the public function", async () => {
    const mod = await import(
      "../../server/services/server-bootstrap.js"
    );
    expect(typeof mod.initialiseServer).toBe("function");
  });
});
