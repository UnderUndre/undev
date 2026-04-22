#!/bin/bash
# ─────────────────────────────────────────────────
# Universal server-side deployment script.
# Runs ON the server — survives SSH disconnect via nohup.
#
# Works with any docker-compose project. Auto-detects:
#   - Project name from package.json or directory name
#   - .env file location
#   - docker-compose.yml location
#
# Usage (triggered by deploy.sh, not run manually):
#   nohup bash server-deploy.sh --app-dir /path/to/app > deploy.log 2>&1 &
#
# Args:
#   --app-dir <path>    App directory with docker-compose.yml (required)
#   --repo-dir <path>   Git repo root (default: auto-detect from app-dir)
#   --no-cache          Build without Docker cache
#   --skip-cleanup      Skip pre/post-build Docker cleanup
# ─────────────────────────────────────────────────

set -e

# ── Parse Args ──────────────────────────────────

APP_DIR=""
REPO_DIR=""
NO_CACHE=false
SKIP_CLEANUP=false
BRANCH_OVERRIDE=""
COMMIT_OVERRIDE=""

while [[ $# -gt 0 ]]; do
    case $1 in
        --app-dir)        APP_DIR="$2"; shift 2 ;;
        --app-dir=*)      APP_DIR="${1#--app-dir=}"; shift ;;
        --repo-dir)       REPO_DIR="$2"; shift 2 ;;
        --repo-dir=*)     REPO_DIR="${1#--repo-dir=}"; shift ;;
        --branch)         BRANCH_OVERRIDE="$2"; shift 2 ;;
        --branch=*)       BRANCH_OVERRIDE="${1#--branch=}"; shift ;;
        --commit)         COMMIT_OVERRIDE="$2"; shift 2 ;;
        --commit=*)       COMMIT_OVERRIDE="${1#--commit=}"; shift ;;
        --no-cache)       NO_CACHE=true; shift ;;
        --no-cache=true)  NO_CACHE=true; shift ;;
        --no-cache=false) NO_CACHE=false; shift ;;
        --skip-cleanup)       SKIP_CLEANUP=true; shift ;;
        --skip-cleanup=true)  SKIP_CLEANUP=true; shift ;;
        --skip-cleanup=false) SKIP_CLEANUP=false; shift ;;
        -h|--help)
            echo "Usage: server-deploy.sh --app-dir <path> [--repo-dir <path>] [--branch <name>] [--commit <sha>] [--no-cache] [--skip-cleanup]"
            exit 0 ;;
        *)  shift ;;
    esac
done

# ── Resolve Paths ───────────────────────────────

if [[ -z "$APP_DIR" ]]; then
    # BASH_SOURCE may be empty when this script is piped via `bash -s` (feature
    # 005 runner transport). Fall back to $0 / CWD so `set -u` doesn't blow up.
    _SRC="${BASH_SOURCE[0]:-${0:-$PWD/server-deploy.sh}}"
    SCRIPT_DIR="$(cd "$(dirname "$_SRC")" 2>/dev/null && pwd || echo "$PWD")"
    unset _SRC
    # Script in <app>/scripts/ → use parent
    if [[ -f "$(dirname "$SCRIPT_DIR")/docker-compose.yml" ]] || [[ -f "$(dirname "$SCRIPT_DIR")/compose.yml" ]]; then
        APP_DIR="$(dirname "$SCRIPT_DIR")"
    # Script in <repo>/scripts/deploy/ → use repo root
    elif [[ -f "$(cd "$SCRIPT_DIR/../.." && pwd)/docker-compose.yml" ]]; then
        APP_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
    else
        echo "❌ Cannot detect app directory. Use --app-dir <path>"
        exit 1
    fi
fi

# Resolve repo root. APP_DIR must exist at minimum — compose file check is
# deferred to AFTER git pull because the file may have just been renamed in
# the incoming commit (e.g. docker-compose.prod.yml → docker-compose.yml).
if [[ ! -d "$APP_DIR" ]]; then
    echo "❌ APP_DIR does not exist: $APP_DIR"
    exit 1
fi
if [[ -z "$REPO_DIR" ]]; then
    REPO_DIR="$(git -C "$APP_DIR" rev-parse --show-toplevel 2>/dev/null || echo "$APP_DIR")"
fi

# Detect project name
PROJECT_NAME=""
if [[ -f "$APP_DIR/package.json" ]]; then
    PROJECT_NAME=$(grep -o '"name":\s*"[^"]*"' "$APP_DIR/package.json" | head -1 | cut -d'"' -f4)
fi
PROJECT_NAME="${PROJECT_NAME:-$(basename "$APP_DIR")}"

