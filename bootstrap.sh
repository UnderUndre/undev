#!/usr/bin/env bash
# ─────────────────────────────────────────────────
# Fresh VPS bootstrap for the devops-dashboard.
#
# Brings the dashboard up the FIRST time on a clean machine, before the
# dashboard itself can manage anything. After this, the dashboard's UI
# self-manages all subsequent deploys (including its own — see "Promote
# to TLS" in the README).
#
# What it does:
#   1. Checks prerequisites (docker, docker compose, git).
#   2. Ensures .env exists (copies from .env.example, prompts for secrets).
#   3. Ensures caddy-docker-proxy is running (skips if already up).
#   4. Ensures the shared `ai-twins-network` external network exists.
#   5. Brings dashboard up via `docker compose up -d` (no TLS, accessible on
#      :3000 over the host IP / SSH tunnel).
#   6. Prints next steps for promoting to a public domain via the UI.
#
# Idempotent — re-running is safe.
#
# Usage:
#   ./bootstrap.sh                       # interactive — prompts for missing secrets
#   ./bootstrap.sh --non-interactive     # fail-fast if anything is missing
# ─────────────────────────────────────────────────
set -euo pipefail

NON_INTERACTIVE=false
for arg in "$@"; do
    case "$arg" in
        --non-interactive) NON_INTERACTIVE=true ;;
        -h|--help)
            sed -n '2,/^# ─/p' "$0" | sed 's/^# *//'
            exit 0 ;;
    esac
done

# ── Locate repo root + devops-app ───────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEVOPS_APP_DIR="$SCRIPT_DIR/devops-app"
ENV_FILE="$DEVOPS_APP_DIR/.env"
ENV_EXAMPLE="$DEVOPS_APP_DIR/.env.example"

if [[ ! -d "$DEVOPS_APP_DIR" ]]; then
    echo "❌ devops-app/ not found at $DEVOPS_APP_DIR"
    echo "   Run this script from the repo root."
    exit 1
fi

# ── 1. Prerequisites ────────────────────────────────────────────────────
echo "▸ Checking prerequisites..."
for cmd in docker git; do
    if ! command -v "$cmd" >/dev/null; then
        echo "❌ $cmd is not installed. Run scripts/server/setup-vps.sh first."
        exit 1
    fi
done
if ! docker compose version >/dev/null 2>&1; then
    echo "❌ docker compose plugin not available. Re-install Docker."
    exit 1
fi
echo "  ✓ docker, docker compose, git"

# ── 2. .env file ────────────────────────────────────────────────────────
echo ""
echo "▸ Checking .env..."
if [[ ! -f "$ENV_FILE" ]]; then
    if [[ ! -f "$ENV_EXAMPLE" ]]; then
        echo "❌ Neither $ENV_FILE nor $ENV_EXAMPLE exists. Repo broken."
        exit 1
    fi
    cp "$ENV_EXAMPLE" "$ENV_FILE"
    echo "  ✓ Copied .env.example → .env"

    if [[ "$NON_INTERACTIVE" == "true" ]]; then
        echo "❌ .env was just created with placeholders — fill it in and re-run, or drop --non-interactive."
        exit 1
    fi

    echo ""
    echo "  Generating random secrets for known keys..."
    # Auto-fill *_SECRET / *_KEY / *_PASSWORD with 32-byte random hex.
    # Operator can override later by editing .env directly.
    while IFS= read -r line; do
        [[ "$line" =~ ^[[:space:]]*# ]] && continue
        [[ -z "$line" ]] && continue
        key="${line%%=*}"
        val="${line#*=}"
        if [[ "$val" == "" || "$val" == "CHANGEME"* || "$val" == "REPLACE"* ]]; then
            case "$key" in
                *SECRET|*KEY|*PASSWORD)
                    new=$(openssl rand -hex 32 2>/dev/null || head -c 32 /dev/urandom | xxd -p -c 64)
                    sed -i "s|^${key}=.*|${key}=${new}|" "$ENV_FILE"
                    echo "    ✓ ${key}"
                    ;;
            esac
        fi
    done < "$ENV_FILE"
    echo ""
    echo "  Edit $ENV_FILE to set non-secret values (DOMAINS, EMAILs, etc), then re-run if needed."
else
    echo "  ✓ .env exists"
fi

# ── 3. caddy-docker-proxy ───────────────────────────────────────────────
echo ""
echo "▸ Checking caddy-docker-proxy..."
if docker ps --format '{{.Image}}' | grep -q "caddy-docker-proxy"; then
    echo "  ✓ already running"
else
    if [[ -f "$SCRIPT_DIR/scripts/server/install-caddy.sh" ]]; then
        echo "  ▸ installing via scripts/server/install-caddy.sh..."
        bash "$SCRIPT_DIR/scripts/server/install-caddy.sh" || {
            echo "  ⚠️ install-caddy.sh failed — continue without TLS proxy."
            echo "     Dashboard will still come up on :3000, but Promote-to-TLS won't work."
            echo "     Fix the proxy, then run: docker compose -f $DEVOPS_APP_DIR/docker-compose.yml up -d --force-recreate"
        }
    else
        echo "  ⚠️ no install-caddy.sh in repo. Set up caddy-docker-proxy manually if you want TLS."
    fi
fi

# ── 4. Shared external network ──────────────────────────────────────────
echo ""
echo "▸ Ensuring shared network 'ai-twins-network'..."
if docker network inspect ai-twins-network >/dev/null 2>&1; then
    echo "  ✓ exists"
else
    docker network create ai-twins-network >/dev/null
    echo "  ✓ created"
fi

# ── 5. Bring dashboard up ───────────────────────────────────────────────
echo ""
echo "▸ Starting dashboard..."
cd "$DEVOPS_APP_DIR"
docker compose up -d

# ── 6. Print next steps ─────────────────────────────────────────────────
echo ""
echo "════════════════════════════════════════════════════════════════"
echo "  Bootstrap complete."
echo ""
HOST_IP=$(curl -s --max-time 3 https://api.ipify.org 2>/dev/null || echo "<your-vps-ip>")
echo "  Dashboard is up on: http://${HOST_IP}:3000"
echo "  (SSH tunnel: ssh -L 3000:localhost:3000 \$DEPLOY_USER@${HOST_IP})"
echo ""
echo "  Next steps to promote dashboard itself to TLS via your domain:"
echo "    1. Open the dashboard URL above and create the first admin account."
echo "    2. Settings → Proxy → set Caddy edge network = 'ai-twins-network'"
echo "    3. Find the dashboard's own app row (or add it), click Edit:"
echo "         - domain           = e.g. dashboard.example.com"
echo "         - upstream service = 'dashboard' (compose service name)"
echo "         - upstream port    = 3000"
echo "    4. Click 'Promote to TLS' on the app detail page."
echo "    5. Within ~10s caddy-docker-proxy issues a Let's Encrypt cert"
echo "       and the domain becomes reachable over HTTPS."
echo ""
echo "  After this, all subsequent deploys (of itself or other apps) go"
echo "  through the dashboard UI — bootstrap.sh is a one-shot."
echo "════════════════════════════════════════════════════════════════"
