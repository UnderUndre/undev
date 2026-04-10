#!/bin/bash
# ─────────────────────────────────────────────────
# Rollback to previous deployment.
#
# Config: PROD_SSH_HOST, REMOTE_APP_DIR (same as deploy.sh)
#
# Usage:
#   ./scripts/deploy/rollback.sh           # Rollback to previous
#   ./scripts/deploy/rollback.sh <commit>  # Rollback to specific commit
# ─────────────────────────────────────────────────

source "$(dirname "$0")/../common.sh"
load_env ".env.production"

: "${PROD_SSH_HOST:?Set PROD_SSH_HOST}"
: "${REMOTE_APP_DIR:?Set REMOTE_APP_DIR}"

TARGET_COMMIT="${1:-}"

echo -e "${YELLOW}================================${NC}"
echo -e "${YELLOW}  Rollback Production${NC}"
echo -e "${YELLOW}================================${NC}"
echo ""

if [[ -n "$TARGET_COMMIT" ]]; then
    info "Rolling back to commit: $TARGET_COMMIT"
else
    info "Rolling back to previous deployment"
fi

confirm "Are you sure you want to rollback production?" || exit 0

notify_telegram "⚠️ *Rollback Started*
👤 $(whoami)
🎯 ${TARGET_COMMIT:-previous}"

step "Running remote rollback..."
if [[ -n "$TARGET_COMMIT" ]]; then
    ssh "$PROD_SSH_HOST" "cd $REMOTE_APP_DIR && git fetch && git checkout $TARGET_COMMIT && npm ci --production && pm2 restart all"
else
    ssh "$PROD_SSH_HOST" "cd $REMOTE_APP_DIR && git checkout HEAD~1 && npm ci --production && pm2 restart all"
fi

log "Rollback complete"
notify_telegram "✅ *Rollback Complete*
🎯 ${TARGET_COMMIT:-previous deployment}"
