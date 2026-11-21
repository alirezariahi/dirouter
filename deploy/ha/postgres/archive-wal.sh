#!/bin/sh
# archive_command of the HA overlay (card 17.3): stores one finished WAL file, compressed, in the
# archive directory.
#
#   archive_command = 'sh /opt/dirouter/ha/archive-wal.sh "%p" "%f"'
#
# PostgreSQL retries a file until this script exits 0 and keeps the file in pg_wal until then, so
# the script must only succeed once the file is safely stored:
#   - it writes under a temporary name and renames, so a partial copy never looks complete;
#   - it never overwrites an archived file with different content (a sign of two primaries
#     writing to one archive); the same content again is accepted, as PostgreSQL may repeat a
#     file after a crash.
#
# To ship the archive off the host, run the `backup-sync` service (compose profile `backup-s3`)
# or copy the directory with your own tool; see docs/deploy-ha.md.
set -eu

source_path="${1:?usage: archive-wal.sh <path of the WAL file> <file name>}"
name="${2:?usage: archive-wal.sh <path of the WAL file> <file name>}"
dir="${WAL_ARCHIVE_DIR:-/var/lib/postgresql/wal-archive}"
target="$dir/$name.gz"
# The leading dot keeps unfinished files out of pg_archivecleanup and of the S3 copy.
partial="$dir/.$name.$$.partial"

if [ -f "$target" ]; then
  if gzip -dc "$target" | cmp -s - "$source_path"; then
    exit 0
  fi
  echo "archive-wal: $name is already archived with different content; refusing to overwrite" >&2
  exit 1
fi

trap 'rm -f "$partial"' EXIT
gzip -c "$source_path" > "$partial"
sync
mv "$partial" "$target"
trap - EXIT
