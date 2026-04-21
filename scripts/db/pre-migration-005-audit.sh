#!/usr/bin/env bash
#
# Feature 005 A-005 / R-007 — pre-migration audit + backup.
#
# Two phases:
#   1. AUDIT  — enumerate applications.deploy_script values and classify each
#               as "deploy/deploy", "deploy/deploy-docker", or UNKNOWN. Fails
#               non-zero if any UNKNOWN.
#   2. BACKUP — pg_dump the applications table to ops/backups so rollback
#               can rebuild deploy_script values if needed.
#
# Admin runs this manually BEFORE applying migration 0005. If CI reaches prod
# DB, it can gate on the audit pass too.

set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"

BACKUP_DIR="${BACKUP_DIR:-ops/backups}"
mkdir -p "$BACKUP_DIR"

echo "==> Phase 1: Audit applications.deploy_script values"

TMP_OUT="$(mktemp)"
psql "$DATABASE_URL" -At -F '|' -c \
  "SELECT COALESCE(deploy_script, '<NULL>'), COUNT(*) FROM applications GROUP BY deploy_script ORDER BY COUNT(*) DESC" \
  > "$TMP_OUT"

UNKNOWN_COUNT=0
while IFS='|' read -r script count; do
  [ -z "$script" ] && continue
  classification="UNKNOWN"
  case "$script" in
    *.sh|*deploy.sh) classification="deploy/deploy" ;;
    *docker*compose*|*docker*pull*|*docker*up*) classification="deploy/deploy-docker" ;;
    */* ) classification="deploy/deploy" ;;
  esac
  if [ "$classification" = "UNKNOWN" ]; then
    UNKNOWN_COUNT=$((UNKNOWN_COUNT + 1))
  fi
  printf '  %-40s  %-24s  count=%s\n' "$script" "$classification" "$count"
done < "$TMP_OUT"
rm -f "$TMP_OUT"

if [ "$UNKNOWN_COUNT" -gt 0 ]; then
  echo "!! $UNKNOWN_COUNT unique deploy_script value(s) did not classify."
  echo "!! Review & either update applications row or extend resolveDeployOperation."
  exit 1
fi
echo "    All deploy_script values classify cleanly."

echo
echo "==> Phase 2: pg_dump backup of applications table"

TS="$(date +%Y%m%d-%H%M%S)"
OUT="$BACKUP_DIR/pre-005-applications-$TS.sql"
pg_dump --table=applications --column-inserts "$DATABASE_URL" > "$OUT"

BYTES=$(wc -c < "$OUT" | tr -d ' ')
if [ "$BYTES" -lt 100 ]; then
  echo "!! Backup suspiciously small ($BYTES bytes)."
  exit 1
fi
echo "    Backup written: $OUT ($BYTES bytes)"
echo
echo "OK — safe to apply migration 0005."
