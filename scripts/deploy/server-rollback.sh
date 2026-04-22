#!/usr/bin/env bash
# Target-side rollback. Runs on the prod server via SSH-stdin from the
# devops-app scripts-runner.
#
# Args:
#   --app-dir <path>   App directory with docker-compose.yml (required)
#   --commit <sha>     Commit to reset --hard to (required)
#
# Flow: cd → git fetch → git reset --hard <commit> → docker compose up -d
# Does NOT source ../common.sh — that path is runtime-concat'd by the runner.

set -euo pipefail

APP_DIR=""
COMMIT=""
while [[ $# -gt 0 ]]; do
    case $1 in
        --app-dir)     APP_DIR="$2"; shift 2 ;;
        --app-dir=*)   APP_DIR="${1#--app-dir=}"; shift ;;
        --commit)      COMMIT="$2"; shift 2 ;;
        --commit=*)    COMMIT="${1#--commit=}"; shift ;;
        *) echo "[rollback] Unknown arg: $1" >&2; shift ;;
    esac
done

if [[ -z "$APP_DIR" ]]; then
    echo "[rollback] --app-dir is required" >&2
    exit 2
fi
if [[ -z "$COMMIT" ]]; then
    echo "[rollback] --commit is required" >&2
    exit 2
fi

cd "$APP_DIR"

if ! git rev-parse --git-dir > /dev/null 2>&1; then
    echo "[rollback] $APP_DIR is not a git repository" >&2
    exit 2
fi

echo "[rollback] Fetching origin"
git -c safe.directory='*' fetch --quiet origin

echo "[rollback] Resetting to $COMMIT"
git -c safe.directory='*' reset --hard "$COMMIT"

COMPOSE_FILE=""
if [[ -f "docker-compose.yml" ]]; then
    COMPOSE_FILE="docker-compose.yml"
elif [[ -f "compose.yml" ]]; then
    COMPOSE_FILE="compose.yml"
fi

if [[ -n "$COMPOSE_FILE" ]]; then
    echo "[rollback] docker compose up -d"
    docker compose up -d --remove-orphans
else
    echo "[rollback] No compose file in $APP_DIR — skipping container restart"
fi

echo "[rollback] Done — $APP_DIR @ $(git rev-parse --short HEAD)"
