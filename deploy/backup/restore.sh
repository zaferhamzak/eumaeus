#!/bin/sh
# Restore an Eumaeus backup into an EMPTY database.
#   restore.sh backups/eumaeus-20260928T030000Z.dump
# Connection comes from the standard PG* variables (PGHOST, PGUSER,
# PGPASSWORD, PGDATABASE). Stop the api and worker first. The same
# SECRET_ENCRYPTION_KEY must be used afterwards, or stored mailbox passwords
# and tokens can't be decrypted.
set -eu
file="${1:?usage: restore.sh <backup.dump>}"
[ -f "$file" ] || { echo "no such file: $file" >&2; exit 1; }
tables="$(psql -tAc "select count(*) from information_schema.tables where table_schema = 'public'")"
if [ "$tables" != "0" ]; then
  echo "database $PGDATABASE is not empty ($tables tables) — restore into an empty database" >&2
  exit 1
fi
pg_restore --no-owner --exit-on-error --dbname="$PGDATABASE" "$file"
echo "restored $file into $PGDATABASE"
