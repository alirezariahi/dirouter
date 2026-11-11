[English](architecture.md) · [فارسی](architecture.fa.md)

# DiRouter Architecture

> Every document is bilingual: an English `.md` file and a Persian `.fa.md` file sit side by side, and detailed guides live in `code/docs/`. See [CONTRIBUTING.md](../CONTRIBUTING.md) for the [documentation policy](../CONTRIBUTING.md#documentation-policy).

> This document is the basis for all Sprint 1 board cards. The decisions and their rationale are in the [ADRs](adr/README.md), and the definitions of concepts are in the [glossary](glossary.md).

## 1. Overview

DiRouter has two separate parts:

- **Data plane** (`apps/gateway`): the hot path of every LLM request. Virtual key authentication, rate limiting, budgets, routing, format translation, failover, and streaming. It must be fast, stateless, and independent of the control plane.
- **Control plane** (`apps/control-api`, `apps/worker`, `apps/dashboard`): management of organizations, users, providers, keys, models, and combos; config publishing; processing of usage events; reports and the dashboard.

The first design principle ([ADR-006](adr/0006-data-plane-independence.md)): **the data plane does not depend on the control plane.** If Postgres, control-api, or worker become unavailable, traffic continues with the last healthy config.

```mermaid
flowchart LR
  client["Client<br/>(OpenAI / Anthropic SDK, Claude Code, Cursor …)"]
  admin["Administrator<br/>(browser)"]

  subgraph edge["Edge"]
    traefik["Traefik v3<br/>TLS, routing, SSE"]
  end

  subgraph dp["Data plane"]
    gw1["gateway #1"]
    gw2["gateway #N"]
    disk[("snapshot on disk<br/>+ local outbox")]
  end

  subgraph cp["Control plane"]
    api["control-api<br/>NestJS"]
    worker["worker<br/>BullMQ consumer"]
    dash["dashboard<br/>React + Vite"]
  end

  subgraph data["Data stores"]
    valkey[("Valkey<br/>counters, cache, pub/sub, queue")]
    pg[("PostgreSQL 17<br/>config, ledger, logs")]
  end

  providers["Providers<br/>OpenAI, Anthropic, Gemini, Azure, OpenAI-compatible"]

  client -->|"/v1/chat/completions<br/>/v1/messages"| traefik
  admin --> traefik
  traefik --> gw1 & gw2
  traefik -->|"/api"| api
  traefik -->|"/"| dash

  gw1 & gw2 -->|"HTTPS (+proxy)"| providers
  gw1 & gw2 <-->|"rate limit, budget, cooldown"| valkey
  gw1 & gw2 -->|"UsageEvent"| valkey
  gw1 & gw2 --- disk

  api -->|"ConfigSnapshot + pub/sub"| valkey
  api <--> pg
  worker -->|"usage queue"| valkey
  worker -->|"ledger, logs, aggregation"| pg
  dash -->|"REST"| api
```

## 2. Components

| Component         | Responsibility                                                                                                            | Hard runtime dependency           |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| **Traefik**       | TLS (Let's Encrypt), routing by path, health checks, unbuffered SSE pass-through                                          | —                                 |
| **gateway**       | OpenAI- and Anthropic-compatible API, routing, failover, circuit breaker, rate limiting, budgets, publishing usage events | none (Valkey with local fallback) |
| **control-api**   | Management API, dashboard authentication, RBAC, credential encryption, building and publishing ConfigSnapshot             | Postgres, Valkey                  |
| **worker**        | Consuming the UsageEvent queue, writing the ledger and logs, aggregate tables, partition maintenance                      | Postgres, Valkey                  |
| **dashboard**     | Persian, RTL management interface                                                                                         | control-api                       |
| **mock-provider** | Simulated provider with injected 429, 5xx, and latency for testing and chaos                                              | —                                 |
| **Valkey**        | Rate-limit and budget counters, cooldown and breaker state, config-change pub/sub, BullMQ queue                           | —                                 |
| **PostgreSQL**    | Source of truth for config, users, the financial ledger, and request logs (partitioned)                                   | —                                 |

## 3. Path of a request

```mermaid
sequenceDiagram
  autonumber
  participant C as Client
  participant T as Traefik
  participant G as gateway
  participant V as Valkey
  participant P1 as Provider A
  participant P2 as Provider B

  C->>T: POST /v1/messages (Bearer dr-live-…)
  T->>G: proxy (unbuffered)
  G->>G: HMAC of the key → lookup in the in-memory snapshot
  G->>V: rate limit + budget check (atomic Lua)
  V-->>G: allowed
  G->>G: alias/combo → list of targets; drop circuit-open targets or those in cooldown
  G->>G: translate Anthropic → canonical → OpenAI
  G->>P1: request (connect / TTFT / idle timeouts)
  P1-->>G: 529 overloaded
  G->>V: record error for breaker and key cooldown
  G->>P2: fallback to the next target (no byte has been sent to the client yet)
  P2-->>G: SSE stream
  G-->>C: stream translated to the Anthropic format
  G->>V: increase budget usage + publish UsageEvent (async)
```

Steps in the gateway:

1. **Entry and authentication** — the virtual key is read from `Authorization: Bearer` or `x-api-key`, hashed with HMAC-SHA256, and looked up in the in-memory snapshot. There is no database query on the hot path.
2. **Validation** — the body is validated against the `@dirouter/contracts` schema. Unknown fields are preserved.
3. **Limits** — rate limits (RPM, TPM, concurrency) and budgets at the key, project, and team level, using one atomic Lua script on Valkey. If Valkey is unavailable, the local limiter and `failMode` decide.
4. **Routing** — the model name is resolved to an alias, a combo, or a model, and an ordered list of targets (model + credential) is built. Circuit-open targets, keys in cooldown, and locked-out models are set aside.
5. **Translation** — the request is translated to the canonical model and from there to the destination API (N + M translators instead of N × M).
6. **Sending and resilience** — multi-layer timeouts, retry with backoff and jitter, fallback to the next target. Fallback during a stream is allowed only before the first byte is sent to the client.
7. **Response** — the response or stream is returned in the format of the inbound API. Errors also use the format of that API and DiRouter's stable codes.
8. **Accounting** — the cost is computed from usage and the model price, added to the budget counter in Valkey, and a `UsageEvent` is queued. The response does not wait for this step.

## 4. Usage event path

```mermaid
flowchart LR
  gw["gateway"] -->|"enqueue (async)"| q[["BullMQ queue<br/>usage-events"]]
  gw -.->|"Valkey unavailable"| outbox[("local outbox<br/>file on disk")]
  outbox -.->|"replay after reconnect"| q
  q --> w["worker"]
  w -->|"INSERT … ON CONFLICT (idempotency_key) DO NOTHING"| logs[("request_logs<br/>monthly partition")]
  w --> ledger[("ledger")]
  w --> agg[("aggregate tables<br/>hourly / daily")]
  agg --> api["control-api"] --> dash["dashboard"]
```

- Every event has an `idempotencyKey`; a repeated event (a queue retry or an outbox replay) does not record the cost twice.
- The real-time budget counter lives in Valkey; Postgres is the source of truth for accounting, and the worker periodically reconciles the counters against it.
- Logs are stored in a partitioned table, and the dashboard reads from aggregate tables so that heavy aggregation does not run over the raw table.

## 5. Config path

```mermaid
sequenceDiagram
  participant A as Administrator
  participant API as control-api
  participant PG as PostgreSQL
  participant V as Valkey
  participant G as gateway

  A->>API: change combo
  API->>PG: save (transaction)
  API->>API: build ConfigSnapshot (version+1, checksum)
  API->>PG: save the versioned snapshot
  API->>V: SET config:latest + PUBLISH config:changed
  V-->>G: change message
  G->>API: GET /internal/config/snapshot?since=version
  G->>G: validate schemaVersion and checksum, atomic replacement
  G->>G: write to disk (last healthy snapshot)
  Note over G: If control-api is unavailable, periodic long-poll and continue with the current snapshot
```

- `ConfigSnapshot` is published with a `schemaVersion` (format) and a `version` (monotonic counter); the gateway does not accept an older version or an unknown schemaVersion.
- Secrets (provider keys) are only in the snapshot encrypted with AES-256-GCM, and the gateway decrypts them in memory with `MASTER_KEY`.
- When the gateway boots and control-api is unavailable, it starts from the snapshot on disk.

## 6. Resilience

| Risk                                         | Mitigation                                                                                |
| -------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Transient provider error (429, 5xx, timeout) | Error classification, retry with backoff and jitter, fallback in the combo chain          |
| Provider completely down                     | Circuit breaker for the provider and the model with a half-open probe                     |
| A key reached its limit                      | Cooldown of that same key and continue with another key                                   |
| Slow provider                                | Separate timeouts for connection, TTFT, and idle; bulkhead (concurrency cap) per provider |
| control-api or Postgres outage               | Continue with the in-memory and disk snapshot                                             |
| Valkey outage                                | Local limiter, configurable `failMode`, local outbox for events                           |
| New deployment                               | Graceful shutdown: stop accepting, finish open streams, then exit                         |

## 7. Technologies

| Layer                    | Choice                                                                      | ADR                                           |
| ------------------------ | --------------------------------------------------------------------------- | --------------------------------------------- |
| gateway                  | NestJS on the Fastify adapter with a lightweight hot path                   | [ADR-001](adr/0001-gateway-nestjs-fastify.md) |
| control-api, worker      | NestJS                                                                      | [ADR-001](adr/0001-gateway-nestjs-fastify.md) |
| database                 | PostgreSQL 17 + Prisma                                                      | [ADR-002](adr/0002-postgresql-prisma.md)      |
| counters, cache, pub/sub | Valkey                                                                      | [ADR-003](adr/0003-valkey.md)                 |
| reverse proxy            | Traefik v3                                                                  | [ADR-004](adr/0004-traefik-reverse-proxy.md)  |
| event queue              | BullMQ on Valkey                                                            | [ADR-005](adr/0005-bullmq-event-queue.md)     |
| dashboard                | React + Vite + TypeScript, TanStack Router/Query, shadcn/ui, Tailwind (RTL) | —                                             |
| schemas                  | zod in `@dirouter/contracts` with JSON Schema output                        | —                                             |
| monorepo                 | pnpm workspaces + Turborepo, strict TypeScript, ESM                         | —                                             |
| deployment               | Docker and docker compose (dev, prod, HA)                                   | —                                             |

## 8. Shared packages

| Package                   | Contents                                                                                                      | Consumers                               |
| ------------------------- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| `@dirouter/contracts`     | OpenAI and Anthropic schemas, canonical model, ConfigSnapshot, UsageEvent, error templates, and code taxonomy | all                                     |
| `@dirouter/shared`        | pino logger with redaction, error classes, env validation, AES-256-GCM with key versioning, ULID, HMAC        | all Node apps                           |
| `@dirouter/db`            | Prisma schema and client                                                                                      | control-api, worker                     |
| `@dirouter/model-catalog` | Model prices and capabilities                                                                                 | control-api, gateway (via the snapshot) |
| `@dirouter/ui`            | React components                                                                                              | dashboard                               |

The gateway does not depend on `@dirouter/db`; this rule enforces ADR-006 at the code level.
