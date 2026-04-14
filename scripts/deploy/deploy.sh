#!/bin/bash
# ─────────────────────────────────────────────────
# Idempotent deployment via SSH.
# First run: clone repo + setup env + build.
# Subsequent runs: pull + rebuild.
#
# Config (env vars or .env.production):
#   PROD_SSH_HOST     — SSH host alias or user@host
#   REMOTE_APP_DIR    — Root directory on server (e.g., /root/undev)
#   REMOTE_REPO_URL   — Git clone URL (default: origin URL)
#   APP_SUBDIR        — Subdirectory within repo for docker app (e.g., devops-app)
#   REMOTE_SCRIPT     — Server-side deploy script (default: docker compose)
#
# Usage:
#   ./scripts/deploy/deploy.sh              # Full deploy with checks
#   ./scripts/deploy/deploy.sh --fast       # Skip all prompts + tests
#   ./scripts/deploy/deploy.sh --skip-tests # Skip test step
#   ./scripts/deploy/deploy.sh --setup-only # Clone + env setup, no build
# ─────────────────────────────────────────────────

source "$(dirname "$0")/../common.sh"
load_env ".env.production"

# Parse flags
SKIP_TESTS=false
FAST_MODE=false
SETUP_ONLY=false
for arg in "$@"; do
    case $arg in
        --skip-tests) SKIP_TESTS=true ;;
        --fast)       FAST_MODE=true; SKIP_TESTS=true; YES=true ;;
        --yes)        YES=true ;;
        --setup-only) SETUP_ONLY=true ;;
        -h|--help)
            echo "Usage: deploy.sh [--fast] [--skip-tests] [--setup-only] [--yes]"
            echo ""
            echo "First deploy:  clones repo, runs env-setup, builds with docker compose"
            echo "Update deploy: pulls latest, rebuilds changed containers"
            echo ""
            echo "Flags:"
            echo "  --fast         Skip tests and prompts"
            echo "  --skip-tests   Skip local validation step"
            echo "  --setup-only   Clone + env setup only, don't build/start"
            echo "  --yes          Auto-confirm all prompts"
            exit 0 ;;
    esac
done

# Required config
: "${PROD_SSH_HOST:?Set PROD_SSH_HOST in .env.production or env}"
: "${REMOTE_APP_DIR:?Set REMOTE_APP_DIR in .env.production or env}"
REMOTE_REPO_URL="${REMOTE_REPO_URL:-$(git remote get-url origin 2>/dev/null)}"
APP_SUBDIR="${APP_SUBDIR:-}"

BRANCH=$(git_branch)
COMMIT=$(git_commit)
VERSION=$(git_version)

echo -e "${BLUE}================================${NC}"
echo -e "${BLUE}  Deploy to Production${NC}"
echo -e "${BLUE}================================${NC}"
echo ""
info "Branch:  $BRANCH"
info "Commit:  $COMMIT"
info "Version: $VERSION"
info "Host:    $PROD_SSH_HOST"
info "Remote:  $REMOTE_APP_DIR"
[[ -n "$APP_SUBDIR" ]] && info "App dir: $APP_SUBDIR"
echo ""

notify_telegram "🚀 *Deploy Started*
👤 $(whoami)
🌿 $BRANCH ($COMMIT)
📦 v$VERSION"

# ── Pre-flight ───────────────────────────────────

step "Checking SSH connection..."
if ! ssh -q "$PROD_SSH_HOST" exit 2>/dev/null; then
    error "Cannot connect to $PROD_SSH_HOST"
    exit 1
fi
log "SSH OK"

if git_dirty; then
    warn "Working tree has uncommitted changes"
    if [[ "$FAST_MODE" != "true" ]]; then
        confirm "Deploy anyway?" || exit 1
    fi
fi

if [[ "$SKIP_TESTS" != "true" ]]; then
    step "Running validate..."
    npm run validate 2>&1 || { error "Validation failed"; exit 1; }
    log "Validation passed"
