#!/bin/bash
# ─────────────────────────────────────────────────
# PostgreSQL database backup.
#
# Config (env vars or .env):
#   POSTGRES_HOST     (default: localhost)
#   POSTGRES_PORT     (default: 5432)
#   POSTGRES_USER     (default: postgres)
#   POSTGRES_DB       (required)
#   BACKUP_DIR        (default: ./backups)
#   RETENTION_DAYS    (default: 14)
#
# Usage:
#   ./scripts/db/backup.sh              # Backup to local dir
#   BACKUP_DIR=/mnt/s3 ./scripts/db/backup.sh  # Custom dir
# ─────────────────────────────────────────────────

source "$(dirname "$0")/../common.sh"
load_env

require_cmd pg_dump

: "${POSTGRES_DB:?Set POSTGRES_DB}"

DB_HOST="${POSTGRES_HOST:-localhost}"
DB_PORT="${POSTGRES_PORT:-5432}"
DB_USER="${POSTGRES_USER:-postgres}"
BACKUP_DIR="${BACKUP_DIR:-$REPO_ROOT/backups}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"

DATE=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="${BACKUP_DIR}/${POSTGRES_DB}_${DATE}.dump"

mkdir -p "$BACKUP_DIR"

step "Backing up ${POSTGRES_DB}@${DB_HOST}:${DB_PORT}..."
pg_dump -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -Fc "$POSTGRES_DB" > "$BACKUP_FILE"

SIZE=$(du -h "$BACKUP_FILE" | cut -f1)
log "Backup complete: $BACKUP_FILE ($SIZE)"

# Retention cleanup
if [[ "$RETENTION_DAYS" -gt 0 ]]; then
    DELETED=$(find "$BACKUP_DIR" -name "*.dump" -mtime "+$RETENTION_DAYS" -delete -print | wc -l)
    if [[ "$DELETED" -gt 0 ]]; then
        info "Cleaned $DELETED old backups (>$RETENTION_DAYS days)"
    fi
fi

notify_telegram "💾 *DB Backup*
📦 $POSTGRES_DB
📏 $SIZE
🗑 Retention: ${RETENTION_DAYS}d"
