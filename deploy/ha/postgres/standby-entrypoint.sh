#!/bin/sh
# Entrypoint of the PostgreSQL hot standby (card 17.3).
#
# First start (no data directory): clone the primary with pg_basebackup and write the standby
# configuration (-R). Later starts: just run postgres; it keeps following the primary until it is
# promoted (see docs/deploy-ha.md).
#
# The clone is written to "$PGDATA.partial" and renamed when it is complete. An interrupted clone
# is thrown away and repeated, and an existing data directory (a standby or a promoted primary)
# is never deleted by this script.
set -eu

: "${PRIMARY_HOST:?PRIMARY_HOST is required}"
: "${REPLICATION_PASSWORD:?REPLICATION_PASSWORD is required}"
PGDATA="${PGDATA:-/var/lib/postgresql/data/pgdata}"
SLOT="${STANDBY_SLOT:-dirouter_standby}"
WAL_ARCHIVE_DIR="${WAL_ARCHIVE_DIR:-/var/lib/postgresql/wal-archive}"
BASEBACKUP_DIR="${BASEBACKUP_DIR:-/var/lib/postgresql/basebackup}"
export PGDATA

if [ "$(id -u)" = '0' ]; then
  parent="$(dirname "$PGDATA")"
  mkdir -p "$parent" "$WAL_ARCHIVE_DIR" "$BASEBACKUP_DIR"
  chown postgres:postgres "$parent" "$WAL_ARCHIVE_DIR" "$BASEBACKUP_DIR"
  chmod 700 "$WAL_ARCHIVE_DIR" "$BASEBACKUP_DIR"
  # The official image ships gosu; older Alpine variants shipped su-exec.
  if command -v gosu >/dev/null 2>&1; then
    exec gosu postgres /bin/sh "$0" "$@"
  fi
  exec su-exec postgres /bin/sh "$0" "$@"
fi

if [ ! -s "$PGDATA/PG_VERSION" ]; then
  if [ -d "$PGDATA" ] && [ -n "$(ls -A "$PGDATA")" ]; then
    echo "standby: $PGDATA is not empty but is not a data directory; refusing to touch it" >&2
    exit 1
  fi
  partial="$PGDATA.partial"
  rm -rf "$partial"

  echo "standby: cloning primary $PRIMARY_HOST"
  export PGPASSWORD="$REPLICATION_PASSWORD"
  until pg_isready -h "$PRIMARY_HOST" -p 5432 -q; do
    echo 'standby: waiting for the primary'
    sleep 2
  done

  # Start from a fresh replication slot. A slot left by an interrupted clone, or one that was
  # invalidated by max_slot_wal_keep_size while the standby was away, is dropped first. Both are
  # replication-protocol commands, so the replicator role needs no access to any database.
  replication() {
    psql -X -q -At -v ON_ERROR_STOP=1 \
      "host=$PRIMARY_HOST port=5432 user=replicator dbname=replication replication=true" -c "$1"
  }
  replication "DROP_REPLICATION_SLOT $SLOT" >/dev/null 2>&1 || true
  if ! replication "CREATE_REPLICATION_SLOT $SLOT PHYSICAL RESERVE_WAL" >/dev/null; then
    # Usually: the slot exists and could not be dropped. pg_basebackup reports it if it is unusable.
    echo "standby: could not create slot $SLOT; trying the existing one" >&2
  fi

  # -R writes standby.signal, primary_conninfo and primary_slot_name. The slot makes the primary
  # keep the WAL this standby still needs (bounded by max_slot_wal_keep_size).
  pg_basebackup -h "$PRIMARY_HOST" -p 5432 -U replicator -D "$partial" \
    -X stream -R -S "$SLOT" --checkpoint=fast
  unset PGPASSWORD

  [ -d "$PGDATA" ] && rmdir "$PGDATA"
  mv "$partial" "$PGDATA"
  chmod 700 "$PGDATA"
  echo 'standby: base backup finished'
fi

# compose.ha.yaml passes the same server options as on the primary.
if [ "$#" -eq 0 ]; then
  set -- postgres -c hot_standby=on
fi
exec "$@"
