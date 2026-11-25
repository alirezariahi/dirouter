# High-availability deployment (card 17.3)

> Files: [`compose.ha.yaml`](../compose.ha.yaml), `deploy/ha/postgres/`, `deploy/ha/valkey/`, `scripts/backup/`. Read [deploy-production.md](deploy-production.md) first; this page only covers what the HA overlay adds.

> **Status.** The data tier of the overlay (PostgreSQL primary + standby, Valkey primary + 2 replicas + 3 sentinels) was started and exercised on 2026-11-20 as a separate Compose project on one host (macOS Docker Desktop, 4 CPUs / 4 GB, sprint 2 working tree); the results are in the [drill records](#drill-records) at the end of this page. On 2026-11-21 the whole overlay was started with production images (3 gateway, 2 control-api and 2 worker replicas) and exercised without Traefik, calling each replica directly. **Not yet exercised:** the overlay behind Traefik (load balancing and the share of requests lost when a gateway replica dies), the `backup-s3` rclone sidecar, and a point-in-time recovery rehearsal. Rehearse those on a non-production host first and add the results to the drill records.

## Topology

```
                    Traefik
                       │
        ┌──────────────┼──────────────┐
   gateway ×3     control-api ×2    dashboard
        │              │
        │        ┌─────┴──────┐
        │    postgres ──► postgres-standby   (streaming replication, manual promotion)
        │
   valkey (primary) ──► valkey-replica-1, valkey-replica-2
        ▲
   valkey-sentinel ×3  (quorum 2, automatic failover)          worker ×2
```

| Component   | Redundancy                                         | Failover                             |
| ----------- | -------------------------------------------------- | ------------------------------------ |
| gateway     | 3 stateless replicas behind Traefik                | automatic (health check every 2 s)   |
| control-api | 2 replicas; snapshot builds use a DB advisory lock | automatic                            |
| worker      | 2 replicas; schedulers are upserted, jobs run once | automatic                            |
| Valkey      | primary + 2 replicas + 3 sentinels                 | automatic, about 5 to 15 seconds     |
| PostgreSQL  | primary + hot standby                              | **manual promotion** (runbook below) |
| Backups     | daily `pg_dump`, base backup + WAL archive         | restore drill and PITR (below)       |

A single Docker host survives process and container failures, not the loss of the host. For host-level availability run these services across several hosts (Swarm or Kubernetes) or use managed PostgreSQL and Valkey; the application settings are the same.

## Starting

```bash
# .env additions
REPLICATION_PASSWORD=<long random value>   # required by the overlay, e.g. openssl rand -hex 24
# optional: HA_GATEWAY_REPLICAS=3 HA_CONTROL_API_REPLICAS=2 HA_WORKER_REPLICAS=2
# optional: HA_IP_PREFIX=10.89.250         # subnet of the internal network, see "Fixed addresses" below

C="docker compose -f compose.yaml -f compose.prod.yaml -f compose.ha.yaml"
$C up -d
./scripts/backup/pg-basebackup.sh          # first base backup, see "WAL archiving" below
```

The overlay has its own replica variables. `GATEWAY_REPLICAS` belongs to `compose.prod.yaml` and is ignored here, so a value left in `.env` cannot lower the HA default of three gateways. All variables are listed in [env-reference.md](env-reference.md).

- **New database**: the replication role, its replication slot and the `pg_hba.conf` entry are created by the init script.
- **Existing database**: init scripts do not run on a volume that already has data. Recreate the primary with the overlay first (the script and `REPLICATION_PASSWORD` only exist in that container), then run the script once:

  ```bash
  $C up -d --no-deps postgres
  $C exec -u postgres postgres sh /docker-entrypoint-initdb.d/10-replication.sh
  $C exec postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c 'SELECT pg_reload_conf()'
  $C up -d
  ```

  Recreating the primary is a short control-plane outage (`archive_mode` needs a restart); the gateway keeps serving. Valkey is recreated as well and keeps its data.

- **Existing stack without the overlay**: the overlay gives the internal network a fixed subnet, which Docker only applies when the network is created. Stop the stack and remove the `<project>_internal` network once before the first start with the overlay; see [Fixed addresses](#fixed-addresses-for-valkey-and-the-sentinels).

Check replication:

```bash
$C exec postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c 'SELECT client_addr, state, sync_state, replay_lag FROM pg_stat_replication'
$C exec postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c 'SELECT slot_name, active, wal_status, safe_wal_size FROM pg_replication_slots'
$C exec postgres-standby psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc 'SELECT pg_is_in_recovery()'   # t
$C exec valkey-sentinel-1 valkey-cli -p 26379 sentinel get-master-addr-by-name dirouter
```

### The standby and its replication slot

The standby clones the primary on its first start (`deploy/ha/postgres/standby-entrypoint.sh`). The clone is written next to the data directory and renamed when it is complete, so an interrupted clone is simply repeated; the replication slot `dirouter_standby` is dropped and created again before every clone, so a slot left behind by an interrupted attempt cannot block the retry.

The slot makes the primary keep the WAL the standby has not received yet. `max_slot_wal_keep_size` (`POSTGRES_MAX_SLOT_WAL_KEEP_SIZE`, default `2GB`) limits that: a standby that stays down longer does not fill the disk of the primary. Past the limit the slot shows `wal_status = lost`; the standby then catches up from the WAL archive as far as it can, but it has to be cloned again to stream:

```bash
$C rm -sf postgres-standby
docker volume rm dirouter_pgdata-standby     # <project name>_pgdata-standby
$C up -d postgres-standby
```

## Valkey with Sentinel

The apps receive `VALKEY_URL=redis+sentinel://valkey-sentinel-1:26379,valkey-sentinel-2:26379,valkey-sentinel-3:26379/dirouter`. The client asks the sentinels for the current primary and reconnects after a failover; nothing has to be reconfigured. Format:

```
redis+sentinel://[:password@]host1:26379,host2:26379,host3:26379/<primary name>[/db]
```

Each data node keeps its configuration in `/data/valkey.conf` and each sentinel in `/data/sentinel.conf`, both on a named volume and written only on the first start (`deploy/ha/valkey/`). Sentinel records a failover in these files, so after a restart a sentinel still knows the current primary and a demoted node is still a replica. A data node also asks the sentinels before it starts: a former primary that was down during the failover comes back as a replica of the new primary and never accepts writes as a second primary. The nodes and the sentinels announce fixed addresses on the internal network, not service names (next section).

### Fixed addresses for Valkey and the sentinels

The Valkey nodes and the sentinels have fixed addresses on the internal network and announce those addresses (`replica-announce-ip`, `sentinel announce-ip`); the sentinels also monitor the primary by address.

| Service             | Address              |
| ------------------- | -------------------- |
| `valkey`            | `${HA_IP_PREFIX}.11` |
| `valkey-replica-1`  | `${HA_IP_PREFIX}.12` |
| `valkey-replica-2`  | `${HA_IP_PREFIX}.13` |
| `valkey-sentinel-1` | `${HA_IP_PREFIX}.21` |
| `valkey-sentinel-2` | `${HA_IP_PREFIX}.22` |
| `valkey-sentinel-3` | `${HA_IP_PREFIX}.23` |

- **Why not service names.** When the primary container stops, Docker's DNS no longer resolves its name. A sentinel that monitors a name it cannot resolve enters TILT mode and never fails over; the first failover test showed exactly that (no failover after 132 s). With addresses the same test fails over in seconds (see the drill records).
- **`HA_IP_PREFIX`** (default `10.89.250`) holds the first three octets of the internal network, which becomes `${HA_IP_PREFIX}.0/24`. Change it when that subnet collides with another network on the host.
- **Upgrade note.** The subnet is applied when the `<project>_internal` network is created. A host that already runs the stack without the overlay has that network with another subnet, so stop the stack and remove the network once:

  ```bash
  docker compose -f compose.yaml -f compose.prod.yaml down      # keeps the volumes
  docker network rm dirouter_internal                           # <project>_internal, if it still exists
  $C up -d
  ```

- **The apps still use service names** for the sentinels (`redis+sentinel://valkey-sentinel-1:26379,…/dirouter`). That is fine: a client only needs to reach one running sentinel, and the sentinels answer with the address of the current primary.

```bash
$C exec valkey-sentinel-1 valkey-cli -p 26379 sentinel replicas dirouter | grep -A1 -E '^(name|flags)$'
$C exec valkey valkey-cli info replication | grep -E '^(role|master_host|master_link_status|connected_slaves)'
$C exec valkey-sentinel-1 valkey-cli -p 26379 sentinel failover dirouter     # planned switch
```

To go back to the initial layout (`valkey` as primary) use `sentinel failover`; do not delete the sentinel volumes of a running group, because sentinels without state would monitor `valkey` even when it is a replica.

During the 5 to 15 seconds of a failover the gateway behaves as in a Valkey outage: the rate limiter uses its local mode (`failMode: open`) and usage events go to the on-disk outbox, then replay. Replication is asynchronous, so the last few writes before a crash (limiter counters, queued usage events not yet replicated) can be lost; usage events also exist in the gateway outbox until they are acknowledged.

## PostgreSQL failover runbook

The gateway does not use PostgreSQL. While the database is down, **LLM traffic continues**; the dashboard and API are unavailable and usage events wait in the queue.

**When to promote:** the primary is down and will not come back quickly, or its volume is lost. If it is only restarting, wait: promotion is a one-way step.

1. Confirm the primary is really down and stop it so it cannot come back as a second primary:
   ```bash
   $C stop postgres
   ```
2. Check how far the standby is (lost transactions are those after this position):
   ```bash
   $C exec postgres-standby psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc 'SELECT pg_last_wal_replay_lsn(), now() - pg_last_xact_replay_timestamp()'
   ```
3. Promote:
   ```bash
   $C exec postgres-standby psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc 'SELECT pg_promote()'   # t
   $C exec postgres-standby psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc 'SELECT pg_is_in_recovery()'   # f
   ```
4. Point the apps at it and recreate them. `--no-deps` matters: without it Compose would start the old primary again, because the apps depend on the `postgres` service:
   ```bash
   # .env
   POSTGRES_HOST=postgres-standby
   $C up -d --no-deps control-api worker
   ```
5. Verify: `GET /readyz` of control-api, a login, one config change that reaches the gateways (`configVersion` on the Health page), and that the usage queue drains.
6. Rebuild redundancy: the old primary must **not** be started as it is. Remove its volume, and bring it back as a standby of the new primary (swap the roles of the two services, or re-clone with `pg_basebackup`). The promoted standby archives WAL into the same archive as before; take a new base backup from it right away: `PG_SERVICE=postgres-standby ./scripts/backup/pg-basebackup.sh`.

Target: steps 1 to 5 in under 10 minutes. Data loss equals the replication lag at the moment of failure (asynchronous replication; normally well under a second).

## Backups

Replication is not a backup: a wrong `DELETE` is replicated immediately. Two kinds of backup complement each other:

| Kind                       | Script                                | Restores to                           | Typical schedule   |
| -------------------------- | ------------------------------------- | ------------------------------------- | ------------------ |
| Logical dump (`pg_dump`)   | `scripts/backup/pg-backup.sh`         | the moment of the dump                | daily              |
| Base backup + archived WAL | `scripts/backup/pg-basebackup.sh`     | any moment since the base backup      | weekly; WAL always |
| Restore drill for the dump | `scripts/backup/pg-restore-verify.sh` | a scratch database, dropped afterward | monthly            |

```bash
./scripts/backup/pg-backup.sh /var/backups/dirouter        # daily, from cron
./scripts/backup/pg-basebackup.sh                          # weekly, from cron
./scripts/backup/pg-restore-verify.sh /var/backups/dirouter/dirouter-<timestamp>.dump   # monthly
```

- `pg-backup.sh` writes a compressed `pg_dump` and its SHA-256, under a temporary name until it is complete; it exits non-zero when the dump fails, is empty or has no readable table of contents. With the HA overlay you can take it from the standby (`PG_SERVICE=postgres-standby`) so the primary is not loaded; a long dump on a standby can be cancelled by replay, in which case run it on the primary. Encrypt the file and move it off the host; also keep `.env` (keyring) safe separately, because a dump without `MASTER_KEY` cannot decrypt provider credentials.
- `pg-restore-verify.sh` checks the checksum, restores the dump into a scratch database, verifies the migration history and that the core tables are readable, prints row counts, and drops the scratch database. The live database is never touched: the scratch database gets a new unique name on every run (`dirouter_restore_check_<time>_<pid>`), the script refuses to run if that name equals the live database name or already exists, it never drops anything but the database it created, and it drops that one also when the run fails or is interrupted (`KEEP=1` keeps it).
- **The drill is not free.** It needs a server that accepts writes, so by default it runs on the primary: it uses CPU and disk there, and with the HA overlay every restored row is also streamed to the standby and written to the WAL archive. Run it outside peak hours and expect roughly the size of the database in extra WAL. To keep it off the production servers entirely, point `COMPOSE` and `PG_SERVICE` at a separate PostgreSQL (for example a second Compose project on another host).

### WAL archiving and base backups

The HA overlay turns on continuous archiving on the primary (and on the standby, where it becomes active after a promotion):

- `archive_mode=on`; `archive_command` runs `deploy/ha/postgres/archive-wal.sh`, which stores every finished WAL file compressed in the `pgwal-archive` volume. It writes under a temporary name, and never overwrites an archived file with different content.
- `archive_timeout=300`: a change reaches the archive five minutes after it was made at the latest (the standby normally has it within a second).
- `pg-basebackup.sh` writes a physical backup to the `pgbasebackup` volume, keeps the newest two (`BASEBACKUP_KEEP`), and removes the archived WAL that is older than the oldest kept backup. **Until the first base backup exists the archive only grows and cannot be used**, so take one right after the first start and then on a schedule.

Watch the archiver; while archiving fails PostgreSQL keeps the WAL in `pg_wal`, which fills the data volume:

```bash
$C exec postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -xc 'SELECT archived_count, last_archived_wal, last_archived_time, failed_count, last_failed_wal, last_failed_time FROM pg_stat_archiver'
```

**Copying to S3 or MinIO.** Both volumes are on the same host as the database, which does not survive the loss of the host. The optional `backup-sync` service copies the archive and the base backups to any S3-compatible bucket once a minute:

```bash
# .env
BACKUP_S3_ENDPOINT=https://minio.example.com
BACKUP_S3_BUCKET=dirouter-backups
BACKUP_S3_ACCESS_KEY=...
BACKUP_S3_SECRET_KEY=...

$C --profile backup-s3 up -d backup-sync
$C --profile backup-s3 logs -f backup-sync
```

It writes `wal/` and `basebackup/` in the bucket and never deletes there; use a lifecycle rule of the bucket for retention, and give the key write access to this bucket only. If you prefer PostgreSQL to upload each file itself, build an image with an S3 client and replace the copy in `archive-wal.sh` (for example `aws s3 cp "$1" "s3://bucket/wal/$2"` or `mc cp`); the script must still exit non-zero whenever the file is not safely stored. Upload the daily dumps of `pg-backup.sh` with the same tool from cron.

### Point-in-time recovery

Use it when the data itself is wrong (a bad migration, a mass delete) and you need the state just before a known moment. It replaces the primary's data directory, so do it calmly, and rehearse it on a non-production host first.

1. Stop everything that uses the database (LLM traffic through the gateway continues):
   ```bash
   $C stop control-api worker postgres-standby postgres
   ```
2. Choose the newest base backup taken **before** the target time. If the host was lost, first copy `wal/` and `basebackup/` from the bucket back into the two volumes.
   ```bash
   $C run --rm --no-deps --entrypoint sh postgres -c 'ls /var/lib/postgresql/basebackup'
   ```
3. Keep a copy of the current data directory (it is the only way back if the target time was wrong), then replace it with the base backup and ask for recovery up to the target time. `restore_command` is already set by the overlay.
   ```bash
   $C run --rm --no-deps -u postgres --entrypoint sh \
     -e BACKUP=dirouter-20261201T030000Z -e TARGET='2026-12-01 14:25:00+00' postgres -ec '
       cd /var/lib/postgresql
       tar -czf "basebackup/before-pitr-$(date -u +%Y%m%dT%H%M%SZ).tar.gz" -C data .
       find data -mindepth 1 -delete
       tar -xzf "basebackup/$BACKUP/base.tar.gz" -C data
       tar -xzf "basebackup/$BACKUP/pg_wal.tar.gz" -C data/pg_wal
       touch data/recovery.signal
       printf "%s\n" "recovery_target_time = '"'"'$TARGET'"'"'" "recovery_target_action = '"'"'promote'"'"'" >> data/postgresql.auto.conf
     '
   ```
4. Start the primary alone and follow the replay until it accepts connections:
   ```bash
   $C up -d --no-deps postgres
   $C logs -f postgres          # "recovery stopping before commit ...", then "database system is ready to accept connections"
   $C exec postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc 'SELECT pg_is_in_recovery()'   # f
   $C exec postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c 'ALTER SYSTEM RESET recovery_target_time' -c 'ALTER SYSTEM RESET recovery_target_action'
   ```
   If the log says the target time is before the end of the backup, choose an older base backup.
5. Check the data, then start the apps: `$C up -d --no-deps control-api worker`.
6. The recovered primary is on a new timeline, so the old standby cannot follow it. Clone it again (commands under "The standby and its replication slot"), take a new base backup (`./scripts/backup/pg-basebackup.sh`), and remove the `before-pitr-*.tar.gz` copy once you are sure.

The replay time depends on how much WAL lies between the base backup and the target, which is one more reason to take base backups regularly. Record the duration of each rehearsal in the drill record below.

## Drill records

All rows dated 2026-11-20 were recorded on one Docker host (macOS Docker Desktop, 4 CPUs / 4 GB, sprint 2 working tree) with the data tier of the overlay running as a separate Compose project. The gateway-replica scenario, the application tier, the `backup-s3` sidecar and point-in-time recovery have no row yet because they have not been exercised.

**Monthly drill record** (add a row after each drill):

| Date       | Dump file                                        | Restore time | Applied migrations | Result                                           | Operator    | Notes                                                                                                                                                                                                                                                                                                                                                  |
| ---------- | ------------------------------------------------ | ------------ | ------------------ | ------------------------------------------------ | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2026-11-20 | `dirouter-20261120T192907Z.dump` (972,592 bytes) | 1 s          | 6                  | checks passed; scratch database dropped (0 left) | maintainers | Dump taken from the development database with `pg-backup.sh`, checksum verified; restored with `pg-restore-verify.sh` into a scratch database on the HA primary. Row counts: 3 organizations, 12 users, 16 providers, 16 credentials, 18 models, 66 API keys, 12,042 usage-ledger rows, 50 config versions, 330 audit rows; latest config version 184. |

**Failover drill record:**

| Date       | Scenario                                                                                                                                                     | Time to recover                                                    | Failed requests                        | Notes                                                                                                                                                                                                                                                                                                                                  |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-11-20 | Valkey primary stopped                                                                                                                                       | 7 s until the sentinels promoted a replica                         | — (no client load)                     | A key written before the failover was present on the new primary. A restarted sentinel kept the new primary. The old primary rejoined as a replica (link up) and received data written after the failover.                                                                                                                             |
| 2026-11-20 | Valkey primary stopped, application client                                                                                                                   | —                                                                  | 0 of 282 writes                        | The services' own Sentinel client (`connectValkey` with the `redis+sentinel://` URL) wrote every 100 ms for 40 s across the failover; the primary changed from `.11` to `.12`.                                                                                                                                                         |
| 2026-11-20 | PostgreSQL primary stopped (runbook)                                                                                                                         | 2 s for steps 1–3                                                  | — (apps not connected)                 | Standby replay lag 2.7 s at the check (idle database). `pg_promote()` returned true and `pg_is_in_recovery()` false; a row written before the outage was present and new writes were accepted. WAL archiving active on the promoted node (3 segments archived, 0 failed). Steps 4–5 (repointing the apps) were not part of this drill. |
| 2026-11-20 | Streaming replication check                                                                                                                                  | —                                                                  | —                                      | `pg_stat_replication` state `streaming`, slot `dirouter_standby` active, standby read-only and receiving rows.                                                                                                                                                                                                                         |
| 2026-11-20 | Base backup + WAL archive                                                                                                                                    | —                                                                  | —                                      | `pg-basebackup.sh` wrote a base backup; `pg_stat_archiver` showed 7 archived, 0 failed.                                                                                                                                                                                                                                                |
| 2026-11-21 | Full overlay with production images: 3 gateway, 2 control-api, 2 worker replicas (no Traefik; each replica called directly with `scripts/verify/ha-app.mjs`) | config change on all 3 gateways after 175 ms, rollback after 75 ms | 0                                      | Every replica served requests and reported its own instance id. A key limited to 6 requests per minute got exactly 6 of 18 requests through across the three replicas (one shared counter through Sentinel).                                                                                                                           |
| 2026-11-21 | Valkey primary stopped under load on the full overlay (about 38 req/s over 3 gateways, 40 s)                                                                 | sentinels moved the primary to `.12`                               | 0 of 1 522                             | p95 13 ms.                                                                                                                                                                                                                                                                                                                             |
| 2026-11-21 | PostgreSQL primary stopped under load on the full overlay (30 s)                                                                                             | —                                                                  | 0 of 1 128                             | The gateways do not use PostgreSQL on the request path; p95 11 ms.                                                                                                                                                                                                                                                                     |
| 2026-11-21 | One of three gateway replicas killed under load (30 s)                                                                                                       | —                                                                  | 0 of 748 on the two surviving replicas | Requests sent straight to the killed replica failed, as expected without a load balancer. The share lost behind Traefik (health check and retry) has not been measured. A container ended with `docker kill` is not restarted by the restart policy; start it again with `up -d`.                                                      |

The chaos test ([benchmarks/chaos.md](benchmarks/chaos.md)) can produce the numbers for the Valkey and gateway rows behind Traefik; its `gateway-replica` scenario was measured on the development stack with two replicas (0.32% failed), not yet on this overlay. `scripts/verify/ha-app.mjs` repeats the application-tier rows above (usage in the header of the script).
