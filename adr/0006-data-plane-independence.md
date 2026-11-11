[English](0006-data-plane-independence.md) · [فارسی](0006-data-plane-independence.fa.md)

# ADR-0006: Data-plane independence from the control plane

- **Status:** Accepted
- **Date:** 2026-11-07
- **Decision makers:** DiRouter team

## Context

Gateway is the critical path for customer traffic. The control plane (control-api, worker, PostgreSQL, and dashboard) changes and deploys more frequently and has more opportunities for failure. If every request needs control-api or PostgreSQL, a control-plane outage or migration becomes a traffic outage.

### Decision drivers

- A target availability of 99.95% for LLM traffic.
- Control-plane deployment and migration without interrupting traffic.
- Low latency, with no database queries on the hot path.

### Considered options

1. Gateway reads configuration from the database, with caching.
2. Gateway calls control-api for each request.
3. Gateway retains a complete, versioned configuration snapshot in memory and on disk.

## Decision

Choose option 3: **gateway operates from snapshots**.

- After configuration changes, control-api publishes a complete `ConfigSnapshot` with monotonic `version` and `schemaVersion`; the schema lives in `@dirouter/contracts`.
- Gateway keeps the snapshot in memory, persists it to disk, and receives changes through Valkey pub/sub or long polling.
- When control-api is unavailable, gateway continues using the last valid snapshot and can bootstrap from its on-disk copy.
- Gateway has no code dependency on `@dirouter/db` and opens no database connection.
- Accounting is asynchronous (ADR-005), and Valkey has a local fallback (ADR-003).

## Consequences

### Positive

- A complete control-plane outage does not interrupt existing configured traffic.
- The hot path avoids database I/O, supporting low and predictable latency.
- Request behavior is reproducible: each request records its `configVersion` in UsageEvent.

### Negative

- Configuration changes take a short time to propagate, typically targeting less than a second, rather than applying instantly.
- Complete snapshots grow with the key population; larger deployments may need incremental snapshots.
- A revoked virtual key can remain usable until the new snapshot arrives. Immediate revocation requires a separate notification such as `key:revoked`.
- Encrypted provider secrets are present on gateway disks. `MASTER_KEY` must be supplied securely to gateway through its environment, not persisted in the snapshot.

### Follow-up

- Implement snapshot generation/publication and gateway synchronization.
- Chaos test: interrupt control-api and PostgreSQL while serving load.
