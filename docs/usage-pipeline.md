[English](usage-pipeline.md) · [فارسی](usage-pipeline.fa.md)

# Usage event pipeline and worker

Code: `apps/gateway/src/usage-sink.ts`, `apps/worker/src/*` · Cards 6.4, 6.5 and 3.2

```
gateway ──emit (synchronous, no I/O)──▶ memory buffer ──every 250ms or 500 events──▶ BullMQ "usage" on Valkey
   │                                     │
   │                          Valkey down? ▼
   │                         local outbox: <DATA_DIR>/outbox/usage-*.ndjson (append-only)
   │                                     │ after Valkey returns, replayed in order
   ▼
worker ──batched (createMany + skipDuplicates)──▶ request_log + usage_ledger (one transaction)
   │                                              │
   └── changed hours ──▶ Valkey set ──rollup (30s)──▶ usage_hourly ──▶ usage_daily
```

## Guarantees

| Requirement                                     | How                                                                                                                                                                                                                                                                                                         |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The request path does not wait for DB or Valkey | `emit` only appends to an array. Sending happens in the background and serially. The Valkey connection in the gateway has `enableOfflineQueue: false`, so during an outage commands fail immediately instead of hanging.                                                                                    |
| No record is lost                               | A failed batch is appended to the outbox file. Until the outbox is empty, new events also go to the outbox to keep the order. At shutdown, after drain, `sink.close()` sends the buffer or writes it to the outbox. An outbox left over from a previous run is replayed at startup.                         |
| No duplicate record is created                  | The jobId in BullMQ is the same as the `idempotencyKey` (request id), so a duplicate in the queue is merged into one. In the DB, the PK of `request_log` is `(id, created_at)` and `usage_ledger.request_id` is unique, and inserts are done with `ON CONFLICT DO NOTHING`.                                 |
| Replicas with a shared volume                   | Before replay, each outbox file is claimed by an atomic `rename` to `….replaying-<host>-<pid>`: only one replica succeeds, and the writer's next append creates a new file. The other replica's file is read again after a one-second pause. Claims older than 60 seconds (a dead replica) are taken again. |
| A bad event does not hold back the rest         | If a batch fails (for example an FK to a deleted organization), the events are written one by one. Only the bad event is retried.                                                                                                                                                                           |
| Retry and dead-letter                           | Each job has 8 attempts with exponential backoff (starting at 1 second, about 4 minutes in total). After the last attempt, or for an invalid event (`UnrecoverableError`), the job goes to the `usage-dead` queue and is kept for manual review.                                                            |

## Worker

| Job          | Schedule                                | Description                                                                                                               |
| ------------ | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `usage`      | continuous, concurrency 200             | Batches of 500 or every 200ms (`USAGE_BATCH_SIZE`, `USAGE_FLUSH_MS`). Each job's promise resolves after the batch commit. |
| `rollup`     | every 30 seconds (`ROLLUP_INTERVAL_MS`) | Flagged hours via an atomic `SPOP`, plus the current and previous hour, and then their days                               |
| `partitions` | hourly                                  | The current month and the 3 following months (advisory lock)                                                              |
| `retention`  | daily at 03:17 UTC                      | Deletes partitions older than `REQUEST_LOG_RETENTION_MONTHS` (default 3)                                                  |

- **Multiple replicas**: scheduling uses the BullMQ job scheduler, and each tick creates only one job, which only one replica takes. `upsertJobScheduler` is safe in every replica. Usage jobs also each reach only one worker.
- **Endpoints** (port 3100, internal network only): `/healthz`, `/readyz` (Postgres and Valkey) and `/metrics`.
- **Shutdown**: active jobs finish and the writer's buffer is written; then the connections are closed (`stop_grace_period: 30s`).

> ADR-001 said the worker should be "NestJS standalone". The current worker is plain TypeScript, because it has no HTTP API or complex DI, and BullMQ manages the whole job lifecycle. If a shared module with control-api is needed later, it can be added with `NestFactory.createApplicationContext`.

## Metrics

| Metric                                              | Type                                                                                              |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `dirouter_queue_jobs{queue,state}`                  | gauge: waiting, active, delayed, failed and completed for `usage`, `usage-dead` and `maintenance` |
| `dirouter_usage_events_written_total`               | counter                                                                                           |
| `dirouter_usage_events_failed_total`                | counter (failed attempt)                                                                          |
| `dirouter_usage_events_dead_total`                  | counter (moved to dead-letter)                                                                    |
| `dirouter_worker_job_duration_seconds{job,outcome}` | histogram for usage and maintenance                                                               |
| `dirouter_worker_*`                                 | default Node metrics (CPU, heap, event loop)                                                      |

## Tests

- Unit: `apps/gateway/src/usage-sink.test.ts` (outbox, ordered replay, half-finished replay, two replicas on one volume) and `apps/worker/src/writer.test.ts` (batch, duplicates, isolation of a bad event).
- Integration on real Postgres and Valkey: `apps/worker/src/pipeline.integration.test.ts` (duplicate event, exact and idempotent rollup, creating and deleting partitions), in the integration job in CI.

## Compose check (2026-11-07)

| Scenario                                                                           | Result                                                                                                                                                                                                                                                                           |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **5-minute Valkey outage** (`docker compose stop valkey`) under continuous traffic | The gateway returned 200 for the whole time: 599 responses, with not even one error. 559 events were written to one outbox file. After `start valkey`: request_log had 599 rows, the ledger 599, unique ids 599, and the outbox was empty. **No record was lost or duplicated.** |
| 100 concurrent requests and two combos                                             | 102 rows. Complete attempts in request_log (combo `gpt-4.1`: three attempts, two 503 errors on `mock-down` and success on `mock`)                                                                                                                                                |
| rollup                                                                             | `usage_hourly` and `usage_daily` correct, with counts, errors, cost and the histogram                                                                                                                                                                                            |
| **Two worker replicas** (`--scale worker=2`)                                       | 300 requests reached 300 unique rows. Each thirty-second rollup tick ran exactly once, once in worker-1 and once in worker-2, with no duplicate tick.                                                                                                                            |
| retry and dead-letter                                                              | An invalid event went to `usage-dead` after 1 attempt. An event with a missing organization (FK) went to `usage-dead` after 3 attempts, and no half-written row remained in request_log.                                                                                         |
| `/metrics`                                                                         | `dirouter_queue_jobs{queue="usage",state="completed"} 1001` and the other metrics. Prometheus scrapes it in the monitoring profile (card 8.3).                                                                                                                                   |
