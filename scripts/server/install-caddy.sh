#!/bin/bash
# ─────────────────────────────────────────────────
# Caddy install (Feature 008): Docker-managed Caddy on the `caddy` network.
#
# Idempotent — re-runs are safe. Binds admin API to 127.0.0.1:2019 only.
# Pins caddy:2.7 (research.md R-001 / A-003 — patch updates ride along).
#
# Pre-checks:
#   - Port 2019 free (T070 / FR Edge Case "Caddy admin port already taken")
#   - UFW does NOT open 2019 (loopback-only invariant — FR-028)
#
# Run as root (or via sudo) on a managed target VPS.
# ─────────────────────────────────────────────────
set -euo pipefail

CADDY_VERSION_TAG="caddy:2.7"
CADDY_CONFIG_DIR="/var/lib/caddy-config"

echo "▸ install-caddy.sh — start"

# ── 1. Pre-flight: port 2019 conflict (T070) ────────────────────────────
if ss -ltn '( sport = :2019 )' 2>/dev/null | grep -q ':2019'; then
  occupant="$(ss -ltnp '( sport = :2019 )' 2>/dev/null | awk 'NR>1 {print $NF}' | head -1)"
  echo "✖ Port 2019 already in use: ${occupant:-unknown process}"
  echo "  Stop the existing process or pick a different port."
  echo "  Note: 2019 is loopback-only by design (FR-028) — UFW must NOT open it."
  exit 1
fi

# ── 2. UFW invariant: 2019 must NOT be opened ───────────────────────────
if command -v ufw >/dev/null 2>&1; then
  if ufw status 2>/dev/null | grep -qE '^[[:space:]]*2019\b'; then
    echo "✖ UFW has a rule for port 2019 — forbidden (FR-028)."
    echo "  Run: ufw delete allow 2019"
    exit 1
  fi
fi

# ── 3. Docker network ───────────────────────────────────────────────────
docker network create caddy 2>/dev/null || true

# ── 4. Volumes ──────────────────────────────────────────────────────────
docker volume create caddy_data 2>/dev/null || true
docker volume create caddy_config 2>/dev/null || true

# ── 5. Seed minimal admin config ────────────────────────────────────────
mkdir -p "$CADDY_CONFIG_DIR"
if [[ ! -f "$CADDY_CONFIG_DIR/caddy.json" ]]; then
  cat > "$CADDY_CONFIG_DIR/caddy.json" <<'JSON'
{
  "admin": { "listen": "127.0.0.1:2019" },
  "apps": { "http": { "servers": {} } }
}
JSON
  echo "▸ Seeded $CADDY_CONFIG_DIR/caddy.json"
fi

# ── 6. Move legacy nginx off 80/443 (8080/8443) so Caddy can own them ────
if [[ -d /etc/nginx/sites-enabled ]]; then
  sed -i 's/listen 80/listen 8080/g; s/listen 443/listen 8443/g' /etc/nginx/sites-enabled/* 2>/dev/null || true
  systemctl reload nginx 2>/dev/null || true
  echo "▸ nginx vhosts moved to 8080/8443 (if any)"
fi

# ── 7. Run Caddy (admin loopback-only, FR-028) ──────────────────────────
if docker ps -a --format '{{.Names}}' | grep -qx caddy; then
  echo "▸ Caddy container exists — restarting"
  docker restart caddy >/dev/null
else
  docker run -d --name caddy --restart unless-stopped \
    --network caddy \
    -p 80:80 -p 443:443 -p 443:443/udp \
    -p 127.0.0.1:2019:2019 \
    -v caddy_data:/data \
    -v caddy_config:/config \
    -v "$CADDY_CONFIG_DIR/caddy.json:/config/caddy.json:ro" \
    "$CADDY_VERSION_TAG" \
    caddy run --config /config/caddy.json --adapter json
  echo "▸ Caddy container created"
fi

# ── 8. Verify ───────────────────────────────────────────────────────────
sleep 2
if ! ss -ltn '( sport = :2019 )' 2>/dev/null | grep -q '127.0.0.1:2019'; then
  echo "⚠ Caddy admin not listening on 127.0.0.1:2019 yet — check 'docker logs caddy'"
fi

echo "✓ install-caddy.sh — done"
