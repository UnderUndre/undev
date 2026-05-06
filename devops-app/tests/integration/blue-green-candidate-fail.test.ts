/**
 * Feature 012 T043 — candidate healthcheck fail rollback.
 *
 * Plan:
 *   1. fixture deploy_strategy='blue_green'; mock healthcheck to never go
 *      healthy
 *   2. trigger deploy → assert FAILED_CANDIDATE_HEALTHCHECK reached
 *   3. assert Caddy admin NEVER called (no upstream switch)
 *   4. assert candidate container removed
 *   5. assert active_color UNCHANGED in DB
 *   6. assert audit deploy.candidate_failed_rollback row written
 *   7. assert FailureCard renders with [Retry, EditConfig, ViewLog]
 */
import { describe, it } from "vitest";

describe.skip("candidate failure rollback (T043)", () => {
  it("traffic stays on outgoing; FailureCard mounted", () => {});
});
