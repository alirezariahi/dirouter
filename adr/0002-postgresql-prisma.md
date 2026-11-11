[English](0002-postgresql-prisma.md) · [فارسی](0002-postgresql-prisma.fa.md)

# ADR-0002: PostgreSQL 17 + Prisma

- **Status:** Accepted
- **Date:** 2026-11-07
- **Decision makers:** DiRouter team

## Context

The control plane needs a relational database for organizations, users, keys, providers, models, combos, versioned configuration snapshots, and the financial ledger. Request logs also need storage, search, and dashboard aggregation. Initial research proposed ClickHouse for logs, but MVP traffic is lower and one fewer database simplifies operations.

### Decision drivers

- ACID transactions and integrity for the ledger and configuration.
- Versioned migrations from a single source of truth.
- Existing team experience with Prisma.
- Simple Docker Compose deployment and a later HA path.
- A growth path for high-volume logs and pgvector semantic caching.

### Considered options

1. PostgreSQL + Prisma.
2. PostgreSQL + Drizzle.
3. PostgreSQL for configuration and ClickHouse for logs from day one.
4. MySQL.

## Decision

Use **PostgreSQL 17** with **Prisma** as ORM and migration tooling in `@dirouter/db`.

- Store request logs in a natively **monthly-partitioned table**. Dashboard queries use **hourly and daily aggregate tables**.
- Use `$queryRaw` and hand-written migration SQL for operations Prisma does not model well: partitions, aggregate upserts, and bulk `ON CONFLICT DO NOTHING` writes.
- Monetary storage follows the implemented contracts and schema: USD `Decimal(18,8)`, decimal strings at API boundaries, and BigInt fixed-point arithmetic in shared helpers. This corrects the initial draft's obsolete integer-microdollar notation; no floating-point money arithmetic is allowed.
- Place PgBouncer in front of PostgreSQL in production.

## Consequences

### Positive

- One database covers the MVP, simplifying backups and operations.
- Schema and client types come from one source, `schema.prisma`.
- pgvector can run in the same database for semantic caching.

### Negative

- Prisma does not model partitioning. Some DDL is manual and must remain compatible with `prisma migrate`.
- Prisma client adds overhead; high-volume worker writes use bulk SQL inserts.
- Aggregating raw logs becomes costly as volume grows to millions of rows per day.

### Follow-up

- If logs exceed roughly 50 million rows per month, write a new ADR for moving logs and analytics to ClickHouse.
- Gateway must not depend on `@dirouter/db` (ADR-006).