fi

# ── Push ─────────────────────────────────────────

step "Pushing to origin..."
git push origin "$BRANCH" 2>&1 || { error "Git push failed"; exit 1; }
log "Pushed"

# ── Remote: detect fresh vs existing ─────────────

REPO_EXISTS=$(ssh "$PROD_SSH_HOST" "[[ -d '$REMOTE_APP_DIR/.git' ]] && echo yes || echo no")

if [[ "$REPO_EXISTS" == "no" ]]; then
    # ── First deploy: clone + setup ──────────────
    echo ""
    echo -e "${YELLOW}━━━ First Deploy: Setting Up ━━━${NC}"
    echo ""

    if [[ -z "$REMOTE_REPO_URL" ]]; then
        error "REMOTE_REPO_URL required for first deploy (no existing repo on server)"
        exit 1
    fi

    step "Cloning repository..."
    ssh "$PROD_SSH_HOST" "git clone --branch $BRANCH '$REMOTE_REPO_URL' '$REMOTE_APP_DIR'" 2>&1
    if [[ $? -ne 0 ]]; then
        error "Clone failed"
        exit 1
    fi
    log "Cloned to $REMOTE_APP_DIR"

    # Determine working directory for docker
    if [[ -n "$APP_SUBDIR" ]]; then
        WORK_DIR="$REMOTE_APP_DIR/$APP_SUBDIR"
    else
        WORK_DIR="$REMOTE_APP_DIR"
    fi

    # Check for .env.example and prompt env setup
    HAS_EXAMPLE=$(ssh "$PROD_SSH_HOST" "[[ -f '$WORK_DIR/.env.example' ]] && echo yes || echo no")
    if [[ "$HAS_EXAMPLE" == "yes" ]]; then
        HAS_ENV=$(ssh "$PROD_SSH_HOST" "[[ -f '$WORK_DIR/.env' ]] && echo yes || echo no")
        if [[ "$HAS_ENV" == "no" ]]; then
            warn ".env file missing in $WORK_DIR"

            if [[ "$FAST_MODE" == "true" ]]; then
                # Non-interactive: copy example with generated secrets
                step "Generating .env from .env.example..."
                ssh "$PROD_SSH_HOST" "cd '$REMOTE_APP_DIR' && bash scripts/deploy/env-setup.sh .env --app-dir '$WORK_DIR' --non-interactive --generate-secrets" 2>&1
                if [[ $? -eq 0 ]]; then
                    log "Generated .env (review and update secrets!)"
                    warn "Run 'ssh $PROD_SSH_HOST nano $WORK_DIR/.env' to set real values"
                else
                    warn "Auto env-setup failed, copy manually"
                fi
            else
                echo ""
                info "You need to create .env in $WORK_DIR on the server."
                info "Options:"
                echo -e "  ${CYAN}1${NC}) Run env-setup interactively via SSH now"
                echo -e "  ${CYAN}2${NC}) Copy .env.example and edit manually later"
                echo -e "  ${CYAN}3${NC}) Skip (I'll handle it myself)"
                echo ""
                read -rp "$(echo -e "${YELLOW}Choice [1]:${NC} ")" env_choice

                case "${env_choice:-1}" in
                    1)
                        step "Running env-setup on server..."
                        ssh -t "$PROD_SSH_HOST" "cd '$REMOTE_APP_DIR' && bash scripts/deploy/env-setup.sh .env --app-dir '$WORK_DIR'"
                        ;;
                    2)
                        ssh "$PROD_SSH_HOST" "cp '$WORK_DIR/.env.example' '$WORK_DIR/.env'"
                        warn "Copied .env.example → .env"
                        warn "Edit it: ssh $PROD_SSH_HOST nano $WORK_DIR/.env"
                        ;;
                    3)
                        warn "Skipping env setup. Create .env before starting the app."
                        ;;
                esac
            fi
        fi
    fi

    if [[ "$SETUP_ONLY" == "true" ]]; then
        log "Setup complete (--setup-only). Repo cloned, env configured."
        log "To start: ssh $PROD_SSH_HOST 'cd $WORK_DIR && docker compose up -d --build'"
        exit 0
    fi
