/** Feature 009 T042 — PAT scope error → reconnect → retry. Skipped pending harness. */
import { describe, it } from "vitest";
describe.skip("bootstrap clone PAT failure (T042 — needs harness)", () => {
  it("simulates PAT scope insufficient → failed_clone → retry succeeds, no PAT leak", () => {
    /* TODO: harness — see tests/integration/bootstrap-pat-leak.test.ts for the
     * leak gate that's already passing. */
  });
});
