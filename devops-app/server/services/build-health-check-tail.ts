/**
 * Feature 006 T031 — wait-for-healthy bash tail builder.
 *
 * Pure function. Returns a bash heredoc snippet appended to the transported
 * deploy script (R-009). Polls `docker inspect` every 5s until the container
 * is healthy / unhealthy / timeout. Exit codes:
 *   0   → healthy (success)
 *   1   → unhealthy reported by docker inspect (failed)
 *   124 → timeout (matches GNU `timeout` convention)
 *
 * FR-028: containers WITHOUT a defined healthcheck silently skip — `exit 0`.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * DEADLOCK-AVOIDANCE CONTRACT (T061, 2026-04-28 Gemini edge case):
 * waitForHealthy is a target-side bash tail using raw 'docker inspect'. It
 * MUST NOT call back to the dashboard's Node-side probe runner. See spec 006
 * Edge Case "waitForHealthy deploy gate must NOT depend on the dashboard's
 * probe lock" for rationale — a future "consolidate probe code" refactor that
 * routes this gate through the Node probe runner reintroduces the FR-011 vs
 * FR-024 deadlock.
 * ─────────────────────────────────────────────────────────────────────────
 */

import { shQuote } from "../lib/sh-quote.js";

export interface BuildHealthCheckTailInput {
  container: string;
  timeoutMs: number;
}

export function buildHealthCheckTail(input: BuildHealthCheckTailInput): string {
  const { container, timeoutMs } = input;
  const tSec = Math.ceil(timeoutMs / 1000);
  const quoted = shQuote(container);
  return [
    "# Feature 006 wait-for-healthy gate",
    `__WFH_CONTAINER=${quoted}`,
    `__WFH_DEADLINE=$(( $(date +%s) + ${tSec} ))`,
    "",
    "# FR-028 — silently skip when no healthcheck defined",
    `__WFH_HAS_HC=$(docker inspect --format '{{if .State.Health}}1{{else}}0{{end}}' "$__WFH_CONTAINER" 2>/dev/null || echo 0)`,
    `if [ "$__WFH_HAS_HC" != "1" ]; then`,
    `  echo "[wait-for-healthy] container has no healthcheck; skipping"`,
    `  exit 0`,
    `fi`,
    "",
    "while true; do",
    `  __WFH_STATUS=$(docker inspect --format '{{.State.Health.Status}}' "$__WFH_CONTAINER" 2>/dev/null || echo missing)`,
    `  case "$__WFH_STATUS" in`,
    `    healthy)   echo "[wait-for-healthy] container healthy"; exit 0 ;;`,
    `    unhealthy) echo "[wait-for-healthy] healthcheck reported unhealthy"; exit 1 ;;`,
    `    starting)  ;;`,
    `    *)         echo "[wait-for-healthy] healthcheck failed (status: $__WFH_STATUS)"; exit 1 ;;`,
    `  esac`,
    `  if [ "$(date +%s)" -ge "$__WFH_DEADLINE" ]; then`,
    `    echo "[wait-for-healthy] timeout waiting for healthy"`,
    `    exit 124`,
    `  fi`,
    `  sleep 5`,
    "done",
    "",
  ].join("\n");
}
