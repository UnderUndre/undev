#!/bin/bash
# ─────────────────────────────────────────────────
# PostgreSQL database restore from backup.
#
# Usage:
#   ./scripts/db/restore.sh backups/mydb_20260409.dump
#   POSTGRES_DB=mydb ./scripts/db/restore.sh latest
# ─────────────────────────────────────────────────

source "$(dirname "$0")/../common.sh"
load_env

require_cmd pg_restore

: "${POSTGRES_DB:?Set POSTGRES_DB}"

DB_HOST="${POSTGRES_HOST:-localhost}"
DB_PORT="${POSTGRES_PORT:-5432}"
DB_USER="${POSTGRES_USER:-postgres}"
BACKUP_DIR="${BACKUP_DIR:-$REPO_ROOT/backups}"

BACKUP_FILE="${1:?Usage: restore.sh <backup-file|latest>}"

if [[ "$BACKUP_FILE" == "latest" ]]; then
    BACKUP_FILE=$(ls -t "$BACKUP_DIR"/*.dump 2>/dev/null | head -1)
    if [[ -z "$BACKUP_FILE" ]]; then
        error "No backups found in $BACKUP_DIR"
        exit 1
    fi
    info "Using latest: $BACKUP_FILE"
fi

if [[ ! -f "$BACKUP_FILE" ]]; then
    error "Backup file not found: $BACKUP_FILE"
    exit 1
fi

warn "This will DROP and recreate $POSTGRES_DB!"
confirm "Restore $POSTGRES_DB from $BACKUP_FILE?" || exit 0

step "Restoring..."
pg_restore -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" \
    --clean --if-exists --no-owner \
    -d "$POSTGRES_DB" "$BACKUP_FILE"

log "Restore complete"
