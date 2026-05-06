/**
 * Feature 012 T052 — abort during drain.
 *
 * Plan:
 *   1. drive deploy to OUTGOING_DRAINING phase
 *   2. POST /abort with mismatched confirmAppName → 400
 *   3. POST with correct confirmAppName → 200
 *   4. assert Caddy admin called with revert config
 *   5. assert candidate stopped + removed
 *   6. assert deploy_state → null
 *   7. assert audit deploy.aborted emitted
 */
import { describe, it } from "vitest";

describe.skip("abort during drain (T052)", () => {
  it("typed-confirm mismatch → 400, correct → 200", () => {});
});
