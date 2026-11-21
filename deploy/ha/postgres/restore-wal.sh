#!/bin/sh
# restore_command of the HA overlay (card 17.3): the counterpart of archive-wal.sh.
#
#   restore_command = 'sh /opt/dirouter/ha/restore-wal.sh "%f" "%p"'
#
# A missing file is normal (PostgreSQL asks for files that do not exist yet and then switches to
# streaming), so that case exits non-zero without printing anything.
set -eu

name="${1:?usage: restore-wal.sh <file name> <target path>}"
target="${2:?usage: restore-wal.sh <file name> <target path>}"
dir="${WAL_ARCHIVE_DIR:-/var/lib/postgresql/wal-archive}"

[ -f "$dir/$name.gz" ] || exit 1
gzip -dc "$dir/$name.gz" > "$target"
