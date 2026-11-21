#!/bin/sh
# Entrypoint of a Valkey sentinel in the HA overlay (card 17.3).
#
# Sentinel stores what it learns in its own configuration file: the current primary after a
# failover, the known replicas and the other sentinels. The file is therefore written only once
# and lives on a volume; regenerating it on every start would make a restarted sentinel monitor
# the original primary again.
#
# Environment:
#   NODE_NAME        service name of this sentinel (used in log lines)
#   NODE_ADDRESS     fixed address of this sentinel; announced to the other sentinels
#   INITIAL_PRIMARY  fixed address of the primary monitored on the very first start
#   PRIMARY_NAME     name of the monitored group (default: dirouter)
#   SENTINEL_QUORUM  sentinels that must agree that the primary is down (default: 2)
set -eu

: "${NODE_NAME:?NODE_NAME is required}"
: "${NODE_ADDRESS:?NODE_ADDRESS is required (fixed address of this sentinel)}"
: "${INITIAL_PRIMARY:?INITIAL_PRIMARY is required (fixed address of the first primary)}"
PRIMARY_NAME="${PRIMARY_NAME:-dirouter}"
CONF=/data/sentinel.conf

if [ ! -s "$CONF" ]; then
  {
    echo 'port 26379'
    echo 'dir /data'
    # Addresses, not names: a stopped container loses its DNS name, and a sentinel that cannot
    # resolve the primary it monitors goes into TILT mode instead of failing over.
    echo "sentinel announce-ip $NODE_ADDRESS"
    echo 'sentinel announce-port 26379'
    echo "sentinel monitor $PRIMARY_NAME $INITIAL_PRIMARY 6379 ${SENTINEL_QUORUM:-2}"
    echo "sentinel down-after-milliseconds $PRIMARY_NAME 5000"
    echo "sentinel failover-timeout $PRIMARY_NAME 30000"
    echo "sentinel parallel-syncs $PRIMARY_NAME 1"
  } > "$CONF.tmp"
  mv "$CONF.tmp" "$CONF"
  echo "sentinel: wrote the initial configuration for $NODE_NAME"
fi

# `valkey-server --sentinel` is the same program as `valkey-sentinel`; this form lets the image
# entrypoint fix the ownership of /data and drop root.
exec docker-entrypoint.sh valkey-server "$CONF" --sentinel
