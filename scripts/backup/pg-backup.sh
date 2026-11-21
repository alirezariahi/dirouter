#!/bin/sh
# Logical PostgreSQL backup (card 17.3): one compressed dump plus its SHA-256.
#
#   ./scripts/backup/pg-backup.sh [output-directory]
#
# Environment: COMPOSE (compose command with files), PG_SERVICE (default: postgres),
# POSTGRES_USER / POSTGRES_DB (default: read from .env, then "dirouter").
# The dump contains encrypted credentials and usage data: encrypt it and move it off this host.
# For point-in-time recovery see pg-basebackup.sh and docs/deploy-ha.md.
set -eu
if (set -o pipefail) 2>/dev/null; then set -o pipefail; fi

cd "$(dirname "$0")/../.."
OUT_DIR="${1:-./backups}"
# Deliberately unquoted where it is used: COMPOSE is a command line, not a single word.
COMPOSE="${COMPOSE:-docker compose -f compose.yaml -f compose.prod.yaml}"
PG_SERVICE="${PG_SERVICE:-postgres}"

# Reads one value from .env without executing the file.
env_value() {
  [ -f .env ] || return 0
  sed -n "s/^$1=//p" .env | tail -n 1 | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/"
}
PG_USER="${POSTGRES_USER:-$(env_value POSTGRES_USER)}"
PG_USER="${PG_USER:-dirouter}"
PG_DB="${POSTGRES_DB:-$(env_value POSTGRES_DB)}"
PG_DB="${PG_DB:-dirouter}"

umask 077
mkdir -p "$OUT_DIR"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
file="$OUT_DIR/dirouter-$stamp.dump"
tmp="$file.partial"

# Written to a temporary name first: an interrupted or failed run never leaves a file that looks
# complete.
trap 'rm -f "$tmp"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# shellcheck disable=SC2086
$COMPOSE exec -T "$PG_SERVICE" pg_dump -U "$PG_USER" -d "$PG_DB" -Fc > "$tmp"
[ -s "$tmp" ] || { echo 'backup is empty' >&2; exit 1; }
# A truncated dump has no readable table of contents.
# shellcheck disable=SC2086
entries="$($COMPOSE exec -T "$PG_SERVICE" pg_restore --list < "$tmp" | grep -c -v '^;' || true)"
[ "${entries:-0}" -gt 0 ] || { echo 'backup has no restorable entries' >&2; exit 1; }

mv "$tmp" "$file"
trap - EXIT
name="$(basename "$file")"
if command -v sha256sum >/dev/null 2>&1; then
  (cd "$OUT_DIR" && sha256sum "$name" > "$name.sha256")
else
  (cd "$OUT_DIR" && shasum -a 256 "$name" > "$name.sha256")
fi
echo "$file"
