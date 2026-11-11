[English](0002-postgresql-prisma.md) · [فارسی](0002-postgresql-prisma.fa.md)

# ADR-0002: PostgreSQL 17 + Prisma

- **Status:** Accepted
- **Date:** 2026-11-07
- **Deciders:** DiRouter team

## Context

The control plane needs a relational database for organizations, users, keys, providers, models, combos, the versioned config snapshot and the financial ledger. Request logs must also be stored, searchable and aggregated in the dashboard. Early research suggested ClickHouse for logs, but in the MVP the volume is lower, and one fewer database means simpler operations.

### Decision Drivers

- transactions and integrity for the ledger and config (ACID)
- versioned migrations from a single source
- the team's previous experience (Prisma in other projects)
- simple deployment in docker compose and a possible later HA setup
- a growth path for large logs and pgvector (semantic cache)

### Considered Options

1. PostgreSQL + Prisma
2. PostgreSQL + Drizzle
3. PostgreSQL for config and ClickHouse for logs from day one
4. MySQL

## Decision

**PostgreSQL 17** with **Prisma** as the ORM and migration tool, in the `@dirouter/db` package.

- request logs are stored in a **monthly partitioned table** (declarative partitioning), and the dashboard reads from **aggregate tables** (hourly and daily) (card 3.2).
- queries that Prisma does not support well (partitions, aggregate upserts, bulk `ON CONFLICT DO NOTHING`) are written with `$queryRaw` and manual SQL in migrations.
- monetary amounts are stored as `Decimal(18,8)` according to the contract and the current schema, exposed in the API as decimal dollar strings, and processed in calculations with BigInt fixed-point. The "exact microdollar" expression in the early draft has been replaced by the current contract; float calculation for money is not allowed.
- in production, PgBouncer sits in front of Postgres.

## Consequences

### Positive

- one database for everything in the MVP; simple backup and operations.
- schema and types are generated from one source (`schema.prisma`).
- pgvector on the same Postgres for the semantic cache (card 13.2).

### Negative

- Prisma does not model partitioning; part of the DDL is manual and must stay in sync with `prisma migrate`.
- the Prisma client has some overhead; high-volume worker paths use raw bulk inserts.
- as logs grow (millions of rows per day), aggregation on Postgres becomes slow.

### Follow-up

- if the log volume exceeds about 50 million rows per month, a new ADR will be written to move logs and analytics to ClickHouse.
- the gateway does not depend on `@dirouter/db` (ADR-006).
