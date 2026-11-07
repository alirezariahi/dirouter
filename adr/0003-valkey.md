# ADR-0003: Valkey for counters, cache, and pub/sub

- **Status:** Accepted
- **Date:** 2026-11-07
- **Decision makers:** DiRouter team

## Context

Gateway replicas need a shared view of RPM, TPM, concurrency, live budget consumption, circuit-breaker state, credential cooldowns, and model lockouts. Configuration changes must reach all gateways quickly. Operations need to be atomic and target sub-millisecond latency; PostgreSQL is not the chosen store for this hot-path workload.

### Decision drivers

- Atomic multi-step Lua operations for sliding-window or GCRA limits.
- A latency target below 1 ms.
- Pub/sub configuration notifications.
- An open license with reduced license-change risk.
- Compatibility with existing libraries, including ioredis and BullMQ.

### Considered options

1. Valkey.
2. Redis 8.
3. Per-gateway in-memory counters with quotas split between nodes.
4. NATS JetStream KV.

## Decision

Use **Valkey**, the BSD-licensed Redis fork compatible with RESP, through `ioredis`.

- Apply rate limits and budgets with atomic Lua scripts and expiring keys.
- Publish snapshot-version notifications on `config:changed`.
- Share breaker and cooldown state between replicas using TTLs.
- **Local fallback:** if Valkey is unavailable, use an in-memory limiter with quotas divided between nodes. `failMode` (`open` or `closed`) controls the failure behavior.

## Consequences

### Positive

- One component handles counters, caching, pub/sub, and the queue (ADR-005).
- The BSD license and Redis-protocol compatibility fit the selected tooling.
- The HA path is Sentinel or Cluster.

### Negative

- Valkey adds a runtime dependency; local fallback is less precise and can permit limited overshoot.
- Counters are held in memory. Budget usage must be reconciled periodically against the PostgreSQL ledger.

### Follow-up

- The distributed rate-limiter and budget implementations define algorithm details.
