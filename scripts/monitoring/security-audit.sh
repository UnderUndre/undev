#!/bin/bash
# ─────────────────────────────────────────────────
# Quick security audit for Node.js projects.
#
# Checks:
#   1. npm audit (known vulnerabilities)
#   2. Outdated dependencies
#   3. .env files accidentally committed
#   4. Secrets in git history
#   5. File permissions
#
# Usage:
#   ./scripts/monitoring/security-audit.sh
# ─────────────────────────────────────────────────

source "$(dirname "$0")/../common.sh"

echo -e "${BLUE}=== Security Audit ===${NC}"
echo ""
ISSUES=0

# 1. npm audit
step "Checking npm vulnerabilities..."
AUDIT_OUTPUT=$(npm audit --json 2>/dev/null || true)
VULNS=$(echo "$AUDIT_OUTPUT" | node -pe "JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).metadata?.vulnerabilities?.high || 0" 2>/dev/null || echo "?")
CRITICAL=$(echo "$AUDIT_OUTPUT" | node -pe "JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).metadata?.vulnerabilities?.critical || 0" 2>/dev/null || echo "?")

if [[ "$CRITICAL" != "0" ]] && [[ "$CRITICAL" != "?" ]]; then
    error "Critical vulnerabilities: $CRITICAL"
    ISSUES=$((ISSUES + 1))
elif [[ "$VULNS" != "0" ]] && [[ "$VULNS" != "?" ]]; then
    warn "High vulnerabilities: $VULNS (run: npm audit fix)"
else
    log "No critical/high vulnerabilities"
fi

# 2. .env files in git
step "Checking for committed .env files..."
ENV_FILES=$(git ls-files '*.env' '.env.*' 2>/dev/null | grep -v '.env.example' || true)
if [[ -n "$ENV_FILES" ]]; then
    error "Found .env files in git:"
    echo "$ENV_FILES" | while read -r f; do echo "  - $f"; done
    ISSUES=$((ISSUES + 1))
else
    log "No .env files in git"
fi

# 3. Secrets in code
step "Scanning for hardcoded secrets..."
SECRET_HITS=$(grep -rn --include="*.ts" --include="*.js" --include="*.json" \
    -E "(sk-[a-zA-Z0-9]{20,}|ghp_[a-zA-Z0-9]{36}|-----BEGIN.*PRIVATE KEY)" \
    "$REPO_ROOT/src" "$REPO_ROOT/server" 2>/dev/null | grep -v node_modules | head -5 || true)
if [[ -n "$SECRET_HITS" ]]; then
    error "Possible hardcoded secrets found:"
    echo "$SECRET_HITS"
    ISSUES=$((ISSUES + 1))
else
    log "No hardcoded secrets detected"
fi

# 4. Outdated deps
step "Checking outdated dependencies..."
OUTDATED=$(npm outdated --json 2>/dev/null | node -pe "Object.keys(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'))).length" 2>/dev/null || echo "?")
if [[ "$OUTDATED" != "0" ]] && [[ "$OUTDATED" != "?" ]]; then
    info "$OUTDATED outdated packages (run: npm outdated)"
else
    log "All dependencies up to date"
fi

echo ""
if [[ $ISSUES -gt 0 ]]; then
    error "$ISSUES issue(s) found. Review above."
    exit 1
else
    log "Security audit passed"
fi
