#!/bin/sh
# Physical base backup for point-in-time recovery (card 17.3). Runs INSIDE the primary container
# as the postgres user; scripts/backup/pg-basebackup.sh is the host-side wrapper.
#
# Result: $BASEBACKUP_DIR/dirouter-<timestamp>/{base.tar.gz,pg_wal.tar.gz,backup_manifest}.
# A base backup plus the WAL archived after it can restore the database to any moment since the
# backup. The newest BASEBACKUP_KEEP backups are kept (default 2); archived WAL older than the
# oldest kept backup is removed, because nothing can use it any more.
set -eu

: "${POSTGRES_USER:?POSTGRES_USER is required}"
BASEBACKUP_DIR="${BASEBACKUP_DIR:-/var/lib/postgresql/basebackup}"
WAL_ARCHIVE_DIR="${WAL_ARCHIVE_DIR:-/var/lib/postgresql/wal-archive}"
KEEP="${BASEBACKUP_KEEP:-2}"
case "$KEEP" in
  '' | *[!0-9]* | 0) echo 'basebackup: BASEBACKUP_KEEP must be a positive integer' >&2; exit 1 ;;
esac
[ -d "$BASEBACKUP_DIR" ] && [ -w "$BASEBACKUP_DIR" ] || {
  echo "basebackup: $BASEBACKUP_DIR is missing or not writable" >&2
  exit 1
}

label="dirouter-$(date -u +%Y%m%dT%H%M%SZ)"
target="$BASEBACKUP_DIR/$label"
partial="$target.partial"

# Remove what an interrupted earlier run left behind, and this run's directory if it fails.
find "$BASEBACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -name 'dirouter-*.partial' -exec rm -rf {} +
trap 'rm -rf "$partial"' EXIT

pg_basebackup -U "$POSTGRES_USER" -D "$partial" -Ft -z -X stream --checkpoint=fast -l "$label"
[ -s "$partial/base.tar.gz" ] || { echo 'basebackup: base.tar.gz is missing or empty' >&2; exit 1; }
gzip -t "$partial/base.tar.gz"
mv "$partial" "$target"
trap - EXIT
echo "basebackup: wrote $target"

# Retention: keep the newest $KEEP backups. The names sort by time.
total="$(find "$BASEBACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -name 'dirouter-*Z' | wc -l)"
if [ "$total" -gt "$KEEP" ]; then
  find "$BASEBACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -name 'dirouter-*Z' | sort |
    head -n "$((total - KEEP))" | while IFS= read -r old; do
    rm -rf "$old"
    echo "basebackup: removed $old"
  done
fi

# WAL older than the start of the oldest kept backup is no longer needed. The start position is
# taken from the backup history file that PostgreSQL archives at the end of every base backup.
oldest="$(find "$BASEBACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -name 'dirouter-*Z' | sort | head -n 1)"
history=''
for file in "$WAL_ARCHIVE_DIR"/*.backup.gz; do
  [ -f "$file" ] || continue
  if gzip -dc "$file" | grep -q "^LABEL: $(basename "$oldest")\$"; then
    history="$(basename "$file" .gz)"
    break
  fi
done
if [ -n "$history" ]; then
  pg_archivecleanup -x .gz "$WAL_ARCHIVE_DIR" "$history"
  echo "basebackup: removed archived WAL older than $history"
else
  echo 'basebackup: no archived history file for the oldest kept backup yet; WAL archive left as it is' >&2
fi
