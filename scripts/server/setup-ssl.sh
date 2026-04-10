#!/bin/bash
# ─────────────────────────────────────────────────
# SSL setup via Let's Encrypt + auto-renewal.
#
# Usage:
#   ./scripts/server/setup-ssl.sh example.com
#   ./scripts/server/setup-ssl.sh example.com www.example.com
# ─────────────────────────────────────────────────

set -euo pipefail

DOMAINS=("$@")
if [[ ${#DOMAINS[@]} -eq 0 ]]; then
    echo "Usage: setup-ssl.sh <domain> [domain2...]"
    exit 1
fi

DOMAIN_FLAGS=""
for d in "${DOMAINS[@]}"; do
    DOMAIN_FLAGS="$DOMAIN_FLAGS -d $d"
done

echo "▸ Obtaining SSL certificate for: ${DOMAINS[*]}"
certbot --nginx $DOMAIN_FLAGS --non-interactive --agree-tos --redirect \
    --email "${SSL_EMAIL:-admin@${DOMAINS[0]}}"

echo "▸ Verifying auto-renewal..."
certbot renew --dry-run

echo "✓ SSL configured with auto-renewal"
