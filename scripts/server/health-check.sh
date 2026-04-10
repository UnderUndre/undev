#!/bin/bash
# ─────────────────────────────────────────────────
# Server health check: disk, memory, CPU, services.
#
# Usage:
#   ssh deploy@server < scripts/server/health-check.sh
#   ./scripts/server/health-check.sh  # Run locally
# ─────────────────────────────────────────────────

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

ok()   { echo -e "${GREEN}✓${NC} $1"; }
warn() { echo -e "${YELLOW}⚠${NC} $1"; }
fail() { echo -e "${RED}✗${NC} $1"; }

echo "=== Health Check: $(hostname) ==="
echo "Time: $(date)"
echo ""

# Disk
DISK_PCT=$(df / | tail -1 | awk '{print $5}' | tr -d '%')
if [[ $DISK_PCT -lt 80 ]]; then
    ok "Disk: ${DISK_PCT}%"
elif [[ $DISK_PCT -lt 90 ]]; then
    warn "Disk: ${DISK_PCT}% (getting full)"
else
    fail "Disk: ${DISK_PCT}% (CRITICAL)"
fi

# Memory
MEM_PCT=$(free | awk '/Mem:/ {printf "%.0f", $3/$2 * 100}')
if [[ $MEM_PCT -lt 80 ]]; then
    ok "Memory: ${MEM_PCT}%"
elif [[ $MEM_PCT -lt 90 ]]; then
    warn "Memory: ${MEM_PCT}%"
else
    fail "Memory: ${MEM_PCT}% (CRITICAL)"
fi

# Load average
LOAD=$(cat /proc/loadavg | awk '{print $1}')
CORES=$(nproc)
LOAD_PCT=$(echo "$LOAD $CORES" | awk '{printf "%.0f", ($1/$2)*100}')
if [[ $LOAD_PCT -lt 70 ]]; then
    ok "CPU load: ${LOAD} (${LOAD_PCT}% of ${CORES} cores)"
else
    warn "CPU load: ${LOAD} (${LOAD_PCT}% of ${CORES} cores)"
fi

# Swap
if swapon --show | grep -q /; then
    SWAP_USED=$(free | awk '/Swap:/ {if($2>0) printf "%.0f", $3/$2*100; else print "0"}')
    if [[ $SWAP_USED -lt 50 ]]; then
        ok "Swap: ${SWAP_USED}%"
    else
        warn "Swap: ${SWAP_USED}% (heavy swapping)"
    fi
fi

# Services
echo ""
for svc in nginx docker pm2; do
    if command -v $svc &>/dev/null; then
        if systemctl is-active --quiet $svc 2>/dev/null || pgrep -x $svc >/dev/null 2>&1; then
            ok "$svc: running"
        else
            fail "$svc: not running"
        fi
    fi
done

# Docker containers (if docker available)
if command -v docker &>/dev/null; then
    echo ""
    RUNNING=$(docker ps -q | wc -l)
    TOTAL=$(docker ps -aq | wc -l)
    ok "Docker: $RUNNING/$TOTAL containers running"
fi
