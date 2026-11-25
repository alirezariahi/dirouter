# ADR-0005: BullMQ for the event queue

- **Status:** Accepted
- **Date:** 2026-11-07
- **Decision makers:** DiRouter team

## Context

Gateway emits a `UsageEvent` after each request, containing cost, tokens, and the attempt chain. Direct PostgreSQL writes add request latency and couple gateway to the database, contrary to ADR-006. Events need reliable at-least-once delivery to worker, while duplicate processing must not create duplicate charges.

### Decision drivers

- Inexpensive asynchronous publication from gateway.
- At-least-once delivery, retries, and failed-job handling.
- No additional infrastructure component in the MVP.
- A mature TypeScript library.

### Considered options

1. BullMQ on Valkey.
2. Redis Streams with a custom consumer.
3. NATS JetStream.
4. Kafka / Redpanda.

## Decision

Use **BullMQ** on the same Valkey instance selected in ADR-003.

- Gateway enqueues onto `usage-events` without waiting for database persistence.
- Worker consumes events in batches. Database uniqueness and `ON CONFLICT ... DO NOTHING` make duplicate events harmless.
- Retry with exponential backoff and retain failed jobs for manual investigation.
- **Local outbox:** when Valkey is unavailable, append events to a local on-disk file and replay after recovery.
- Use repeatable BullMQ jobs for worker aggregation, partition creation, and retention.

## Consequences

### Positive

- No additional infrastructure service is required.
- Queue status and failed jobs can be exposed through a dashboard.
- Database-level idempotency is independent of queue delivery guarantees.

### Negative

- BullMQ is not the intended solution for hundreds of thousands of events per second.
- Counters and queue share Valkey; queue pressure can affect counter latency. Production can separate queue and counter instances.

### Follow-up

- If event throughput becomes a bottleneck, write a new ADR for NATS JetStream or Redpanda.
