# ADR-0001: Gateway with NestJS on Fastify and a lightweight hot path

- **Status:** Accepted
- **Date:** 2026-11-07
- **Decision makers:** DiRouter team

## Context

Gateway, the data plane, handles authentication, rate limits, routing, format translation, and streaming for every LLM request. Its overhead directly adds to user latency. The initial internal competitor research proposed Go because speed-focused gateways such as Bifrost, Antirion, and Helicone use Go or Rust.

The team, however, works in TypeScript. The control plane uses NestJS, and schemas, translators, and cost calculations need to be shared by gateway, control-api, and worker.

### Decision drivers

- Hot-path p99 overhead below 5 ms (MVP SLO).
- Deliver the MVP in two weeks with a TypeScript team.
- Share contracts, translators, and cost calculation without cross-language code generation.
- Allow the data plane to be replaced later without breaking clients.

### Considered options

1. **Go** for gateway, NestJS for the control plane.
2. **Plain Node + Fastify**, without NestJS, for gateway.
3. **NestJS with the Fastify adapter** throughout, with a lightweight hot path.
4. **NestJS with Express** throughout.

## Decision

Choose option 3: **NestJS with the Fastify adapter**, under these hot-path rules:

- **No per-request dependency injection:** no `REQUEST`- or `TRANSIENT`-scoped providers. Services are singletons constructed at startup.
- **No generic pipes, interceptors, or guards** on `/v1/*` routes. Authentication, limits, and routing run as plain async functions inside the handler. Use Nest features for administrative and health routes.
- **Validate once** with Zod, without class-validator or class-transformer.
- **Stream directly** through `reply.raw`, without buffering; translate SSE incrementally.
- **Outbound HTTP** uses `undici`, with a separate connection pool per provider, keep-alive, HTTP/1.1, and HTTP/2 where supported.
- **No synchronous database I/O** on the hot path; use the in-memory snapshot and Valkey only (ADR-006).
- **Asynchronous logging** with Pino and redaction, without `console`.
- **Benchmark in CI** using k6 and mock-provider to detect overhead regressions.
- **Keep interfaces stable:** public gateway APIs remain OpenAI/Anthropic-compatible, and internal ConfigSnapshot/UsageEvent contracts have JSON Schemas. If benchmarks miss the SLO, gateway can be rewritten in Go without changing the rest of the system.

## Consequences

### Positive

- One language and toolchain across the repository speeds up MVP delivery.
- Translators, schemas, and cost calculations are written once and reused.
- Fastify is expected to offer higher throughput and lower routing overhead than Express; validate the actual gain with the project benchmark.
- Nest's modular structure remains available for gateway administration, health, and metrics.

### Negative

- Node executes JavaScript on a single thread, and garbage collection can raise tail latency with tens of thousands of concurrent streams. Horizontal scaling is required.
- Code review must enforce the lightweight hot-path rules; a global interceptor can increase overhead.
- Per-stream memory use is expected to be higher than Go and must be measured.

### Follow-up

- The k6 load test measures gateway p50/p99 overhead against direct mock-provider calls using k6.
- Comparative benchmarks should include competing gateways. If the SLO is missed, write a new ADR for a Go data-plane rewrite.
