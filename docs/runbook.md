[English](runbook.md) · [فارسی](runbook.fa.md)

# DiRouter operations runbook

This document is for **incident detection and containment**. The commands are written for the production Compose setup and the sample domain `example.com`; replace it with the real value. The code path is the directory that contains `compose.yaml`.

> **Validation limit:** the scenarios in this version have not been rehearsed on a staging environment, and no claim of a staging rehearsal is made. Before running a destructive action, review the command and its blast radius with a second operator. Reports of earlier tests appear only at the end of this document and with their own environment.

## 0. Incident rules and basic commands

- First determine the severity and scope: all models or one provider, one key or all keys, data plane or only dashboard/usage. Record the start time and the last change (deploy/config/secret).
- Do not put a full secret, prompt, response or `.env` in a ticket or chat. For correlation, quote only the `X-Request-Id`.
- `down -v`, deleting volumes, `prisma migrate reset/dev`, `bootstrap.sh --force`, and restoring over the main DB are not normal incident remediation.
- A blind restart erases the cause and endangers the outbox/stream. Get the logs and status first; for the gateway, use drain.
- Do not publish the `/metrics` of the services to the internet. The `exec` command below runs only inside the network/container, and it has a fallback to Node in case curl is not installed in the image.

```bash
P='docker compose -f compose.yaml -f compose.prod.yaml'
$P ps
$P logs --since=30m --tail=300 gateway control-api worker postgres valkey
curl -fsS https://api.example.com/healthz
curl -fsS https://api.example.com/readyz
curl -fsS https://admin.example.com/healthz
curl -fsS https://admin.example.com/readyz   # Postgres + Valkey; 503 means not ready
```

To read the worker metrics without publishing a port:

```bash
$P exec -T worker sh -lc 'curl -fsS http://127.0.0.1:3100/metrics 2>/dev/null || node -e "fetch(\"http://127.0.0.1:3100/metrics\").then(r=>r.text()).then(console.log)"'
```

For the gateway/control-api metrics, run the same pattern inside that service with port `8080` or `3000`. The metric names and queries are in [observability.md](observability.md).

### Quick reference table

