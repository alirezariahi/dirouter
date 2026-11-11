[English](0006-data-plane-independence.md) · [فارسی](0006-data-plane-independence.fa.md)

# ADR-0006: The data plane does not depend on the control plane

- **Status:** Accepted
- **Date:** 2026-11-07
- **Deciders:** DiRouter team

## Context

The gateway is the critical path for customer traffic. The control plane (control-api, worker, Postgres, dashboard) changes more often, is deployed more often and is more likely to fail. If the gateway needed control-api or Postgres for every request, any outage or migration in the control plane would turn into a traffic outage.

### Decision Drivers

- 99.95% availability for LLM traffic
- control plane deploys and migrations with no effect on traffic
- low latency (no database queries on the hot path)

### Considered Options

1. The gateway reads config from the database (with a cache)
2. The gateway asks control-api on every request
3. The gateway keeps a complete, versioned snapshot in memory and on disk

## Decision

Option 3: **the gateway works only with a snapshot.**

- after every change, control-api publishes a complete `ConfigSnapshot` with a monotonic `version` and a `schemaVersion` (the schema is in `@dirouter/contracts`).
- the gateway keeps the snapshot in memory, stores it on disk, and receives changes from Valkey pub/sub or long-poll.
- if control-api is unavailable, the gateway continues with the last healthy snapshot; at boot it starts from the version on disk.
- the gateway has no code dependency on `@dirouter/db` and opens no database connection.
- accounting is asynchronous (ADR-005), and Valkey has a local fallback (ADR-003).

## Consequences

### Positive

- a full control plane outage has no effect on existing traffic.
- the hot path has no database I/O; latency is low and predictable.
- gateway behavior is reproducible: every request is processed with a specific `configVersion` and recorded in the UsageEvent.

### Negative

- config changes are applied with a short delay (usually under one second), not instantly.
- the complete snapshot grows as the number of keys grows; at large scale, an incremental (delta) snapshot is needed.
- revoking a virtual key remains valid until a new valid snapshot arrives; for immediate revocation, a separate pub/sub message (`key:revoked`) is needed.
- provider secrets (encrypted) are on the gateway's disk; `MASTER_KEY` exists only in the gateway's environment.

### Follow-up

- card 3.9 (snapshot build and publish) and card 4.2 (synchronization in the gateway).
- chaos test (card 18.1): stopping control-api and Postgres during load.
