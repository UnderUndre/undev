#!/usr/bin/env bash
# Feature 009 / T017 — bootstrap step COMPOSE_UP.
#
# Runs `docker compose up -d` against the target's working tree. Idempotent
# by design — Docker compose recreates only diverged services.
#
# Args:
#   --remote-path=<dir containing the compose file>
#   --compose-path=<relative path inside remote-path; default docker-compose.yml>

set -euo pipefail
source "$(dirname "$0")/../common.sh" 2>/dev/null || true

REMOTE_PATH=""
COMPOSE_PATH="docker-compose.yml"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --remote-path=*)  REMOTE_PATH="${1#--remote-path=}"; shift ;;
    --compose-path=*) COMPOSE_PATH="${1#--compose-path=}"; shift ;;
    --json)           shift ;;
    *) shift ;;
  esac
done

if [[ -z "$REMOTE_PATH" ]]; then
  echo "missing required arg: --remote-path" >&2
  exit 64
fi

cd "$REMOTE_PATH"
docker compose -f "$COMPOSE_PATH" up -d --remove-orphans
