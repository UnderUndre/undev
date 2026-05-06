/**
 * Feature 012 T056 — recreate strategy no-regression.
 *
 * Plan:
 *   1. fixture app with deploy_strategy='recreate' (default)
 *   2. trigger deploy → assert existing single-phase recreate flow runs
 *      unchanged (single docker compose up -d, no candidate spawn,
 *      no Caddy switch, no drain timer)
 *   3. compare result row vs golden snapshot from pre-feature-012 fixture
 */
import { describe, it } from "vitest";

describe.skip("recreate no regression (T056)", () => {
  it("recreate path bit-identical to pre-T029", () => {});
});
