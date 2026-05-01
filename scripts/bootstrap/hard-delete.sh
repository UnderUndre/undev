#!/usr/bin/env bash
# Feature 009 / T050 — hard-delete cleanup, dangerLevel: high.
#
# Order per FR-021 (cert revoke is orchestrator-side, before this script):
#   1. `readlink -f || realpath` jail check inline (R-008)
#   2. `docker compose down -v` to stop containers and remove named volumes
#   3. `rm -rf $RESOLVED` — only if the resolved path is under the jail
#
# Args:
#   --remote-path=<absolute path on target>
#   --compose-path=<relative compose file path; default docker-compose.yml>
#   --jail-root=<absolute jail root, e.g. /home/deploy/apps>
#
# Exit codes:
#   0 — cleanup completed
#   4 — jail escape detected (resolved path outside jail-root); no destructive op fired
#   ≠0 — docker / rm failures (partial cleanup, surfaced via stderr)

set -euo pipefail
source "$(dirname "$0")/../common.sh" 2>/dev/null || true

REMOTE_PATH=""
COMPOSE_PATH="docker-compose.yml"
JAIL_ROOT=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --remote-path=*)  REMOTE_PATH="${1#--remote-path=}"; shift ;;
    --compose-path=*) COMPOSE_PATH="${1#--compose-path=}"; shift ;;
    --jail-root=*)    JAIL_ROOT="${1#--jail-root=}"; shift ;;
    --json)           shift ;;
    *) shift ;;
  esac
done

if [[ -z "$REMOTE_PATH" || -z "$JAIL_ROOT" ]]; then
  echo "missing required arg: --remote-path / --jail-root" >&2
  exit 64
fi

# Normalise jail root with trailing slash — prevents /home/deploy/apps2
# matching /home/deploy/apps prefix.
JAIL_ROOT_TRIMMED="${JAIL_ROOT%/}"

RESOLVED=""
if [[ -e "$REMOTE_PATH" ]]; then
  RESOLVED=$(readlink -f "$REMOTE_PATH" 2>/dev/null || realpath "$REMOTE_PATH" 2>/dev/null || true)
fi

if [[ -z "$RESOLVED" ]]; then
  # Path doesn't exist on disk — nothing to delete. This is non-fatal:
  # the dashboard row stays; orchestrator will DELETE it.
  echo "remote path absent on target; skipping filesystem cleanup"
  exit 0
fi

# Jail check — STRICT subdirectory only.
# REJECT both:
#   (a) paths outside the jail (`/etc/passwd`, `/tmp/...`)
#   (b) the jail root itself (`/home/deploy/apps`) — without this guard a
#       symlink trick or misconfig could rm the whole apps dir.
# Allow only `$JAIL_ROOT_TRIMMED/<something>`, i.e. proper children.
if [[ "$RESOLVED" != "$JAIL_ROOT_TRIMMED"/* ]]; then
  echo "JAIL_ESCAPE: resolved=$RESOLVED jail=$JAIL_ROOT_TRIMMED" >&2
  exit 4
fi

# Compose down -v — best-effort; missing compose file is non-fatal.
if [[ -f "$RESOLVED/$COMPOSE_PATH" ]]; then
  ( cd "$RESOLVED" && docker compose -f "$COMPOSE_PATH" down -v --remove-orphans ) || \
    echo "warning: docker compose down failed; proceeding with rm" >&2
fi

# rm -rf — guaranteed under jail at this point.
rm -rf -- "$RESOLVED"

echo "removed: $RESOLVED"
