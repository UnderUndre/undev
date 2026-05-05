/** Feature 009 T052 — hard-delete ordering + jail-escape rejection. Partial coverage via path-jail.test.ts. Skipped pending harness. */
import { describe, it } from "vitest";
describe.skip("bootstrap hard-delete (T052 — needs harness)", () => {
  it("typed-confirm enforced server-side, FR-021 ordering", () => {
    /* TODO — jail escape rejection covered by tests/unit/path-jail.test.ts */
  });
});
