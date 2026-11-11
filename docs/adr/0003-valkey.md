[English](0003-valkey.md) · [فارسی](0003-valkey.fa.md)

# ADR-0003: Valkey for counters, cache and pub/sub

- **Status:** Accepted
- **Date:** 2026-11-07
- **Deciders:** DiRouter team

## Context

Several gateway replicas must share a common view of: rate limit counters (RPM, TPM, concurrency), real-time budget consumption, circuit breaker state, key cooldowns and model lockouts. Config changes must also reach all gateways quickly. These operations must be atomic and complete in under one millisecond; Postgres is not suitable for this.

### Decision Drivers

- atomic multi-step operations (Lua script) for a sliding window or GCRA
- latency below 1ms
- pub/sub for announcing config changes
- an open license and no risk of a license change
- compatibility with existing libraries (ioredis, BullMQ)

### Considered Options

1. Valkey
2. Redis 8
3. an in-memory counter in each gateway with a divided quota
4. NATS JetStream KV

## Decision

**Valkey** (a BSD-licensed fork of Redis, compatible with the RESP protocol) with the `ioredis` client.

- rate limits and budgets with an atomic Lua script; keys with TTL.
- the pub/sub channel `config:changed` announces a new snapshot version.
- breaker and cooldown state with TTL, for sharing between replicas.
- **local fallback:** if Valkey is unavailable, an in-memory limiter with the quota divided between nodes works, and the behavior is set by `failMode` (`open` or `closed`).

## Consequences

### Positive

- one component for counters, cache, pub/sub and the queue (ADR-005).
- BSD license; compatible with all Redis tools.
- a clear HA path: Sentinel or Cluster (card 17.3).

### Negative

- a runtime dependency for the gateway; the local fallback is less accurate (it may slightly exceed the allowed limit).
- data lives in memory; the budget counter must be periodically reconciled with the ledger in Postgres.

### Follow-up

- card 6.1 (distributed rate limiter) and card 6.3 (budget) specify the algorithm details.
