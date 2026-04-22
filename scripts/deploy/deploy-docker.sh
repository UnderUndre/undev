#!/usr/bin/env bash
# Feature 005: docker-compose deploy wrapper.
#
# Args (parsed from the manifest-driven serialiser):
#   --remote-path=<dir>   — target directory containing docker-compose.yml
#   --branch=<name>       — optional, ignored for pure docker apps
#   --commit=<sha>        — optional, ignored for pure docker apps
#
# Flow: cd into the target, pull latest images, recreate containers with
# --remove-orphans to clean up anything that was deleted from compose.

set -euo pipefail

source "$(dirname "$0")/../common.sh"

REMOTE_PATH=""
for arg in "$@"; do
  case "$arg" in
    --remote-path=*) REMOTE_PATH="${arg#--remote-path=}" ;;
    --branch=*)       ;; # ignored — pure docker flow
    --commit=*)       ;; # ignored
    *) log_warn "Unknown flag: $arg" ;;
  esac
done

if [ -z "$REMOTE_PATH" ]; then
  log_error "--remote-path is required"
  exit 2
fi

cd "$REMOTE_PATH"
log_info "Pulling images in $REMOTE_PATH"
docker compose pull
log_info "Bringing stack up (orphans preserved — run --remove-orphans manually if needed)"
docker compose up -d
log_info "Done"
