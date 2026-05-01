#!/usr/bin/env bash
# Feature 009 / T018 — bootstrap step HEALTHCHECK.
#
# Polls `docker inspect --format '{{.State.Health.Status}}' <container>`
# until healthy or timeout. Skips silently when the service has no
# compose-defined healthcheck (FR-011 / feature 006 FR-028).
#
# Args:
#   --remote-path=<compose project dir>
#   --compose-path=<relative compose file path>
#   --service=<compose service name>
#   --timeout-seconds=<int; default 180>

set -euo pipefail
source "$(dirname "$0")/../common.sh" 2>/dev/null || true

REMOTE_PATH=""
COMPOSE_PATH="docker-compose.yml"
SERVICE=""
TIMEOUT_SECONDS=180

while [[ $# -gt 0 ]]; do
  case "$1" in
    --remote-path=*)     REMOTE_PATH="${1#--remote-path=}"; shift ;;
    --compose-path=*)    COMPOSE_PATH="${1#--compose-path=}"; shift ;;
    --service=*)         SERVICE="${1#--service=}"; shift ;;
    --timeout-seconds=*) TIMEOUT_SECONDS="${1#--timeout-seconds=}"; shift ;;
    --json)              shift ;;
    *) shift ;;
  esac
done

if [[ -z "$REMOTE_PATH" || -z "$SERVICE" ]]; then
  echo "missing required arg: --remote-path / --service" >&2
  exit 64
fi

cd "$REMOTE_PATH"

# Resolve the running container id for the service. `docker compose ps -q`
# returns one id per line — the bootstrap path uses single-replica
# services, so we take the first.
CONTAINER_ID=$(docker compose -f "$COMPOSE_PATH" ps -q "$SERVICE" 2>/dev/null | head -n1 || true)

if [[ -z "$CONTAINER_ID" ]]; then
  echo "no running container for service '$SERVICE'" >&2
  exit 1
fi

# Detect whether a healthcheck is defined. If absent, skip silently.
HAS_HEALTHCHECK=$(docker inspect --format '{{if .State.Health}}yes{{end}}' "$CONTAINER_ID" 2>/dev/null || true)
if [[ "$HAS_HEALTHCHECK" != "yes" ]]; then
  echo "service '$SERVICE' has no healthcheck — skipping per FR-011"
  exit 0
fi

DEADLINE=$(( $(date +%s) + TIMEOUT_SECONDS ))
SLEEP_SECONDS=2

while :; do
  STATUS=$(docker inspect --format '{{.State.Health.Status}}' "$CONTAINER_ID" 2>/dev/null || echo "unknown")
  case "$STATUS" in
    healthy)
      echo "service '$SERVICE' healthy"
      exit 0
      ;;
    unhealthy)
      echo "service '$SERVICE' unhealthy" >&2
      exit 2
      ;;
    starting|unknown|"")
      ;;
    *)
      echo "unexpected health status: $STATUS" >&2
      ;;
  esac

  NOW=$(date +%s)
  if (( NOW >= DEADLINE )); then
    echo "timeout waiting for service '$SERVICE' to become healthy (last status: $STATUS)" >&2
    exit 3
  fi
  sleep "$SLEEP_SECONDS"
done
