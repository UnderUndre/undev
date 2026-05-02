#!/bin/bash
# ─────────────────────────────────────────────────
# Feature 006 T061 — DEADLOCK-AVOIDANCE CONTRACT (verbatim, do not edit):
# waitForHealthy is a target-side bash tail using raw 'docker inspect'. It
# MUST NOT call back to the dashboard's Node-side probe runner. See spec 006
# Edge Case "waitForHealthy deploy gate must NOT depend on the dashboard's
# probe lock" for rationale — a future "consolidate probe code" refactor that
# routes this gate through the Node probe runner reintroduces the FR-011 vs
# FR-024 deadlock.
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

# Snapshot ORIGINAL args before the parsing while-loop consumes them.
# The self-deploy detach block (further down) needs to re-exec the disk copy
# with the same args the SSH'd parent received — otherwise the detached child
# starts with an empty argv, fails APP_DIR auto-detection (the auto-detect
# walk doesn't reach `devops-app/` from `scripts/deploy/`), and dies with
# "Cannot detect app directory". Incident 2026-05-02.
_ORIGINAL_ARGS=("$@")

# ── Parse Args ──────────────────────────────────

APP_DIR=""
REPO_DIR=""
REPO_URL=""
COMPOSE_PATH=""
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
        --repo-url)       REPO_URL="$2"; shift 2 ;;
        --repo-url=*)     REPO_URL="${1#--repo-url=}"; shift ;;
        --compose-path)   COMPOSE_PATH="$2"; shift 2 ;;
        --compose-path=*) COMPOSE_PATH="${1#--compose-path=}"; shift ;;
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
            echo "Usage: server-deploy.sh --app-dir <path> [--repo-dir <path>] [--repo-url <url>] [--compose-path <path>] [--branch <name>] [--commit <sha>] [--no-cache] [--skip-cleanup]"
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
#
# Clone-if-missing (incident 2026-05-02): when the dashboard dispatches with
# --repo-url AND APP_DIR doesn't exist, materialise the app declaratively —
# mkdir parent + git clone. Operator no longer needs to SSH+mkdir+clone before
# first deploy. Without --repo-url (legacy invocations) we keep the strict
# "exists or fail" behaviour.
if [[ ! -d "$APP_DIR" ]]; then
    if [[ -n "$REPO_URL" ]]; then
        BOOTSTRAP_BRANCH="${BRANCH_OVERRIDE:-main}"
        echo "📦 First deploy — cloning $REPO_URL into $APP_DIR (branch: $BOOTSTRAP_BRANCH)"
        # Parent-dir creation strategy:
        #   1. Plain mkdir — works for paths under $HOME, /tmp, etc.
        #   2. Fallback to sudo + chown when parent is root-owned (e.g.
        #      /var/www, /srv, /opt). Deploy user has NOPASSWD per setup-vps.sh.
        #   3. After parent ready, pre-create APP_DIR with deploy-user ownership
        #      so subsequent `git clone` (which runs as deploy user, not root)
        #      can write into it.
        APP_PARENT="$(dirname "$APP_DIR")"
        if ! mkdir -p "$APP_PARENT" 2>/dev/null; then
            echo "   ↳ parent $APP_PARENT is not user-writable; using sudo -n"
            # `-n` = non-interactive; fail-fast if sudo would prompt for password.
            # Most modern sudoers have `Defaults use_pty` which blocks NOPASSWD
            # in non-TTY contexts (deploy scripts dispatched via `bash -s` over
            # SSH have no TTY). Operator hint printed below if this trips.
            if ! sudo -n mkdir -p "$APP_PARENT" 2>/dev/null; then
                echo "❌ Cannot create $APP_PARENT — sudo requires TTY/password."
                echo ""
                echo "Either:"
                echo "  (a) One-time fix on target host (preferred):"
                echo "      sudo tee /etc/sudoers.d/$(id -un)-nopty > /dev/null << 'EOF'"
                echo "      Defaults:$(id -un) !use_pty"
                echo "      EOF"
                echo "      sudo chmod 440 /etc/sudoers.d/$(id -un)-nopty"
                echo ""
                echo "  (b) Pick an APP_DIR under \$HOME (e.g. ~/apps/<name>) so no sudo is needed."
                echo ""
                echo "  (c) Pre-create the dir manually with correct ownership:"
                echo "      sudo mkdir -p $APP_DIR && sudo chown $(id -un):$(id -gn) $APP_DIR"
                exit 1
            fi
        fi
        if [[ ! -w "$APP_PARENT" ]]; then
            # Parent stays root-owned (don't chown /var/www etc — other apps
            # may live there). Pre-create APP_DIR as empty + chown to deploy
            # user. `git clone` accepts existing empty dirs.
            sudo -n mkdir -p "$APP_DIR" || { echo "❌ sudo mkdir $APP_DIR failed"; exit 1; }
            sudo -n chown "$(id -un):$(id -gn)" "$APP_DIR" || { echo "❌ sudo chown $APP_DIR failed"; exit 1; }
        fi
        # Auth strategy:
        #   - SSH URL (git@github.com:...) → relies on host's ~/.ssh/id_*
        #     (the SSH user must have repo-read access via deploy key or SSH agent).
        #   - HTTPS URL with $SECRET_PAT in env → inject for clone, strip after.
        #   - HTTPS URL without PAT → public clone only.
        if [[ "$REPO_URL" == https://* ]] && [[ -n "${SECRET_PAT:-}" ]]; then
            AUTH_URL="https://oauth2:${SECRET_PAT}@${REPO_URL#https://}"
            # trap ensures PAT is stripped from .git/config even if clone fails
            trap 'git -C "$APP_DIR" -c safe.directory="*" remote set-url origin "$REPO_URL" 2>/dev/null || true' EXIT
            git clone --branch "$BOOTSTRAP_BRANCH" "$AUTH_URL" "$APP_DIR"
            git -C "$APP_DIR" -c safe.directory='*' remote set-url origin "$REPO_URL"
            trap - EXIT
        else
            git clone --branch "$BOOTSTRAP_BRANCH" "$REPO_URL" "$APP_DIR"
        fi
        echo "✅ Cloned to $APP_DIR"
    else
        echo "❌ APP_DIR does not exist: $APP_DIR"
        echo "   Hint: dashboard should pass --repo-url to enable clone-if-missing."
        exit 1
    fi
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
# Sanitize for use in filesystem paths: scoped npm packages like
# `@underundre/undev` contain `/` and `@` which break bash redirects when
# the parent dir doesn't exist. Replace `/` and leading `@` with `-`.
PROJECT_NAME_SAFE="$(echo "$PROJECT_NAME" | sed 's|^@||; s|/|-|g; s|[^A-Za-z0-9._-]|-|g')"

# ── Config ──────────────────────────────────────

LOCKFILE="/tmp/${PROJECT_NAME_SAFE}-deploy.lock"
LOG_FILE="$APP_DIR/deploy.log"
DEPLOY_SUCCESS=false

touch "$LOG_FILE" 2>/dev/null || true

# ── Self-Deploy Detach (feature 006 incident 2026-05-01) ────────
# When the dashboard deploys ITSELF, `docker compose up -d` recreates the
# dashboard container that owns the SSH connection that owns this bash
# process. SSH drops → SIGHUP → bash dies → container left in `Created`
# state, never started. To survive: hand off to the on-disk copy of this
# script via setsid (new session leader, immune to SIGHUP) on first
# invocation, then let the SSH-piped parent return.
#
# Why disk copy instead of `bash "$0"`: when invoked via `bash -s` over SSH
# (feature 005 runner), `$0` is "bash" and there is no script file to re-exec.
# The on-disk repo at $REPO_DIR/scripts/deploy/server-deploy.sh IS the source
# of truth for the next-after-pull deploy — slight risk it's stale relative
# to the in-flight version, but the detached re-run does its own `git pull`
# before any compose work, picking up the same commit anyway.
#
# Trade-off: dashboard runner sees exit 0 immediately and reports "success"
# while detached deploy continues. Operator monitors via tail $LOG_FILE or
# the final Telegram (success/fail) the detached run posts itself.
if [[ -z "${DEPLOY_DETACHED:-}" ]]; then
    case "$PROJECT_NAME_SAFE" in
        devops-dashboard|devops-app|underundre-undev)
            # REPO_DIR is auto-detected from APP_DIR around line 91 — but
            # we're earlier in the file. Re-derive minimally just for the
            # disk-copy path resolution.
            _REPO_DIR_GUESS="${REPO_DIR:-$(git -C "$APP_DIR" rev-parse --show-toplevel 2>/dev/null || echo "$APP_DIR")}"
            _DISK_COPY="$_REPO_DIR_GUESS/scripts/deploy/server-deploy.sh"
            if [[ -f "$_DISK_COPY" ]]; then
                export DEPLOY_DETACHED=1
                echo "🔌 Self-deploy detected ($PROJECT_NAME_SAFE) — handing off to disk copy via setsid; tail $LOG_FILE for progress"
                # Use _ORIGINAL_ARGS (snapshot before the while-loop) — `$@`
                # at this point is empty because parsing already shifted everything.
                #
                # stdio → /dev/null (NOT >> $LOG_FILE) because the script
                # itself sets up `exec > >(tee -a $LOG_FILE) 2>&1` further down.
                # Outer `>> $LOG_FILE` + inner tee = every line written TWICE
                # (once via tee's `-a` direct write, once via tee's inherited
                # stdout which is also LOG_FILE). Incident 2026-05-02.
                setsid nohup bash "$_DISK_COPY" "${_ORIGINAL_ARGS[@]}" > /dev/null 2>&1 < /dev/null &
                disown
                exit 0
            else
                echo "⚠️ Self-deploy detected but disk copy missing at $_DISK_COPY — running attached, may die mid-recreate"
            fi
            ;;
    esac
fi

# Feature 005: dashboard runner pipes this script through `bash -s` over SSH
# and streams stdout back to the UI. The old `exec >> "$LOG_FILE" 2>&1` path
# swallowed everything into the on-target log file, so the dashboard saw zero
# output. tee duplicates to both — local log file AND the SSH stdout pipe —
# regardless of tty state.
#
# When DEPLOY_DETACHED=1, there's no SSH stdout pipe (we forked away from it),
# so the tee-to-stdout path becomes write-to-detached-stderr (harmless).
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
# Explicit override from --compose-path (dashboard's `applications.compose_path`
# column) wins over auto-detection. Lets repos with non-standard names like
# `docker-compose.local.yml` or `services/api/compose.yaml` be deployed
# without renaming their on-disk file.
if [[ -n "$COMPOSE_PATH" ]] && [[ -f "$COMPOSE_PATH" ]]; then
    COMPOSE_FILE="$COMPOSE_PATH"
elif [[ -n "$COMPOSE_PATH" ]]; then
    echo "❌ Compose file $COMPOSE_PATH not found in $APP_DIR (specified via --compose-path)"
    echo "   HEAD is at $(git rev-parse --short HEAD 2>/dev/null || echo unknown). Check the file exists at this path in the repo."
    exit 1
elif [[ -f "docker-compose.yml" ]]; then
    COMPOSE_FILE="docker-compose.yml"
elif [[ -f "compose.yml" ]]; then
    COMPOSE_FILE="compose.yml"
else
    echo "❌ No docker-compose.yml or compose.yml in $APP_DIR after pull"
    echo "   HEAD is at $(git rev-parse --short HEAD 2>/dev/null || echo unknown). Check the compose file name in the repo,"
    echo "   or set Compose Path in the app's Edit form (e.g. docker-compose.local.yml)."
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
docker compose -f "$COMPOSE_FILE" $ENV_FLAG build $BUILD_ARGS 2>&1
echo "✅ Build complete"

# ── 5. Start / update containers ────────────────

echo ""
echo "🚀 Starting containers..."

# Pre-up cleanup: drop orphan named containers that would conflict with our
# compose definition. Happens when a previous deploy was killed mid-recreate
# (the new container got `docker create`d but the old one wasn't removed
# because compose treats explicit container_name as an immutable identity).
# Without this, `docker compose up` fails with:
#   "Error response from daemon: Conflict. The container name '/X' is
#    already in use by container '<hash>'"
echo "  ↳ scanning compose for container_name declarations..."
# Grep raw compose files (not `docker compose config` — that fails silently
# on missing env vars and the `set -e` pipeline swallows the output). When a
# service declares an explicit `container_name`, we own that name — any
# pre-existing container with the same name is fair game to remove.
CNAMES=$(grep -hE '^\s*container_name:\s*' docker-compose.yml compose.yml docker-compose.*.yml 2>/dev/null \
         | sed -E 's/^\s*container_name:\s*"?//; s/"?\s*$//' | sort -u || true)
if [[ -n "$CNAMES" ]]; then
  while read -r cname; do
    [[ -z "$cname" ]] && continue
    if docker inspect "$cname" >/dev/null 2>&1; then
      echo "  ↪ removing pre-existing container: $cname"
      docker rm -f "$cname" >/dev/null 2>&1 || true
    fi
  done <<< "$CNAMES"
else
  echo "  ↳ no container_name declarations found"
fi

docker compose -f "$COMPOSE_FILE" $ENV_FLAG up -d 2>&1

# ── 6. Health check ─────────────────────────────

echo ""
echo "⏳ Waiting for containers..."
RETRIES=30
ALL_UP=false
while [[ $RETRIES -gt 0 ]]; do
    TOTAL=$(docker compose -f "$COMPOSE_FILE" $ENV_FLAG ps -a --format json 2>/dev/null | wc -l)
    RUNNING=$(docker compose -f "$COMPOSE_FILE" $ENV_FLAG ps --status running --format json 2>/dev/null | wc -l)

    if [[ "$TOTAL" -gt 0 ]] && [[ "$RUNNING" -ge "$TOTAL" ]]; then
        ALL_UP=true
        break
    fi

    FAILED=$(docker compose -f "$COMPOSE_FILE" $ENV_FLAG ps --status exited --format json 2>/dev/null | wc -l)
    RESTARTING=$(docker compose -f "$COMPOSE_FILE" $ENV_FLAG ps --status restarting --format json 2>/dev/null | wc -l)

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
    docker compose -f "$COMPOSE_FILE" $ENV_FLAG logs --tail=30 2>/dev/null
    exit 1
fi

echo "✅ All containers running ($RUNNING/$TOTAL)"

# ── 7. Status ───────────────────────────────────

echo ""
echo "📊 Container status:"
docker compose -f "$COMPOSE_FILE" $ENV_FLAG ps 2>/dev/null

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
