#!/bin/sh
# Postgres backups for Eumaeus.
#   backup.sh            one backup now
#   backup.sh --loop     one backup every BACKUP_INTERVAL_HOURS, forever
# Each backup is a pg_dump custom-format file (compressed; restore with
# restore.sh). Files older than BACKUP_RETENTION_DAYS are deleted after a
# successful backup only — a failing backup never removes the old ones.
# Connection comes from the standard PG* variables.
set -eu
BACKUP_DIR="${BACKUP_DIR:-./backups}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
INTERVAL_HOURS="${BACKUP_INTERVAL_HOURS:-24}"

backup_once() {
  mkdir -p "$BACKUP_DIR"
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  tmp="$BACKUP_DIR/.eumaeus-$stamp.dump.partial"
  final="$BACKUP_DIR/eumaeus-$stamp.dump"
  if pg_dump --format=custom --no-owner --file="$tmp"; then
    mv "$tmp" "$final"
    echo "backup ok: $final ($(du -h "$final" | cut -f1))"
    find "$BACKUP_DIR" -name 'eumaeus-*.dump' -type f -mtime "+$RETENTION_DAYS" -print -delete | sed 's/^/removed old backup: /'
  else
    rm -f "$tmp"
    echo "backup FAILED at $stamp" >&2
    return 1
  fi
}

if [ "${1:-}" = "--loop" ]; then
  while true; do
    backup_once || true
    sleep "$((INTERVAL_HOURS * 3600))"
  done
else
  backup_once
fi