# ── Config ──────────────────────────────────────

LOCKFILE="/tmp/${PROJECT_NAME}-deploy.lock"
LOG_FILE="$APP_DIR/deploy.log"
DEPLOY_SUCCESS=false

touch "$LOG_FILE" 2>/dev/null || true

# Feature 005: dashboard runner pipes this script through `bash -s` over SSH
# and streams stdout back to the UI. The old `exec >> "$LOG_FILE" 2>&1` path
# swallowed everything into the on-target log file, so the dashboard saw zero
# output. tee duplicates to both — local log file AND the SSH stdout pipe —
# regardless of tty state.
if command -v tee >/dev/null 2>&1; then
    exec > >(tee -a "$LOG_FILE") 2>&1
else
    exec >> "$LOG_FILE" 2>&1
fi

# ── Telegram ────────────────────────────────────

send_telegram() {
    local message="$1"

    # Search for env file with telegram creds (app-level > repo-level)
    local env_file=""
    for f in "$APP_DIR/.env" "$APP_DIR/.env.production" "$REPO_DIR/.env.production" "$REPO_DIR/.env"; do
        if [[ -f "$f" ]] && grep -q "TELEGRAM_BOT_TOKEN=" "$f" 2>/dev/null; then
            env_file="$f"
            break
        fi
    done

    if [[ -n "$env_file" ]]; then
        local token=$(grep "^TELEGRAM_BOT_TOKEN=" "$env_file" | cut -d'=' -f2- | tr -d '\r')
        local chat_id=$(grep "^TELEGRAM_CHAT_ID=" "$env_file" | cut -d'=' -f2- | tr -d '\r')

        if [[ -n "$token" ]] && [[ -n "$chat_id" ]]; then
            local payload
            payload=$(printf '{"chat_id":"%s","text":"%s","parse_mode":"Markdown"}' \
                "$chat_id" \
                "$(echo "$message" | sed 's/"/\\"/g' | sed ':a;N;$!ba;s/\n/\\n/g')")
            curl -s -f -X POST "https://api.telegram.org/bot${token}/sendMessage" \
                -H "Content-Type: application/json; charset=utf-8" \
                -d "$payload" > /dev/null 2>&1 || true
        fi
    fi
}

# ── Deploy Lock ─────────────────────────────────

if [[ -f "$LOCKFILE" ]]; then
    OLDPID=$(cat "$LOCKFILE")
    if ps -p "$OLDPID" > /dev/null 2>&1; then
        echo "❌ Another deployment (PID $OLDPID) is already running!"
        send_telegram "⚠️ *${PROJECT_NAME} Deploy Blocked*
Another deployment is already in progress."
        exit 1
    else
        echo "⚠️ Stale lock for PID $OLDPID — removing"
        rm -f "$LOCKFILE"
    fi
fi
echo $$ > "$LOCKFILE"

# ── Cleanup Trap ────────────────────────────────