| Dominant symptom                                                   | Go to                                                                    |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| Errors on only one provider/model, or an open breaker              | [1. Provider or credential outage](#1-provider-or-credential-outage)     |
| 429 on all replicas, inconsistent breaker, outbox growth           | [2. Valkey outage](#2-valkey-outage-or-slowdown)                         |
| Control API/worker DB errors and services' `/readyz` returning 503 | [3. PostgreSQL outage](#3-postgresql-outage-or-slowdown)                 |
| Dashboard/config broken but the LLM works with the previous config | [4. Control API outage](#4-control-api-outage)                           |
| A `dr-…` key has leaked                                            | [5. Virtual key leak](#5-virtual-key-leak)                               |
| An upstream key has leaked                                         | [6. Provider credential leak](#6-provider-credential-leak)               |
| Rotating the encryption keyring                                    | [7. MASTER_KEY rotation](#7-master_key-rotation)                         |
| Usage/logs are behind                                              | [8. Usage and request log delay](#8-usage-and-request-log-delay-or-loss) |
| Disk/volume filling up                                             | [9. Disk full](#9-disk-full)                                             |
| High CPU/concurrency/latency                                       | [10. Scale the gateway](#10-scale-the-gateway)                           |
| 5xx after a release                                                | [11. Rollback](#11-version-rollback)                                     |
| Planned deploy/restart                                             | [12. Rolling](#12-rolling-restart-and-zero-downtime-deploy)              |

## 1. Provider or credential outage

**Symptoms**

- 5xx/timeout/503 `no_available_provider` on the models of one provider; a breaker is `open`, or a credential is in cooldown/disabled.
- `X-Dirouter-Attempts > 1`, or a rise in `dirouter_gateway_request_attempts` and upstream errors; the other models are healthy.

**Diagnosis**

1. In Dashboard → **Health** and **Providers**, look at the provider/model/credential state. Distinguish the provider breaker, the model breaker, and the credential lockout/cooldown.
2. Call the provider with the same credential. 401/403 means auth/quota; 429 means quota; timeout/connection means network/proxy/DNS/TLS or upstream. Record the status and latency.
3. Limit the logs to the model and the time range. Trace the `X-Request-Id` in the gateway. Check the error metric by provider and `breaker_state{state=~"open|half_open"}`.
4. If fallback is enabled but not working: check whether the next model/provider/credential is enabled, `fallbackOn`, the budget/rate limit, and the context window. Fallback is not possible after part of a stream has been sent.

**Action**

- Route traffic through a healthy path with a combo/alias; if the broken provider is first in priority, disable it temporarily. Do not change the client's model/alias unless necessary.
- Disable or rotate the problematic credential with a healthy secret. An exhausted quota is not solved by resetting the breaker.
- Change the proxy/timeout only with evidence; raising the timeout during a full outage makes latency worse. Do not increase retry/fallback without limit.
- Resetting in Health is only for clearing temporary state **after the cause is fixed**. OWNER/ADMIN is required, and the action is audited.

**Verification**

- A successful provider test; breaker closed; non-stream and stream requests return 200 with the full content.
- The error/attempt rate returns to baseline, and the credential is not left in cooldown or disabled. The logs show attribution to the same healthy replacement provider.

## 2. Valkey outage or slowdown

**Symptoms**

- The usage and maintenance queues stop, `dirouter_queue_metrics_up == 0`, growth of `dirouter_gateway_usage_outbox_events`, or log delay.
- In fail-open mode, limits are not exact and breakers do not synchronize between replicas. In fail-closed mode, requests with a limit/budget may get 429. The `/readyz` of Control API and the worker return errors.

**Diagnosis**

```bash
$P ps valkey
$P logs --since=30m valkey gateway control-api worker
$P exec -T valkey valkey-cli ping                 # expect PONG
$P exec -T valkey valkey-cli info persistence    # AOF and last save
$P exec -T valkey valkey-cli info memory         # maxmemory/noeviction and memory pressure
```

- Separate an internal network outage from a crash/OOM/disk problem. Do not confuse `OOM command not allowed` or AOF errors with a simple outage.
- The gateway with a local/fail-open limiter can still respond; "the request is 200" does not mean the queue or budget is healthy. Take the `/metrics` output of all services.

**Action**

1. If the process is only stopped, run `$P up -d valkey` and then wait for reconnection. Do not delete the `valkeydata` volume and do not run `FLUSHALL`.
2. Fix a disk error as described in [section 9](#9-disk-full). For OOM, first understand the queue/outbox growth and memory use. Do not change the `noeviction` policy to an eviction policy as a temporary workaround, because jobs/state would be deleted.
3. If it is fail-closed and the outage is long, reducing the service or temporarily opening the limiter is a risky config change, and it must be coordinated with the service owner. Do not change the default value without a record.
4. Restart the worker in a controlled way only if it is still stuck after Valkey returns: `$P up -d --force-recreate --no-deps worker`, and allow 30 seconds for active jobs. Do not clean the queue/DLQ manually.

**Verification**

- `PONG`; `/readyz` of Control API and the worker is 200; `dirouter_queue_metrics_up == 1`.
- The outbox and waiting/active/delayed counts decrease; `outbox replayed` and `usage event written` appear; the DLQ does not grow.
- Send a few requests with a limited key and with an unlimited key; the global rate limit and the breaker/cooldown are synchronized across replicas again.

## 3. PostgreSQL outage or slowdown

**Symptoms**

- Login/dashboard/config errors; `/readyz` of Control API or the worker returns 503; Prisma connection/timeout errors; growing retries/DLQ.
- The gateway is not connected to the DB and may serve LLM traffic from the previous snapshot. Config changes, revocations and usage persistence are at risk.

**Diagnosis**

```bash
$P ps postgres
$P logs --since=30m postgres control-api worker
$P exec -T postgres pg_isready -U dirouter -d dirouter
# If the user/DB name differs, use the .env values without printing the password.
set -a; . ./.env; set +a
$P exec -T postgres pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"
$P exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c 'SELECT now(), count(*) FROM pg_stat_activity;'
```

- `accepting connections` is not enough: check the connection pool, locks and disk. Separate migration errors from the outage, and read the last `migrate`.

**Action**

- Crash loop or a simple stop: `$P up -d postgres`; wait until it is healthy. Do not manipulate the volume or the data directory.
- Pool full: limit the consumers/locks and the replicas. Do not raise `DB_MAX_CONNECTIONS` without DB capacity. Temporarily stop the worker if write pressure prevents control plane recovery, knowing that usage will fall behind in the queue/outbox.
- Failed migration: record the versions and the error. Do not run `migrate dev/reset` or a manual SQL fix without a plan. Review the compatible release and the previous migration with the DBA.
- Corruption or restore only with a healthy backup and an outage window, as described in [deploy-production](deploy-production.md#10-postgresql-backup). A restore without MASTER_KEY/KEY_PEPPER is not a full recovery.

**Verification**

- `pg_isready` and `SELECT 1` succeed; `/readyz` of both services is 200; login and config reads are healthy.
- Make one non-destructive config change (or a provider test) and check the fresh snapshot. The usage queue stays low and the DLQ does not grow. After a restore, the record counts and migration status must be checked separately.

## 4. Control API outage

**Symptoms**

- Dashboard/login/config/probe errors or 5xx from Control API; the gateway still responds with the last snapshot.
- The config version in Health stays fixed, and changes/revocations are not applied.

**Diagnosis**

```bash
curl -sS -i https://admin.example.com/healthz
curl -sS -i https://admin.example.com/readyz
$P logs --since=30m control-api gateway
$P ps control-api gateway
```

- `healthz` is only liveness; `readyz` shows the DB/Valkey errors. Separate an `INTERNAL_TOKEN` error in the gateway from a Postgres error.
- Test the gateway with an **existing, non-sensitive test model/key** to clarify the boundary between the data plane and control plane. Do not reuse a leaked key for this test.

**Action**

1. Fix the failed dependency first ([Postgres](#3-postgresql-outage-or-slowdown) / [Valkey](#2-valkey-outage-or-slowdown)).
2. If the control-api process or config is broken: `$P up -d --force-recreate --no-deps control-api`. Do not run the migration again just to restart.
3. Until it is back, freeze unnecessary config changes. For an emergency revocation of a virtual key, restoring Control API takes priority; do not replace the source of truth with a manual snapshot.
4. If the token mismatch comes after a rotation, set the same value in control-api and gateway in a coordinated way. Do not print the token in logs.

**Verification**

- `healthz` and `readyz` are both 200; login/refresh and the dashboard are healthy.
- A test config change quickly appears in the snapshot version on all replicas; an LLM request with the existing config returns 200.
- The gateway shows no snapshot/auth errors, and the usage pipeline continues its work.

## 5. Virtual key leak

**Symptoms**

- A `dr-…` key appears in Git, logs or chat, or unexpected usage on a prefix/project, model or IP.

**Diagnosis**

- Identify the source of the leak and the scope of access without republishing the secret. In Keys/Logs, check by key/project and time range, model, cost, last use and IP.
- The prefix is enough for searching; do not put the full value in the report. Use the upstream logs to contact the provider.

**Action**

1. **Immediately:** in Keys, click **Revoke**. This differs from a rotation without grace. The new snapshot must reach the gateway.
2. Create a replacement key with the minimum necessary model/limit/IP, and pass the secret to the owner only through a secure channel. Migrate the client, and keep the old one revoked.
3. Remove the secret from the repository/logs. If it was committed, purge the history according to the security process. Deleting the file alone is not a revocation. Consider the mirror, backup, CI log and artifacts contaminated too.
4. Assess the cost/usage of the abuse, and if there is an attack, temporarily limit the provider budget/rate limit. Record the incident with the revocation time.

**Verification**

- A request with the leaked key gets 401, and the replacement key gets 200. If you still do not get 401, check the config sync/Control API immediately.
- In the logs, new usage on the old key stops. The raw key does not exist in new logs/documents.

## 6. Provider credential leak

**Symptoms**

- An upstream secret appears in Git, a ticket or a log, or there is unusual usage/cost in the provider console, or 401/403 after an external revocation.

**Diagnosis**

- Identify which provider/credential and which models are exposed, using the masked prefix and the internal id. Use the provider's billing/audit.
- Compare DiRouter usage and the upstream usage for the same period; a difference can mean use outside the gateway. Do not search for or print the full secret.

**Action**

1. In the provider console, **revoke/rotate** the leaked secret, and limit any existing quota/IP restrictions.
2. Immediately **rotate** the same credential in Providers and enter the new secret. If the replacement secret is not ready, disable the credential and move the traffic to a healthy path.
3. Reset the breaker/cooldown only after saving the healthy secret. Manage the traces of the leak in the repo/log/backup, and record the cost of the abuse.
4. If MASTER_KEY has also leaked, rotating the provider alone is not enough; the next section and the re-encryption process are required.

**Verification**

- The new credential test is OK and the model request returns 200; the old credential is no longer accepted by the upstream.
- Auth/429 errors return to baseline, and the external usage stops. No new API response or audit entry contains the full secret.

## 7. MASTER_KEY rotation

`MASTER_KEY` is a keyring: `1:<old-base64>,2:<new-base64>`. The highest version is used for new encryption, and the older versions are kept for decryption.

**Symptoms/risk**

- A scheduled rotation or a keyring leak. The error `key vN is not in the keyring`/`decryption failed` means the required version was removed or the keyring is wrong.
- Changing the env does **not** re-encrypt the DB records. Removing the old key before re-encryption makes all the old credentials unreachable.

**Diagnosis and preparation**

1. Have a fresh backup and a tested restore, a copy of the old `.env`/keyring (encrypted), and an operations window.
2. Practise first on a non-production installation. Check the ciphertext versions and the re-encryption tool in the release. In this repository, there are `encrypt`/`needsReencryption` helpers, but an automatic re-encryption migration is not documented.
3. Generate the new key with a CSPRNG, and do not write it into history or chat. The new version must be unique and higher.

**Safe action**

1. Put the keyring with **old + new** identically in control-api and the gateway. Placeholder example, not a real value: `MASTER_KEY=1:<OLD>,2:<NEW>`.
2. Recreate the services in a controlled way: the gateway in rolling mode, then control-api. Do not remove any version.
3. Test the existing credentials and one new credential. This confirms that both old decryption and new encryption work.
4. With a reviewed tool, re-encrypt all old ciphertexts to the new version in a resumable transaction/batch, and take a backup and a version count before and after. If no such tool exists in the release, **stop here and keep the two-version keyring**; a simple SQL script cannot replace the decryption/AAD/GCM logic.
5. Only when no old ciphertext remains and a rollback does not need the old key, remove the old key in a separate change, and repeat step 3.

**Verification**

- Decryption of all current credentials and the provider test succeed; the decryption error count in logs is zero.
- The new secret works with the new `key_version` and returns 200; the keyring rollback and the backup remain accessible until the end of the observation window.
- `KEY_PEPPER` is different from MASTER_KEY: changing the pepper invalidates all virtual keys, and it is not part of this rotation.

## 8. Usage and request log delay or loss

**Symptoms**

- Overview/Logs are behind; cost is zero or incomplete; the outbox/backlog/DLQ grows; the budget differs from the ledger. Requests may still return 200.

**Diagnosis**

1. In the gateway, read the `dirouter_gateway_usage_outbox_events` metric; in control-api/worker, read `dirouter_queue_jobs{state=~waiting|active|delayed|failed}` and `dirouter_queue_metrics_up`.
2. Check `dirouter_usage_events_written_total`, `failed_total` and `dead_total`, and the logs `usage event write failed` / `moved to dead-letter`.
3. Measure Postgres and Valkey as in sections 2 and 3. Look at the size/permissions of the `gateway-data` volume and at the `dropping corrupt outbox line` errors.
4. With the `X-Request-Id` of a known request, find the `request completed` log in the gateway and the `usage event written` log in the worker. Its absence in the UI alone does not prove a drop; ingestion is delayed.

**Action**

- Fix the connection/DB/disk cause; do not delete the queue or outbox. `jobId=requestId` makes duplicate sends idempotent, and the worker also does not create duplicate records.
- Recreate the worker with a 30-second grace only if consumption does not resume even after the dependencies are healthy: `$P up -d --force-recreate --no-deps worker`.
- For invalid events in the DLQ, correct the contract/source version and do a controlled replay with a tested tool. Deleting the DLQ or changing the payload without a plan is forbidden; a bad event is not fixed by retrying.
- budget-reconcile reconciles the counter with the ledger every 5 minutes; evaluate the correction of the report/budget after the queue has drained, and do not create the counter manually.

**Verification**

- A new request with its request id appears in Logs, and its cost/tokens/attempts are correct.
- The outbox and backlog return to zero/normal levels, `written` increases, and `failed`/`dead` do not grow. After reconciliation, the budget agrees with the ledger.

## 9. Disk full

**Symptoms**

- PostgreSQL/Valkey write/AOF/WAL errors; the gateway cannot write its snapshot/outbox; Traefik cannot store ACME data; crash loop and `ENOSPC`.

**Diagnosis**

```bash
df -h
df -i
docker system df
docker system df -v
$P ps
$P logs --since=30m postgres valkey gateway traefik worker
```

- Break down the volumes by usage: `pgdata`, `valkeydata`, `gateway-data` and `traefik-acme`. Check `du` inside the volume mount/container, and the growth of the outbox/WAL files.
- Used inodes are different from free GB. The `json-file` log has rotation in production, but the disk/DB/outbox still grow.

**Action**

1. Contain unnecessary writes and traffic if there is a corruption risk. Free safe space on the same filesystem, or increase the disk capacity.
2. Delete only known, unnecessary artifacts. Prune old unused images carefully; **do not prune volumes or backups**. `docker system prune --volumes` is forbidden.
3. Apply `request_log` retention with the worker's existing policy, not by deleting a random partition. Move an old backup to external storage, and do not delete the only copy.
4. Do not delete the outbox: it represents unsent usage. Repair Valkey/DB so that it is replayed. If the volume is corrupted, a planned recovery is required.

**Verification**

- `df` and inodes have a safe margin; a test write to the DB (`SELECT 1`/test insert) succeeds; Valkey `PONG`/AOF is healthy.
- The gateway can write config/outbox; the outbox is low and the services are ready. Set the capacity alert with a time-bound target.

## 10. Scale the gateway

**Symptoms**

- High CPU/RAM; worse p95/TTFT; bulkhead queue or concurrency rejections; growing active streams — while the upstream and DB are healthy.

**Diagnosis**

- Read the duration, active streams, attempts and admission rejection metrics. Separate upstream errors from gateway saturation.
- Measure the Valkey capacity, bandwidth, upstream connections and provider quota. Scaling may only move the pressure to them.
- The current Compose setup runs on one host. A multi-host HA setup, or scaling Postgres/Valkey, is not created by this command.

**Action**

```bash
# Also update GATEWAY_REPLICAS in .env so that it does not drift.
make scale n=3
# Equivalent: $P up -d --no-recreate --scale gateway=3 gateway
$P ps gateway
curl -fsS https://api.example.com/readyz
```

- Keep at least two replicas for availability while increasing. Know the drain/grace and rollback settings beforehand.
- Do not scale control-api and the worker with the same pattern: a multi-replica layout of control-api is not a tested default, and the worker multiplies the DB/queue consumption.

**Verification**

- All replicas are visible in Health and are ready; `configVersion` is the same and the heartbeat is fresh.
- Traffic is distributed across the replicas, and p95/rejection improves; 5xx, retry storms, or Valkey/upstream errors do not increase. Usage stays idempotent and without abnormal backlog.

## 11. Version rollback

**Symptoms**

- After a release: an increase in 5xx; startup/migration failure; broken translation/stream; config sync or usage failure.

**Diagnosis**

- Record the current/previous `TAG`, the time of the change, the migrate log and the migration diff. Separate the boundary of the failure into provider vs config.
- **An image rollback is not a DB rollback.** If a destructive/incompatible migration was applied, the previous image may be unsafe.

**Action**

1. If the failure is widespread, stop the deploy and keep the traffic on the healthy replicas. Check the backup and the keyring access.
2. Write the previous compatible `TAG` in `.env` and pull the images of the same release; never `latest`.
3. Do not run the new migration again for the rollback. Restore the previous control-api/worker/dashboard only if the schema is compatible, and roll the gateway back as described in section 12.
4. If the schema is incompatible, choose with the service owner between an expand/contract, or a restore with an outage window (accepting the loss of data written after the backup). Do not restore at random.

```bash
# TAG=sha-<previous-verified-commit> in .env
$P pull
$P up -d --no-deps control-api worker dashboard
# Replace the gateway with the rolling method from section 12 and the previous TAG.
```

**Verification**

- Startup/readyz, login/config, a non-stream and a stream request, and usage ingestion are healthy.
- The 5xx/latency rate returns to baseline; `forced=0` during drain; the migration/DB is healthy; the image and config versions are recorded. The cause of the new release is opened as an incident.

## 12. Rolling restart and zero-downtime deploy

On receiving SIGTERM, the gateway first returns `503 {"status":"draining"}` from `/readyz`, but it still serves the existing requests. After the ready delay it is removed from Traefik's rotation and the listener is closed. Streams continue until `GATEWAY_SHUTDOWN_DRAIN_MS`, and then the UsageSink flushes. In the `drained` log, the `forced` value must be zero.

| Setting                           |                   Default | Condition                                         |
| --------------------------------- | ------------------------: | ------------------------------------------------- |
| `GATEWAY_SHUTDOWN_READY_DELAY_MS` |                      5000 | More than two rounds of the 2-second health check |
| `GATEWAY_SHUTDOWN_DRAIN_MS`       |                     30000 | Proportional to the longest allowed stream        |
| `stop_grace_period`               |                       45s | More than ready delay + drain + flush time        |
| Traefik ready check               | `/readyz`, 2s, timeout 1s | A draining replica must be removed                |

If you change the drain, change the grace too; SIGKILL can cut the stream/flush.

### Restarting the same image

With at least 2 replicas, one at a time:

```bash
for c in $($P ps -q gateway); do
  docker stop -t 45 "$c"
  docker start "$c"
  until [ "$(docker inspect -f '{{.State.Health.Status}}' "$c")" = healthy ]; do sleep 1; done
  sleep 5
done
```

If the health status is not available or a timeout occurs, do not leave the loop running indefinitely; check the state and stop before the next replica.

### Deploying a new image

First the compatible migration and control-api/worker/dashboard, then the new gateway replicas; then drain the old ones:

```bash
n=$($P ps -q gateway | wc -l | tr -d ' ')
old=$($P ps -q gateway)
$P pull gateway
$P up -d --no-deps --no-recreate --scale gateway=$((n * 2)) gateway
for c in $($P ps -q gateway); do
  until [ "$(docker inspect -f '{{.State.Health.Status}}' "$c")" = healthy ]; do sleep 1; done
done
sleep 5
for c in $old; do docker stop -t 45 "$c" && docker rm "$c"; done
```

The command above has no timeout. In a real operation, add a deadline and a failure check, and never remove all healthy replicas just to get past a failing health check.

### Checks after deploy/restart

```bash
curl -fsS https://api.example.com/readyz
curl -fsS https://admin.example.com/readyz
$P logs --since=15m gateway control-api worker
$P ps
```

- Non-stream and stream requests return 200 and complete; the config version is healthy; usage is recorded; `forced: 0`.
- `forced > 0` means a request/stream exceeded the drain limit. Adjust the grace/drain based on the real streams, or perform the deploy during a low-traffic period.

## 13. After the incident

- Record the start/detection/containment/recovery times, the actions, the version and sample request ids, without any secret.
- Assess the lost/replayed/dead-letter usage, the cost and the affected requests. "200 after recovery" is not full proof that the data is complete.
- Add the alert tool that would have shown the incident earlier, and mark in this document only the scenario that was actually executed, with date, environment and result.

## Previous verification records (not a staging rehearsal of this document)

### 2026-11-08 — rolling gateway in the development/test environment

- `apps/gateway/src/shutdown.test.ts`: during the ready delay, readyz=503 but a new request returned 200 and the stream completed in full; a long stream ended with a parseable error; a pending request got 503 on shutdown.
- Two replicas of the production image behind the dev Traefik, with production health/transport settings and a load of 16 simultaneous clients (60% non-stream and 40% three-second streams).
- First run: 942 requests returned 200 and 379 streams completed in full; second run: 1022 requests returned 200 and 416 streams completed in full; zero 5xx and `forced: 0`. These results are not claimed as staging.

Related docs: [deploy-production](deploy-production.md), [observability](observability.md), [usage pipeline](usage-pipeline.md), [routing](concepts/routing.md), [limits](concepts/limits.md).
