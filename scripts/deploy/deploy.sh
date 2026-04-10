#!/bin/bash
# ─────────────────────────────────────────────────
# Zero-downtime deployment via SSH.
#
# Config (env vars or .env.production):
#   PROD_SSH_HOST     — SSH host alias or user@host
#   REMOTE_APP_DIR    — App directory on server (e.g., /home/deploy/myapp)
#   REMOTE_SCRIPT     — Server-side deploy script name (default: server-deploy.sh)
#
# Usage:
#   ./scripts/deploy/deploy.sh              # Full deploy with checks
#   ./scripts/deploy/deploy.sh --fast       # Skip all prompts
#   ./scripts/deploy/deploy.sh --skip-tests # Skip test step
# ─────────────────────────────────────────────────

source "$(dirname "$0")/../common.sh"
load_env ".env.production"

# Parse flags
SKIP_TESTS=false
FAST_MODE=false
for arg in "$@"; do
    case $arg in
        --skip-tests) SKIP_TESTS=true ;;
        --fast)       FAST_MODE=true; SKIP_TESTS=true ;;
        --yes)        YES=true ;;
        -h|--help)
            echo "Usage: deploy.sh [--fast] [--skip-tests] [--yes]"
            exit 0 ;;
    esac
done

# Required config
: "${PROD_SSH_HOST:?Set PROD_SSH_HOST in .env.production or env}"
: "${REMOTE_APP_DIR:?Set REMOTE_APP_DIR in .env.production or env}"
REMOTE_SCRIPT="${REMOTE_SCRIPT:-server-deploy.sh}"

BRANCH=$(git_branch)
COMMIT=$(git_commit)
VERSION=$(git_version)
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')

echo -e "${BLUE}================================${NC}"
echo -e "${BLUE}  Deploy to Production${NC}"
echo -e "${BLUE}================================${NC}"
echo ""
info "Branch:  $BRANCH"
info "Commit:  $COMMIT"
info "Version: $VERSION"
info "Host:    $PROD_SSH_HOST"
echo ""

notify_telegram "🚀 *Deploy Started*
👤 $(whoami)
🌿 $BRANCH ($COMMIT)
📦 v$VERSION"

# Pre-flight: SSH
step "Checking SSH connection..."
if ! ssh -q "$PROD_SSH_HOST" exit 2>/dev/null; then
    error "Cannot connect to $PROD_SSH_HOST"
    exit 1
fi
log "SSH OK"

# Pre-flight: Dirty working tree
if git_dirty; then
    warn "Working tree has uncommitted changes"
    if [[ "$FAST_MODE" != "true" ]]; then
        confirm "Deploy anyway?" || exit 1
    fi
fi

# Pre-flight: Tests
if [[ "$SKIP_TESTS" != "true" ]]; then
    step "Running validate..."
    npm run validate 2>&1 || { error "Validation failed"; exit 1; }
    log "Validation passed"
fi

# Push
step "Pushing to origin..."
git push origin "$BRANCH" 2>&1 || { error "Git push failed"; exit 1; }
log "Pushed"

# Deploy on server
step "Running remote deploy..."
ssh "$PROD_SSH_HOST" "cd $REMOTE_APP_DIR && bash scripts/$REMOTE_SCRIPT" 2>&1
DEPLOY_EXIT=$?

if [[ $DEPLOY_EXIT -eq 0 ]]; then
    log "Deploy successful"
    notify_telegram "✅ *Deploy Complete*
📦 v$VERSION ($COMMIT)
🌿 $BRANCH"
else
    error "Deploy failed (exit code $DEPLOY_EXIT)"
    notify_telegram "❌ *Deploy Failed*
📦 v$VERSION ($COMMIT)
⚠️ Exit code: $DEPLOY_EXIT"
    exit $DEPLOY_EXIT
fi
