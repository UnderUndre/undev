/**
 * Feature 012 T044 — Caddy admin failure BEFORE switch.
 *
 * Plan:
 *   1. compose healthcheck passes
 *   2. caddy-admin-client POST /load returns 500
 *   3. trigger deploy → state reaches CANDIDATE_HEALTHY → SWITCHING →
 *      FAILED_SWITCH
 *   4. assert traffic stays on outgoing throughout
 *   5. assert candidate cleaned up
 *   6. assert audit deploy.caddy_admin_failure_pre_switch emitted
 */
import { describe, it } from "vitest";

describe.skip("caddy failure pre-switch (T044)", () => {
  it("FAILED_SWITCH; outgoing intact", () => {});
});