else
    # ── Update deploy: pull latest ───────────────
    echo ""
    echo -e "${GREEN}━━━ Update Deploy ━━━${NC}"
    echo ""

    step "Pulling latest on server..."
    ssh "$PROD_SSH_HOST" "cd '$REMOTE_APP_DIR' && git fetch origin && git reset --hard origin/$BRANCH" 2>&1
    if [[ $? -ne 0 ]]; then
        error "Pull failed"
        exit 1
    fi
    log "Updated to latest"

    if [[ -n "$APP_SUBDIR" ]]; then
        WORK_DIR="$REMOTE_APP_DIR/$APP_SUBDIR"
    else
        WORK_DIR="$REMOTE_APP_DIR"
    fi

    # Check if .env needs updating (new keys in example)
    HAS_ENV=$(ssh "$PROD_SSH_HOST" "[[ -f '$WORK_DIR/.env' ]] && echo yes || echo no")
    if [[ "$HAS_ENV" == "no" ]]; then
        warn ".env missing! Run: ssh $PROD_SSH_HOST 'cd $REMOTE_APP_DIR && bash scripts/deploy/env-setup.sh .env --app-dir $WORK_DIR'"
        if [[ "$FAST_MODE" != "true" ]]; then
            confirm "Continue without .env?" || exit 1
        fi
    fi
fi

# ── Build & Start ────────────────────────────────

# Check for docker-compose in work dir
HAS_COMPOSE=$(ssh "$PROD_SSH_HOST" "[[ -f '$WORK_DIR/docker-compose.yml' ]] || [[ -f '$WORK_DIR/compose.yml' ]] && echo yes || echo no")

if [[ "$HAS_COMPOSE" == "yes" ]]; then
    step "Building and starting with Docker Compose..."
    ssh "$PROD_SSH_HOST" "cd '$WORK_DIR' && docker compose up -d --build --remove-orphans" 2>&1
    DEPLOY_EXIT=$?
else
    # Fallback: look for a custom deploy script
    REMOTE_SCRIPT="${REMOTE_SCRIPT:-server-deploy.sh}"
    if ssh "$PROD_SSH_HOST" "[[ -f '$REMOTE_APP_DIR/scripts/$REMOTE_SCRIPT' ]]" 2>/dev/null; then
        step "Running remote deploy script..."
        ssh "$PROD_SSH_HOST" "cd '$REMOTE_APP_DIR' && bash scripts/$REMOTE_SCRIPT" 2>&1
        DEPLOY_EXIT=$?
    else
        error "No docker-compose.yml or scripts/$REMOTE_SCRIPT found in $WORK_DIR"
        exit 1
    fi
fi

# ── Result ───────────────────────────────────────

echo ""
if [[ $DEPLOY_EXIT -eq 0 ]]; then
    log "Deploy successful"

    # Show running containers
    step "Container status:"
    ssh "$PROD_SSH_HOST" "cd '$WORK_DIR' && docker compose ps --format 'table {{.Name}}\t{{.Status}}\t{{.Ports}}' 2>/dev/null" 2>&1

    notify_telegram "✅ *Deploy Complete*
📦 v$VERSION ($COMMIT)
🌿 $BRANCH"
else
    error "Deploy failed (exit code $DEPLOY_EXIT)"

    # Show logs for debugging
    step "Recent logs:"
    ssh "$PROD_SSH_HOST" "cd '$WORK_DIR' && docker compose logs --tail=20 2>/dev/null" 2>&1

    notify_telegram "❌ *Deploy Failed*
📦 v$VERSION ($COMMIT)
⚠️ Exit code: $DEPLOY_EXIT"
    exit $DEPLOY_EXIT
fi
