/**
 * Feature 012 T023 — PATCH volume ack matrix.
 *
 * Pending shared harness for `db` + `sshPool` + compose-yaml read.
 * Validation contract is covered by:
 *   tests/unit/blue-green-validator.test.ts
 *
 * Plan:
 *   1. fixture app with compose containing volumes
 *   2. PUT /api/apps/:id with deployStrategy=blue_green +
 *      acknowledgeVolumeSharing=false → 400 volume_sharing_unacknowledged
 *      with detected volumes in payload
 *   3. PUT with acknowledgeVolumeSharing=true → 200
 *   4. volume-less app with ack omitted → 200 (ack only required when
 *      volumes present)
 */
import { describe, it } from "vitest";

describe.skip("PATCH volume ack matrix (T023)", () => {
  it("ack=false rejects with 400 + detected volumes", () => {});
  it("ack=true accepts with 200", () => {});
  it("volume-less app needs no ack", () => {});
});
