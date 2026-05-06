/**
 * Feature 012 T057 — strategy switch lifecycle.
 *
 * Plan:
 *   1. start with recreate
 *   2. PATCH (PUT) to blue_green (no deploy yet) — assert active_color
 *      stays NULL, deploy_state stays NULL
 *   3. deploy → first-deploy rename ritual fires, active_color = 'blue' →
 *      flips after deploy
 *   4. PATCH (PUT) back to recreate — assert active_color cleared to NULL
 *      on save
 */
import { describe, it } from "vitest";

describe.skip("strategy switch lifecycle (T057)", () => {
  it("recreate ↔ blue_green round trips correctly", () => {});
});
