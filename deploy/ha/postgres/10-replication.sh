#!/bin/sh
# Creates the replication role, its replication slot and its pg_hba.conf entry (card 17.3).
# Safe to run more than once.
#
# Runs automatically on a NEW primary (docker-entrypoint-initdb.d). On a primary that already has
# data, run it once by hand, then reload the configuration:
#
#   docker compose ... exec -u postgres postgres sh /docker-entrypoint-initdb.d/10-replication.sh
#   docker compose ... exec postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c 'SELECT pg_reload_conf()'
set -eu

: "${REPLICATION_PASSWORD:?REPLICATION_PASSWORD is required}"
: "${POSTGRES_USER:?POSTGRES_USER is required}"
PGDATA="${PGDATA:-/var/lib/postgresql/data}"
SLOT="${STANDBY_SLOT:-dirouter_standby}"

# The password and the slot name are passed as psql variables, never interpolated into the SQL.
psql -v ON_ERROR_STOP=1 -v pw="$REPLICATION_PASSWORD" -v slot="$SLOT" \
  --username "$POSTGRES_USER" --dbname "${POSTGRES_DB:-$POSTGRES_USER}" <<'SQL'
SELECT format('CREATE ROLE replicator WITH REPLICATION LOGIN PASSWORD %L', :'pw')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'replicator') \gexec
SELECT format('ALTER ROLE replicator WITH REPLICATION LOGIN PASSWORD %L', :'pw') \gexec
-- The slot exists before the standby connects for the first time, so no WAL it needs is recycled.
SELECT pg_create_physical_replication_slot(:'slot', true)
WHERE NOT EXISTS (SELECT 1 FROM pg_replication_slots WHERE slot_name = :'slot');
SQL

if ! grep -q '^host replication replicator ' "$PGDATA/pg_hba.conf"; then
  echo 'host replication replicator all scram-sha-256' >> "$PGDATA/pg_hba.conf"
fi
