#!/bin/bash
# ─────────────────────────────────────────────────
# Docker cleanup: dangling images, stopped containers, unused volumes.
#
# Usage:
#   ./scripts/docker/cleanup.sh          # Safe cleanup (dangling only)
#   ./scripts/docker/cleanup.sh --all    # Aggressive (all unused)
# ─────────────────────────────────────────────────

source "$(dirname "$0")/../common.sh"

require_cmd docker

MODE="${1:---safe}"

echo -e "${BLUE}=== Docker Cleanup ===${NC}"

case "$MODE" in
    --all)
        warn "Aggressive mode: removing ALL unused images, containers, volumes, networks"
        confirm "This will free significant space but may remove cached build layers. Continue?" || exit 0

        step "Removing stopped containers..."
        docker container prune -f

        step "Removing unused images (all)..."
        docker image prune -a -f

        step "Removing unused volumes..."
        docker volume prune -f

        step "Removing unused networks..."
        docker network prune -f
        ;;
    --safe|*)
        step "Removing dangling images..."
        docker image prune -f

        step "Removing stopped containers..."
        docker container prune -f

        step "Removing dangling volumes..."
        docker volume prune -f
        ;;
esac

echo ""
info "Space usage after cleanup:"
docker system df
