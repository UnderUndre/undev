/** Feature 009 T037 — auto-retry reconciler 3-strike rule. Skipped pending harness. */
import { describe, it } from "vitest";
describe.skip("bootstrap reconciler (T037 — needs harness)", () => {
  it("disables auto-retry after 3 failures within 1h", () => {
    /* TODO: harness — seed 3 auto_retry events, run reconcile() */
  });
});
