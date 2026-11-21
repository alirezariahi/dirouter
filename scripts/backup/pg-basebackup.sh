#!/bin/sh
# Physical base backup for point-in-time recovery (card 17.3, HA overlay only).
#
#   ./scripts/backup/pg-basebackup.sh
#
# Runs deploy/ha/postgres/basebackup.sh inside the primary. The backup is written to the
# `pgbasebackup` volume; together with the WAL archive (`pgwal-archive` volume) it restores the
# database to any moment after the backup. Recovery procedure: docs/deploy-ha.md.
#
# Environment: COMPOSE (compose command with files), PG_SERVICE (default: postgres),
# BASEBACKUP_KEEP (default: 2; older backups and the WAL only they need are removed).
set -eu

cd "$(dirname "$0")/../.."
# Deliberately unquoted where it is used: COMPOSE is a command line, not a single word.
COMPOSE="${COMPOSE:-docker compose -f compose.yaml -f compose.prod.yaml -f compose.ha.yaml}"
PG_SERVICE="${PG_SERVICE:-postgres}"
KEEP="${BASEBACKUP_KEEP:-2}"

# shellcheck disable=SC2086
$COMPOSE exec -T -u postgres -e BASEBACKUP_KEEP="$KEEP" "$PG_SERVICE" \
  sh /opt/dirouter/ha/basebackup.sh
