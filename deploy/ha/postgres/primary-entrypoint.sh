#!/bin/sh
# Entrypoint wrapper of the PostgreSQL primary in the HA overlay (card 17.3).
#
# A fresh named volume is owned by root, so the WAL archive and base-backup directories are handed
# to the postgres user here; otherwise archive_command would fail and WAL would pile up in pg_wal.
# Everything else is left to the image entrypoint.
set -eu

WAL_ARCHIVE_DIR="${WAL_ARCHIVE_DIR:-/var/lib/postgresql/wal-archive}"
BASEBACKUP_DIR="${BASEBACKUP_DIR:-/var/lib/postgresql/basebackup}"

if [ "$(id -u)" = '0' ]; then
  for dir in "$WAL_ARCHIVE_DIR" "$BASEBACKUP_DIR"; do
    mkdir -p "$dir"
    chown postgres:postgres "$dir"
    chmod 700 "$dir"
  done
fi

exec docker-entrypoint.sh "$@"
