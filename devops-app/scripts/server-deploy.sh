#!/bin/bash
# ─────────────────────────────────────────────────
# Server-side deployment script for DevOps Dashboard.
# Runs ON the server — survives SSH disconnect via nohup.
#
# What it does:
#   1. Acquire deploy lock
#   2. Pull latest code
#   3. Build Docker images
#   4. docker compose up (recreate changed containers)
#   5. Health check
#   6. Cleanup old images
#   7. Telegram notification
#
# Usage (triggered by deploy.sh, not run manually):
#   nohup bash server-deploy.sh > deploy.log 2>&1 &
# ─────────────────────────────────────────────────

set -e

# ── Config ───────────────────────────────────────

# Resolve paths relative to this script's location
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(dirname "$SCRIPT_DIR")"
REPO_DIR="$(dirname "$APP_DIR")"

LOCKFILE="/tmp/devops-dashboard-deploy.lock"
LOG_FILE="$APP_DIR/deploy.log"
DEPLOY_SUCCESS=false

# Ensure log file exists
touch "$LOG_FILE" 2>/dev/null || true

# Redirect stdout+stderr to log (and console if TTY attached)
if [ -t 1 ]; then
    exec > >(tee -a "$LOG_FILE") 2>&1
else
    exec >> "$LOG_FILE" 2>&1
fi

# ── Telegram ─────────────────────────────────────

send_telegram() {
    local message="$1"
    local env_file="$APP_DIR/.env"

    if [ -f "$env_file" ]; then
        local token=$(grep "^TELEGRAM_BOT_TOKEN=" "$env_file" | cut -d'=' -f2- | tr -d '\r')
        local chat_id=$(grep "^TELEGRAM_CHAT_ID=" "$env_file" | cut -d'=' -f2- | tr -d '\r')

        if [ -n "$token" ] && [ -n "$chat_id" ]; then
            curl -s -f -X POST "https://api.telegram.org/bot${token}/sendMessage" \
                --data-urlencode "chat_id=${chat_id}" \
                --data-urlencode "text=${message}" \
                --data-urlencode "parse_mode=Markdown" > /dev/null 2>&1 || true
        fi
    fi
}

# ── Deploy Lock ──────────────────────────────────

if [ -f "$LOCKFILE" ]; then
    OLDPID=$(cat "$LOCKFILE")
    if ps -p "$OLDPID" > /dev/null 2>&1; then
        echo "❌ Another deployment (PID $OLDPID) is already running!"
        send_telegram "⚠️ *DevOps Dashboard Deploy Blocked*
Another deployment is already in progress."
        exit 1
    else
        echo "⚠️ Stale lock for PID $OLDPID — removing"
        rm -f "$LOCKFILE"
    fi
fi
echo $$ > "$LOCKFILE"

# ── Cleanup Trap ─────────────────────────────────

cleanup() {
    if [ "$DEPLOY_SUCCESS" = false ]; then
        send_telegram "❌ *DevOps Dashboard Deploy Failed!*
⚠️ Check logs: \`cat $LOG_FILE\`
📅 $(date)"
    fi
    rm -f "$LOCKFILE" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# ── Start ────────────────────────────────────────

echo "========================================"
echo "🚀 DevOps Dashboard — Server Deploy"
echo "Date: $(date)"
echo "App dir: $APP_DIR"
echo "========================================"

send_telegram "🔄 *DevOps Dashboard Deploy Started*
📅 $(date)"

# 1. Pull latest code
echo ""
echo "📥 Pulling latest code..."
cd "$REPO_DIR"
git fetch origin

if [ -n "$(git status --porcelain)" ]; then
    echo "⚠️ Stashing uncommitted changes..."
    git stash push -m "deploy-$(date +%Y%m%d-%H%M%S)" --include-untracked || true
fi

BRANCH=$(git rev-parse --abbrev-ref HEAD)
git reset --hard "origin/$BRANCH"
COMMIT=$(git rev-parse --short HEAD)
echo "✅ Updated to $BRANCH @ $COMMIT"

# 2. Check .env exists
cd "$APP_DIR"
if [ ! -f ".env" ]; then
    echo "❌ .env file missing in $APP_DIR!"
    exit 1
fi

# 3. Docker cleanup (pre-build, free resources)
echo ""
echo "🧹 Pre-build cleanup..."
docker container prune -f 2>/dev/null || true
docker image prune -f 2>/dev/null || true

echo "🧠 Memory (pre-build):"
free -h | head -3

# 4. Build
echo ""
echo "🔨 Building Docker images..."
docker compose build --no-cache 2>&1
echo "✅ Build complete"

# 5. Start/Update containers
echo ""
echo "🚀 Starting containers..."
docker compose up -d --remove-orphans 2>&1

# 6. Wait for health
echo ""
echo "⏳ Waiting for containers to be healthy..."
RETRIES=30
HEALTHY=false
while [ $RETRIES -gt 0 ]; do
    # Check if dashboard container is running
    STATUS=$(docker compose ps --format json 2>/dev/null | grep -o '"State":"[^"]*"' | head -1 || echo "")
    if echo "$STATUS" | grep -q "running"; then
        HEALTHY=true
        break
    fi
    echo "   Status: $STATUS — retries left: $RETRIES"
    sleep 5
    RETRIES=$((RETRIES-1))
done

if [ "$HEALTHY" = false ]; then
    echo "❌ Container failed to start!"
    echo "--- Last 30 lines of logs ---"
    docker compose logs --tail=30 2>/dev/null
    exit 1
fi

echo "✅ Containers running"

# 7. Show status
echo ""
echo "📊 Container status:"
docker compose ps 2>/dev/null

# 8. Post-deploy cleanup
echo ""
echo "🧹 Post-deploy cleanup..."
docker image prune -f 2>/dev/null || true

echo ""
echo "========================================"
echo "🎉 DevOps Dashboard Deployed!"
echo "Branch: $BRANCH"
echo "Commit: $COMMIT"
echo "Date:   $(date)"
echo "========================================"

DEPLOY_SUCCESS=true
send_telegram "✅ *DevOps Dashboard Deployed!*
🌿 $BRANCH ($COMMIT)
📅 $(date)"
