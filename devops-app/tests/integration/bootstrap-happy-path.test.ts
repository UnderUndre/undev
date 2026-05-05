/**
 * Feature 009 T029 — full bootstrap happy-path integration.
 *
 * Skipped pending a shared mock harness for `db` + `sshPool` + `scriptsRunner`
 * (the existing `deploy.test.ts` mocks but doesn't expose them as fixtures).
 * The state-machine + redact + path-jail behaviour is covered by
 * `tests/unit/bootstrap-state-machine.test.ts`, `pat-redact.test.ts`,
 * `path-jail.test.ts`. This stub records the test plan.
 *
 *   1. POST /api/applications/bootstrap with a public-repo payload
 *   2. assert applications row inserted with bootstrap_state='init'
 *   3. let orchestrator run (mocked sshPool returns success per step)
 *   4. assert app_bootstrap_events rows form `init→cloning→compose_up→
 *      healthcheck→active` (5 rows for no-domain case)
 *   5. assert applications.current_commit populated from finalise
 *      stdout-json
 *   6. assert exactly one Telegram notify fired (active)
 */
import { describe, it } from "vitest";

describe.skip("bootstrap happy path (T029 — needs harness)", () => {
  it("INIT → ACTIVE end-to-end", () => {
    /* TODO: implement with shared harness */
  });
});
