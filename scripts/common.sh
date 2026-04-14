#!/bin/bash
# ─────────────────────────────────────────────────
# Common utilities for all undev scripts.
# Source this at the top of every script:
#   source "$(dirname "$0")/common.sh"
# ─────────────────────────────────────────────────

set -euo pipefail

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

# Detect repo root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null || dirname "$SCRIPT_DIR")"

# Logging
log()   { echo -e "${GREEN}[$(date '+%H:%M:%S')]${NC} $1"; }
warn()  { echo -e "${YELLOW}[$(date '+%H:%M:%S')] WARN:${NC} $1"; }
error() { echo -e "${RED}[$(date '+%H:%M:%S')] ERROR:${NC} $1" >&2; }
info()  { echo -e "${CYAN}[$(date '+%H:%M:%S')]${NC} $1"; }
step()  { echo -e "${BLUE}▸${NC} $1"; }

# Confirm prompt (skip if --yes or CI)
confirm() {
    local msg="${1:-Continue?}"
    if [[ "${YES:-false}" == "true" ]] || [[ "${CI:-false}" == "true" ]]; then
        return 0
    fi
    read -rp "$(echo -e "${YELLOW}${msg} [y/N]${NC} ")" answer
    [[ "$answer" =~ ^[Yy]$ ]]
}

# Load .env file if it exists
load_env() {
    local env_file="${1:-.env}"
    if [[ -f "$REPO_ROOT/$env_file" ]]; then
        set -a
        source "$REPO_ROOT/$env_file"
        set +a
    fi
}

# Telegram notification (optional — needs TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID)
notify_telegram() {
    local message="$1"
    if [[ -n "${TELEGRAM_BOT_TOKEN:-}" ]] && [[ -n "${TELEGRAM_CHAT_ID:-}" ]]; then
        # Use JSON body to preserve UTF-8 emoji on Windows (--data-urlencode mangles multi-byte chars)
        local payload
        payload=$(printf '{"chat_id":"%s","text":"%s","parse_mode":"Markdown"}' \
            "$TELEGRAM_CHAT_ID" \
            "$(echo "$message" | sed 's/"/\\"/g' | sed ':a;N;$!ba;s/\n/\\n/g')")
        curl -sf -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
            -H "Content-Type: application/json; charset=utf-8" \
            -d "$payload" > /dev/null 2>&1 &
    fi
}

# Git helpers
git_branch()  { git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD; }
git_commit()  { git -C "$REPO_ROOT" rev-parse --short HEAD; }
git_version() { node -p "require('$REPO_ROOT/package.json').version" 2>/dev/null || echo "0.0.0"; }
git_dirty()   { [[ -n "$(git -C "$REPO_ROOT" status --porcelain)" ]]; }

# Require commands
require_cmd() {
    for cmd in "$@"; do
        if ! command -v "$cmd" &>/dev/null; then
            error "Required command not found: $cmd"
            exit 1
        fi
    done
}
