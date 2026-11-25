[English](0007-job-state-in-valkey.md) · [فارسی](0007-job-state-in-valkey.fa.md)

# ADR-0007: State of files, batches and async tasks lives in Valkey and is driven by the gateway

- **Status:** Accepted
- **Date:** 2026-11-25
- **Deciders:** DiRouter team

## Context

Until sprint 5 every data-plane request finished within one HTTP exchange. The Files and Batch API (card 30.1) and async tasks such as video generation (card 30.6) are the first endpoints whose state outlives the request: a file is kept for days, a batch runs for up to 24 hours at the provider, a video for minutes, and webhooks must be retried after failures. Something must keep that state, follow the provider until the job ends, and record usage and settle the wallet exactly once.

### Decision Drivers

- ADR-0006: the gateway never depends on control-api or Postgres for traffic, and only the gateway holds `MASTER_KEY`, so only it can decrypt provider credentials.
- Several gateway replicas serve the same organization; any of them may receive the next `GET /v1/batches/{id}`.
- Usage is recorded once per batch or task, at completion, even if a replica dies mid-way.

### Considered Options

1. Records in Postgres through control-api; the worker polls providers.
2. Records in Valkey; the worker polls providers.
3. Records in Valkey; a job poller inside every gateway replica polls providers, with per-item locks.

## Decision

Option 3.

- File, batch, task and webhook-delivery records are JSON values in Valkey with a TTL (`dirouter:jobs:<kind>:<id>`), listed per organization through a sorted set; without Valkey (a single local node) the same store runs in memory.
- File bytes go to an object store, not Valkey: a local volume or an S3-compatible bucket (`FILES_STORAGE`).
- Work that is due later (check a batch or task at the provider, retry a webhook, delete an expired file) sits in one sorted set by due time. A poller in each gateway replica takes due items and locks each one (`SET NX PX`), so replicas share the work and nothing runs twice; a lock expires if its replica dies. A client that retrieves a job also refreshes it.
- Finishing a job (copying results, the usage event with the job's id as idempotency key, the wallet settle) happens under the lock and is recorded in the job, so it happens once.
- Option 2 was rejected because the worker would need `MASTER_KEY` and the provider credentials, which ADR-0006 keeps in the gateway only; option 1 additionally puts control-api on the path of every job step.

## Consequences

### Positive

- The data plane keeps working through a control-plane outage, as for every other request.
- No new service: the poller is a small loop in a process that already has the credentials, the SSRF guard and the outbound proxies.
- Usage and billing flow through the existing usage queue, so the ledger needs no change.

### Negative

- Job records are not in Postgres: they cannot be queried in SQL and are lost if Valkey loses its data (Valkey persistence must be on, which the Compose and Helm setups already do).
- The poller adds a little background load to the gateway (one sorted-set read per second per replica).
- A local `FILES_STORAGE` only works with one replica or a shared volume; HA setups need S3.

### Follow-up

- Card 30.1 (files and batches) and card 30.6 (async tasks and webhooks).
