/**
 * Feature 012 T054 — restart-recovery panel.
 *
 * NOTE: orchestrator's fire-and-forget runHappyPath cannot be re-attached
 * after dashboard restart. Operator's working recovery actions in this
 * iteration: `abort-cleanup` and `mark-complete`. `resume` route exists
 * but delegates to a fresh startDeploy — full state-resume is a v2 task.
 *
 * Plan:
 *   1. fixture row with deploy_state='OUTGOING_DRAINING' +
 *      deploy_state_started_at
 *   2. mock containers: candidate running, outgoing running; caddy reachable
 *   3. boot dashboard → scanAtBoot() populates cache
 *   4. GET /interrupted-deploys → returns the row
 *   5. test (a) POST /interrupted/resume → fresh deploy starts
 *   6. test (b) POST /interrupted/abort-cleanup → candidate removed,
 *      deploy_state cleared, active_color unchanged
 *   7. test (c) POST /interrupted/mark-complete → active_color set,
 *      deploy_state cleared
 */
import { describe, it } from "vitest";

describe.skip("restart recovery (T054)", () => {
  it("scan + 3 operator paths", () => {});
});
