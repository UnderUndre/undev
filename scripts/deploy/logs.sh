#!/bin/bash
# ─────────────────────────────────────────────────
# Tail production logs via SSH.
#
# Config: PROD_SSH_HOST, REMOTE_APP_DIR
#
# Usage:
#   ./scripts/deploy/logs.sh            # Tail app logs (pm2)
#   ./scripts/deploy/logs.sh --docker   # Tail docker compose logs
#   ./scripts/deploy/logs.sh --nginx    # Tail nginx access log
#   ./scripts/deploy/logs.sh --error    # Tail nginx error log
# ─────────────────────────────────────────────────

source "$(dirname "$0")/../common.sh"
load_env ".env.production"

: "${PROD_SSH_HOST:?Set PROD_SSH_HOST}"
: "${REMOTE_APP_DIR:?Set REMOTE_APP_DIR}"

MODE="${1:---pm2}"
LINES="${LINES:-100}"

case "$MODE" in
    --docker)
        info "Tailing Docker Compose logs..."
        ssh -t "$PROD_SSH_HOST" "cd $REMOTE_APP_DIR && docker compose logs -f --tail=$LINES"
        ;;
    --nginx)
        info "Tailing Nginx access log..."
        ssh -t "$PROD_SSH_HOST" "tail -f -n $LINES /var/log/nginx/access.log"
        ;;
    --error)
        info "Tailing Nginx error log..."
        ssh -t "$PROD_SSH_HOST" "tail -f -n $LINES /var/log/nginx/error.log"
        ;;
    --pm2|*)
        info "Tailing PM2 logs..."
        ssh -t "$PROD_SSH_HOST" "cd $REMOTE_APP_DIR && pm2 logs --lines $LINES"
        ;;
esac
