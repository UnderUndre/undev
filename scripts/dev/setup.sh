#!/bin/bash
# ─────────────────────────────────────────────────
# Local dev environment setup.
# Run after cloning a project to get up and running.
#
# What it does:
#   1. Check Node.js version
#   2. Install dependencies
#   3. Copy .env.example → .env (if missing)
#   4. Run DB migrations (if drizzle detected)
#   5. Verify build
#
# Usage:
#   ./scripts/dev/setup.sh
# ─────────────────────────────────────────────────

source "$(dirname "$0")/../common.sh"

echo -e "${BLUE}=== Dev Environment Setup ===${NC}"
echo ""

# 1. Node.js version check
step "Checking Node.js..."
require_cmd node npm
NODE_VERSION=$(node -v | tr -d 'v')
NODE_MAJOR=${NODE_VERSION%%.*}
if [[ $NODE_MAJOR -lt 20 ]]; then
    error "Node.js 20+ required (found: $NODE_VERSION)"
    info "Install via: nvm install 20"
    exit 1
fi
log "Node.js $NODE_VERSION"

# 2. Dependencies
step "Installing dependencies..."
if [[ -f "$REPO_ROOT/package-lock.json" ]]; then
    npm ci --silent
elif [[ -f "$REPO_ROOT/pnpm-lock.yaml" ]]; then
    require_cmd pnpm
    pnpm install --frozen-lockfile
elif [[ -f "$REPO_ROOT/yarn.lock" ]]; then
    require_cmd yarn
    yarn install --frozen-lockfile
else
    npm install
fi
log "Dependencies installed"

# 3. Environment file
if [[ -f "$REPO_ROOT/.env.example" ]] && [[ ! -f "$REPO_ROOT/.env" ]]; then
    step "Creating .env from .env.example..."
    cp "$REPO_ROOT/.env.example" "$REPO_ROOT/.env"
    warn "Edit .env with your local values before starting"
else
    log ".env already exists"
fi

# 4. DB migrations (if drizzle config found)
if [[ -f "$REPO_ROOT/drizzle.config.ts" ]] || [[ -f "$REPO_ROOT/drizzle.config.js" ]]; then
    step "Running DB migrations..."
    npm run db:push 2>/dev/null || warn "DB push failed (is database running?)"
fi

# 5. Build check
step "Checking build..."
npm run build 2>&1 || { warn "Build has issues (non-fatal for dev)"; }

echo ""
log "Setup complete! Run 'npm run dev' to start."