cleanup() {
    if [[ "$DEPLOY_SUCCESS" = false ]]; then
        send_telegram "❌ *${PROJECT_NAME} Deploy Failed!*
⚠️ Check logs: \`cat $LOG_FILE\`
📅 $(date)"
    fi
    rm -f "$LOCKFILE" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# ── Start ───────────────────────────────────────

echo "========================================"
echo "🚀 $PROJECT_NAME — Server Deploy"
echo "Date:     $(date)"
echo "App dir:  $APP_DIR"
echo "Repo dir: $REPO_DIR"
echo "========================================"

send_telegram "🔄 *${PROJECT_NAME} Deploy Started*
📅 $(date)"

# ── 1. Pull latest code ────────────────────────

echo ""
echo "📥 Pulling latest code..."
cd "$REPO_DIR"
git -c safe.directory='*' fetch origin

if [[ -n "$(git status --porcelain)" ]]; then
    echo "⚠️ Stashing uncommitted changes..."
    git -c safe.directory='*' stash push -m "deploy-$(date +%Y%m%d-%H%M%S)" --include-untracked || true
fi

# Branch: --branch wins over current HEAD. This is the UI-selected branch —
# without the override, deploys silently followed whatever the target shell
# had last checked out (feature 005 regression).
BRANCH="${BRANCH_OVERRIDE:-$(git rev-parse --abbrev-ref HEAD)}"
echo "🌿 Target branch: $BRANCH"
git -c safe.directory='*' fetch --quiet origin "$BRANCH"

if [[ -n "$COMMIT_OVERRIDE" ]]; then
    echo "📌 Resetting to explicit commit: $COMMIT_OVERRIDE"
    git -c safe.directory='*' reset --hard "$COMMIT_OVERRIDE"
else
    git -c safe.directory='*' reset --hard "origin/$BRANCH"
fi
COMMIT=$(git rev-parse --short HEAD)
echo "✅ Updated to $BRANCH @ $COMMIT"

# ── 2. Verify compose file (AFTER git pull — may have been renamed) ───

cd "$APP_DIR"

COMPOSE_FILE=""
if [[ -f "docker-compose.yml" ]]; then
    COMPOSE_FILE="docker-compose.yml"
elif [[ -f "compose.yml" ]]; then
    COMPOSE_FILE="compose.yml"
else
    echo "❌ No docker-compose.yml or compose.yml in $APP_DIR after pull"
    echo "   HEAD is at $(git rev-parse --short HEAD 2>/dev/null || echo unknown). Check the compose file name in the repo."
    exit 1
fi
echo "📦 Using compose file: $COMPOSE_FILE"

# ── 3. Check env file ──────────────────────────

# Resolve which env file docker-compose will use
ENV_FLAG=""
if [[ -f ".env" ]]; then
    : # docker compose reads .env by default
elif [[ -f ".env.production" ]]; then
    ENV_FLAG="--env-file .env.production"
else
    echo "❌ No .env or .env.production found in $APP_DIR!"
    echo "   Create one: bash scripts/deploy/env-setup.sh .env --app-dir $APP_DIR"
    exit 1
fi

# ── 3. Pre-build cleanup ───────────────────────

if [[ "$SKIP_CLEANUP" != "true" ]]; then
    echo ""
    echo "🧹 Pre-build cleanup..."
    docker container prune -f 2>/dev/null || true
    docker image prune -f 2>/dev/null || true
fi

echo ""
echo "🧠 Memory (pre-build):"
free -h | head -3

# ── 4. Build ────────────────────────────────────

echo ""
echo "🔨 Building Docker images..."
BUILD_ARGS=""
[[ "$NO_CACHE" = "true" ]] && BUILD_ARGS="--no-cache"
docker compose $ENV_FLAG build $BUILD_ARGS 2>&1
echo "✅ Build complete"

# ── 5. Start / update containers ────────────────

echo ""
echo "🚀 Starting containers..."
docker compose $ENV_FLAG up -d 2>&1

# ── 6. Health check ─────────────────────────────

echo ""
echo "⏳ Waiting for containers..."
RETRIES=30
ALL_UP=false
while [[ $RETRIES -gt 0 ]]; do
    TOTAL=$(docker compose $ENV_FLAG ps -a --format json 2>/dev/null | wc -l)
    RUNNING=$(docker compose $ENV_FLAG ps --status running --format json 2>/dev/null | wc -l)

    if [[ "$TOTAL" -gt 0 ]] && [[ "$RUNNING" -ge "$TOTAL" ]]; then
        ALL_UP=true
        break
    fi

    FAILED=$(docker compose $ENV_FLAG ps --status exited --format json 2>/dev/null | wc -l)
    RESTARTING=$(docker compose $ENV_FLAG ps --status restarting --format json 2>/dev/null | wc -l)

    echo "   Running: $RUNNING/$TOTAL (exited: $FAILED, restarting: $RESTARTING) — retries: $RETRIES"

    # If something exited and isn't restarting, bail early
    if [[ "$FAILED" -gt 0 ]] && [[ "$RESTARTING" -eq 0 ]]; then
        echo "❌ Container exited without restart policy!"
        break
    fi

    sleep 5
    RETRIES=$((RETRIES-1))
done

if [[ "$ALL_UP" = false ]]; then
    echo "❌ Not all containers are running!"
    echo "--- Last 30 lines of logs ---"
    docker compose $ENV_FLAG logs --tail=30 2>/dev/null
    exit 1
fi

echo "✅ All containers running ($RUNNING/$TOTAL)"

# ── 7. Status ───────────────────────────────────

echo ""
echo "📊 Container status:"
docker compose $ENV_FLAG ps 2>/dev/null

# ── 8. Post-deploy cleanup ─────────────────────

if [[ "$SKIP_CLEANUP" != "true" ]]; then
    echo ""
    echo "🧹 Post-deploy cleanup..."
    docker image prune -f 2>/dev/null || true
fi

# ── Done ────────────────────────────────────────

echo ""
echo "========================================"
echo "🎉 $PROJECT_NAME Deployed!"
echo "Branch: $BRANCH"
echo "Commit: $COMMIT"
echo "Date:   $(date)"
echo "========================================"

DEPLOY_SUCCESS=true
send_telegram "✅ *${PROJECT_NAME} Deployed!*
🌿 $BRANCH ($COMMIT)
📅 $(date)"
