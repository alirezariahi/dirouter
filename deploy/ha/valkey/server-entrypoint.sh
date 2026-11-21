#!/bin/sh
# Entrypoint of every Valkey data node in the HA overlay (card 17.3).
#
# The node keeps its configuration in a file on its data volume. Sentinel persists a role change
# there (CONFIG REWRITE), so a node that was demoted or promoted keeps that role across restarts
# instead of going back to the role written in the compose file.
#
# Before starting, the node also asks the sentinels who the current primary is. A former primary
# that was down during a failover therefore comes back as a replica straight away and never
# accepts writes as a second primary.
#
# Environment:
#   NODE_NAME        service name of this node (used in log lines)
#   NODE_ADDRESS     fixed address of this node; announced to the primary and the sentinels.
#                    Addresses, not names: Docker's DNS forgets a stopped container, and a
#                    sentinel that cannot resolve the primary never fails over.
#   INITIAL_PRIMARY  first start only: replicate from this address (empty on the initial primary)
#   SENTINELS        space-separated sentinel host names
#   PRIMARY_NAME     name of the monitored group (default: dirouter)
set -eu

: "${NODE_NAME:?NODE_NAME is required}"
: "${NODE_ADDRESS:?NODE_ADDRESS is required (fixed address of this node)}"
PRIMARY_NAME="${PRIMARY_NAME:-dirouter}"
CONF=/data/valkey.conf

if [ ! -s "$CONF" ]; then
  {
    echo 'port 6379'
    echo 'dir /data'
    echo 'appendonly yes'
    echo 'maxmemory-policy noeviction'
    # Container addresses change when a container is recreated; host names do not.
    echo "replica-announce-ip $NODE_ADDRESS"
    echo 'replica-announce-port 6379'
    if [ -n "${INITIAL_PRIMARY:-}" ]; then
      echo "replicaof $INITIAL_PRIMARY 6379"
    fi
  } > "$CONF.tmp"
  mv "$CONF.tmp" "$CONF"
  echo "valkey: wrote the initial configuration for $NODE_NAME"
fi

own_addresses="$(hostname -i 2>/dev/null || true)"
is_self() {
  [ "$1" = "$NODE_NAME" ] && return 0
  [ "$1" = "$NODE_ADDRESS" ] && return 0
  for address in $own_addresses; do
    [ "$1" = "$address" ] && return 0
  done
  return 1
}

primary=''
for sentinel in ${SENTINELS:-}; do
  answer="$(timeout 3 valkey-cli -h "$sentinel" -p 26379 \
    sentinel get-master-addr-by-name "$PRIMARY_NAME" 2>/dev/null || true)"
  host="$(printf '%s\n' "$answer" | sed -n 1p)"
  port="$(printf '%s\n' "$answer" | sed -n 2p)"
  case "$port" in
    '' | *[!0-9]*) continue ;;
  esac
  case "$host" in
    '' | *[!A-Za-z0-9._:-]*) continue ;;
  esac
  primary="$host"
  primary_port="$port"
  break
done

if [ -n "$primary" ] && ! is_self "$primary"; then
  echo "valkey: the sentinels report $primary:$primary_port as primary; starting as its replica"
  set -- --replicaof "$primary" "$primary_port"
else
  set --
fi

# The image entrypoint fixes the ownership of /data and drops root.
exec docker-entrypoint.sh valkey-server "$CONF" "$@"
