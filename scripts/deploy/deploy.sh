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

# ── Sync & Push ──────────────────────────────────

step "Syncing with origin/$BRANCH..."
if ! git pull --rebase origin "$BRANCH" 2>&1; then
    error "Git pull --rebase failed. Resolve conflicts and retry."
    exit 1
fi
log "Synced"

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

    # ── Env setup: try local file first, then fallback ──
    HAS_REMOTE_ENV=$(ssh "$PROD_SSH_HOST" "[[ -f '$WORK_DIR/.env' ]] && echo yes || echo no")
    if [[ "$HAS_REMOTE_ENV" == "no" ]]; then
        warn ".env file missing in $WORK_DIR"

        # Determine local app dir
        if [[ -n "$APP_SUBDIR" ]]; then
            LOCAL_APP_DIR="$REPO_ROOT/$APP_SUBDIR"
        else
            LOCAL_APP_DIR="$REPO_ROOT"
        fi

        # Priority: .env.production > .env (local files to push to server)
        LOCAL_ENV=""
        if [[ -f "$LOCAL_APP_DIR/.env.production" ]]; then
            LOCAL_ENV="$LOCAL_APP_DIR/.env.production"
        elif [[ -f "$LOCAL_APP_DIR/.env" ]]; then
            LOCAL_ENV="$LOCAL_APP_DIR/.env"
        fi

        if [[ -n "$LOCAL_ENV" ]]; then
            step "Uploading $(basename "$LOCAL_ENV") → $WORK_DIR/.env"
            scp "$LOCAL_ENV" "$PROD_SSH_HOST:$WORK_DIR/.env" 2>&1
            if [[ $? -eq 0 ]]; then
                log "Uploaded local env file to server"
            else
                error "Failed to upload env file"
            fi
        elif [[ "$FAST_MODE" == "true" ]]; then
            # Non-interactive fallback: generate from example
            step "No local env file found, generating from .env.example..."
            ssh "$PROD_SSH_HOST" "cd '$REMOTE_APP_DIR' && bash scripts/deploy/env-setup.sh .env --app-dir '$WORK_DIR' --non-interactive --generate-secrets" 2>&1
            warn "Generated .env with random secrets — review: ssh $PROD_SSH_HOST nano $WORK_DIR/.env"
        else
            echo ""
            info "No local .env.production found in $LOCAL_APP_DIR"
            info "Options:"
            echo -e "  ${CYAN}1${NC}) Run env-setup interactively via SSH"
            echo -e "  ${CYAN}2${NC}) Copy .env.example and edit later"
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
                    warn "Copied .env.example → .env — edit: ssh $PROD_SSH_HOST nano $WORK_DIR/.env"
                    ;;
                3)
                    warn "Skipping env setup. Create .env before starting the app."
                    ;;
            esac
        fi
    else
        log "Remote .env exists"
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

    # Check if .env exists, upload local if missing
    HAS_ENV=$(ssh "$PROD_SSH_HOST" "[[ -f '$WORK_DIR/.env' ]] && echo yes || echo no")
    if [[ "$HAS_ENV" == "no" ]]; then
        warn ".env missing on server"

        if [[ -n "$APP_SUBDIR" ]]; then
            LOCAL_APP_DIR="$REPO_ROOT/$APP_SUBDIR"
        else
            LOCAL_APP_DIR="$REPO_ROOT"
        fi

        if [[ -f "$LOCAL_APP_DIR/.env.production" ]]; then
            step "Uploading local .env.production → server .env"
            scp "$LOCAL_APP_DIR/.env.production" "$PROD_SSH_HOST:$WORK_DIR/.env" 2>&1
            log "Uploaded"
        else
            warn "No local .env.production found either"
            if [[ "$FAST_MODE" != "true" ]]; then
                confirm "Continue without .env?" || exit 1
            fi
        fi
    fi
fi

# ── Trigger Server-Side Deploy (detached) ────────

# Find server-side deploy script (repo-level universal > app-level legacy)
REMOTE_SCRIPT=""
# 1. Universal: scripts/deploy/server-deploy.sh in repo root
if ssh "$PROD_SSH_HOST" "[[ -f '$REMOTE_APP_DIR/scripts/deploy/server-deploy.sh' ]]" 2>/dev/null; then
    REMOTE_SCRIPT="$REMOTE_APP_DIR/scripts/deploy/server-deploy.sh"
fi
# 2. Fallback: app-level scripts/server-deploy.sh
if [[ -z "$REMOTE_SCRIPT" ]] && [[ -n "$APP_SUBDIR" ]]; then
    if ssh "$PROD_SSH_HOST" "[[ -f '$WORK_DIR/scripts/server-deploy.sh' ]]" 2>/dev/null; then
        REMOTE_SCRIPT="$WORK_DIR/scripts/server-deploy.sh"
    fi
fi

if [[ -z "$REMOTE_SCRIPT" ]]; then
    error "No server-deploy.sh found in $REMOTE_APP_DIR/scripts/deploy/ or $WORK_DIR/scripts/"
    exit 1
fi

step "Making deploy script executable..."
ssh "$PROD_SSH_HOST" "chmod +x '$REMOTE_SCRIPT'"

step "Triggering remote deployment (detached)..."
info "Even if you disconnect, deployment will continue on the server."
echo ""

# Run via nohup — pass --app-dir for universal script
ssh -f "$PROD_SSH_HOST" "nohup bash '$REMOTE_SCRIPT' --app-dir '$WORK_DIR' --repo-dir '$REMOTE_APP_DIR' > '$WORK_DIR/deploy.log' 2>&1 < /dev/null &"

# ── Result ───────────────────────────────────────

echo ""
echo -e "${GREEN}================================${NC}"
log "Deployment triggered successfully!"
echo -e "${GREEN}================================${NC}"
echo ""
info "Branch:  $BRANCH"
info "Commit:  $COMMIT"
info "Version: $VERSION"
echo ""
info "To watch progress:"
echo -e "  ${CYAN}ssh $PROD_SSH_HOST 'tail -f $WORK_DIR/deploy.log'${NC}"
echo ""
info "To check status:"
echo -e "  ${CYAN}ssh $PROD_SSH_HOST 'cd $WORK_DIR && docker compose ps'${NC}"
