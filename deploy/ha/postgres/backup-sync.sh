#!/bin/sh
# Entrypoint of the optional `backup-sync` service (compose profile `backup-s3`, card 17.3).
#
# Copies the WAL archive and the base backups to an S3-compatible bucket once a minute:
#
#   s3://<bucket>/wal/          compressed WAL files, never overwritten
#   s3://<bucket>/basebackup/   one directory per base backup
#
# Nothing is ever deleted from the bucket; set a lifecycle rule there for retention. The S3
# connection comes from the RCLONE_CONFIG_BACKUP_* variables set in compose.ha.yaml.
set -eu

: "${BACKUP_S3_BUCKET:?BACKUP_S3_BUCKET is required for the backup-s3 profile}"
: "${RCLONE_CONFIG_BACKUP_ENDPOINT:?BACKUP_S3_ENDPOINT is required for the backup-s3 profile}"
: "${RCLONE_CONFIG_BACKUP_ACCESS_KEY_ID:?BACKUP_S3_ACCESS_KEY is required for the backup-s3 profile}"
: "${RCLONE_CONFIG_BACKUP_SECRET_ACCESS_KEY:?BACKUP_S3_SECRET_KEY is required for the backup-s3 profile}"
INTERVAL="${BACKUP_SYNC_INTERVAL_SECONDS:-60}"

trap 'exit 0' TERM INT
while :; do
  # --immutable: an archived WAL file that already exists in the bucket is never modified.
  rclone copy /backup/wal "backup:$BACKUP_S3_BUCKET/wal" --immutable --exclude '.*' ||
    echo 'backup-sync: copying the WAL archive failed; retrying on the next round' >&2
  rclone copy /backup/basebackup "backup:$BACKUP_S3_BUCKET/basebackup" --exclude '*.partial/**' ||
    echo 'backup-sync: copying the base backups failed; retrying on the next round' >&2
  sleep "$INTERVAL" &
  wait $!
done
