/** Feature 011 T041 — env-vars-store pure-fn invariants. */
import { describe, it, expect } from "vitest";
import { detectPlaceholders } from "../../server/services/env-vars-store.js";

describe("env-vars-store / detectPlaceholders", () => {
  it("flags bare CHANGE_ME", () => {
    expect(detectPlaceholders({ FOO: "CHANGE_ME" })).toEqual(["FOO"]);
  });

  it("flags suffixed CHANGE_ME_FOO style", () => {
    expect(detectPlaceholders({ JWT_SECRET: "CHANGE_ME_TOKEN" })).toEqual([
      "JWT_SECRET",
    ]);
  });

  it("is case-insensitive (regression: real .env.example files)", () => {
    expect(detectPlaceholders({ A: "change_me", B: "Change_Me_Foo" })).toEqual([
      "A",
      "B",
    ]);
  });

  it("does not flag legitimate values that contain CHANGE_ME as substring", () => {
    expect(
      detectPlaceholders({ NOTES: "remember to CHANGE_ME later" }),
    ).toEqual([]);
  });

  it("returns empty list when nothing matches", () => {
    expect(detectPlaceholders({ FOO: "real-value", BAR: "abc123" })).toEqual(
      [],
    );
  });

  it("preserves key order", () => {
    const vars = { A: "CHANGE_ME", B: "ok", C: "CHANGE_ME_X", D: "ok" };
    expect(detectPlaceholders(vars)).toEqual(["A", "C"]);
  });
});
