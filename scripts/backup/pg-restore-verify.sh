#!/bin/sh
# Restore drill (card 17.3): restores a dump into a scratch database, checks it, and drops it.
#
#   ./scripts/backup/pg-restore-verify.sh backups/dirouter-20261201T030000Z.dump
#
# The live database is never touched:
#   - the scratch database gets a new, unique name on every run (dirouter_restore_check_<time>_<pid>);
#   - the script refuses to run if that name equals the live database name or already exists;
#   - only the database this run created is ever dropped, also when the run fails or is interrupted.
#
# The restore runs on the server of PG_SERVICE and needs one that accepts writes. On the primary
# it costs CPU and disk I/O, and with the HA overlay everything it writes is also replicated to
# the standby and archived as WAL. Run it outside peak hours, or point COMPOSE and PG_SERVICE at a
# separate PostgreSQL instance.
#
# Environment: COMPOSE, PG_SERVICE (default: postgres), POSTGRES_USER / POSTGRES_DB (default: read
# from .env, then "dirouter"), KEEP=1 to keep the scratch database for inspection.
# Exit code 0 means: checksum matched, the restore finished without errors, the migration history
# is present and the core tables are readable. The row counts are printed for the drill record.
set -eu
if (set -o pipefail) 2>/dev/null; then set -o pipefail; fi

cd "$(dirname "$0")/../.."
DUMP="${1:?usage: pg-restore-verify.sh <dump file>}"
# Deliberately unquoted where it is used: COMPOSE is a command line, not a single word.
COMPOSE="${COMPOSE:-docker compose -f compose.yaml -f compose.prod.yaml}"
PG_SERVICE="${PG_SERVICE:-postgres}"
SCRATCH="dirouter_restore_check_$(date -u +%Y%m%d%H%M%S)_$$"

# Reads one value from .env without executing the file.
env_value() {
  [ -f .env ] || return 0
  sed -n "s/^$1=//p" .env | tail -n 1 | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/"
}
PG_USER="${POSTGRES_USER:-$(env_value POSTGRES_USER)}"
PG_USER="${PG_USER:-dirouter}"
PG_DB="${POSTGRES_DB:-$(env_value POSTGRES_DB)}"
PG_DB="${PG_DB:-dirouter}"

[ -s "$DUMP" ] || { echo "dump not found or empty: $DUMP" >&2; exit 1; }
case "$SCRATCH" in
  *[!a-z0-9_]*) echo "unexpected scratch database name: $SCRATCH" >&2; exit 1 ;;
esac
if [ "$SCRATCH" = "$PG_DB" ] || [ "$SCRATCH" = 'postgres' ]; then
  echo "refusing to run: the scratch database name equals a live database ($SCRATCH)" >&2
  exit 1
fi

if [ -f "$DUMP.sha256" ]; then
  expected="$(cut -d' ' -f1 < "$DUMP.sha256")"
  if command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "$DUMP" | cut -d' ' -f1)"
  else
    actual="$(shasum -a 256 "$DUMP" | cut -d' ' -f1)"
  fi
  [ "$expected" = "$actual" ] || { echo 'checksum mismatch: the dump is corrupt' >&2; exit 1; }
  echo 'checksum ok'
else
  echo 'warning: no .sha256 file next to the dump; integrity not checked' >&2
fi

# Maintenance connection: never the live application database.
psql_admin() {
  # shellcheck disable=SC2086
  $COMPOSE exec -T "$PG_SERVICE" psql -X -v ON_ERROR_STOP=1 -At -U "$PG_USER" -d postgres "$@"
}
psql_scratch() {
  # shellcheck disable=SC2086
  $COMPOSE exec -T "$PG_SERVICE" psql -X -v ON_ERROR_STOP=1 -At -U "$PG_USER" -d "$SCRATCH" "$@"
}

created=0
cleanup() {
  status=$?
  trap - EXIT INT TERM
  if [ "$created" = '1' ]; then
    if [ "${KEEP:-0}" = '1' ]; then
      echo "scratch database kept: $SCRATCH (drop it by hand when done)" >&2
    elif ! psql_admin -c "DROP DATABASE IF EXISTS \"$SCRATCH\" WITH (FORCE)" >/dev/null; then
      echo "warning: could not drop the scratch database $SCRATCH; drop it by hand" >&2
      [ "$status" -ne 0 ] || status=1
    fi
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

in_recovery="$(psql_admin -c 'SELECT pg_is_in_recovery()')" || {
  echo "cannot reach PostgreSQL in service $PG_SERVICE" >&2
  exit 1
}
if [ "$in_recovery" != 'f' ]; then
  echo "refusing to run: $PG_SERVICE is a read-only standby; use a server that accepts writes" >&2
  exit 1
fi
existing="$(psql_admin -c "SELECT count(*) FROM pg_database WHERE datname = '$SCRATCH'")"
if [ "$existing" != '0' ]; then
  echo "refusing to run: a database named $SCRATCH already exists" >&2
  exit 1
fi
# No DROP before CREATE: an existing database is never replaced.
psql_admin -c "CREATE DATABASE \"$SCRATCH\"" >/dev/null
created=1
# pgvector, when the server has it, must exist before the tables that use it are restored.
psql_scratch -c 'CREATE EXTENSION IF NOT EXISTS vector' >/dev/null 2>&1 || true

start="$(date +%s)"
# shellcheck disable=SC2086
$COMPOSE exec -T "$PG_SERVICE" pg_restore --no-owner --exit-on-error \
  -U "$PG_USER" -d "$SCRATCH" < "$DUMP"
echo "restore finished in $(($(date +%s) - start))s"

migrations="$(psql_scratch -c 'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL')"
[ "$migrations" -gt 0 ] || { echo 'no applied migrations in the restored database' >&2; exit 1; }
echo "applied migrations: $migrations"
for table in organizations users providers credentials models api_keys usage_ledger config_versions audit_logs; do
  echo "$table: $(psql_scratch -c "SELECT count(*) FROM \"$table\"") rows"
done
latest="$(psql_scratch -c 'SELECT coalesce(max(version), 0) FROM config_versions')"
echo "latest config version: $latest"
echo 'restore drill passed'
