# ADR-0001: Gateway with NestJS on Fastify and overhead reduction strategies

- **Status:** Accepted; amended 2026-11-25 (the gateway is plain Fastify, see the update below)
- **Date:** 2026-11-07
- **Deciders:** DiRouter team

## Update (2026-11-25): what was actually built

This record is kept as written, but the code took a different split than the decision below:

- **The gateway is plain Fastify, not NestJS.** From its first commit (2026-11-07) `apps/gateway`
  has used Fastify directly, without `@nestjs/*`: no DI container, no modules, no pipes or guards
  anywhere, not only on `/v1/*`. This is option 2 of the considered options. The hot-path rules
  below (services created once at startup, Zod validation once, `reply.raw` streaming, an
  `undici` pool per provider, no database on the hot path, pino logging, the k6 benchmark) apply
  unchanged, and the management, health and metrics routes are ordinary Fastify routes too.
- **control-api is NestJS on the Fastify adapter** (`NestFactory.create<NestFastifyApplication>`),
  as decided.
- **The worker is a plain Node process** (BullMQ consumers and timers), with neither NestJS nor an
  HTTP framework.

The reasons for the decision (one language, shared contracts, translators and pricing) hold for
this split as well. ADR-0007 (`adr/0007-data-plane-stays-on-node.md` at the repository root) records the v1 benchmark of the
gateway as built and keeps the data plane on Node.

## Context

The gateway (data plane) runs on every LLM request: authentication, rate limiting, routing, format translation and streaming. Its overhead adds directly to the user's latency. [Competitor research](../research/feature-comparison.md#72-why-go-for-the-data-plane) showed that speed-focused gateways (Bifrost, Antirion, Helicone) are written in Go or Rust, and Go was proposed for the data plane.

On the other hand, the team works in TypeScript, the control plane is written with NestJS, and schemas, translators and cost logic must be shared between the gateway, control-api and worker.

### Decision Drivers

- p99 overhead below 5ms on the hot path (Sprint 1 SLO)
- MVP delivery speed within two weeks with a TypeScript team
- code sharing (contracts, translators, cost calculation) without generating code across languages
- the option to replace the data plane later without breaking clients

### Considered Options

1. **Go** for the gateway, NestJS for the control plane
2. **Plain Node + Fastify** (without Nest) for the gateway
3. **NestJS on the Fastify adapter** for everything, with a lightweight hot path
4. **NestJS on Express** for everything

## Decision

Option 3: **NestJS on the Fastify adapter**, with these rules for the hot path:

- **No DI per request:** no provider with `REQUEST` or `TRANSIENT` scope; all services are singletons created at boot.
- **No general pipes, interceptors or guards** on `/v1/*` routes. Authentication, limits and routing run as a simple async function in the handler. Nest tools are used only on management and health routes.
- **One-time validation** with a zod schema (no class-validator or class-transformer).
- **Direct streaming** with `reply.raw` and no buffer; SSE translation is incremental.
- **Outbound HTTP client** with `undici` and a separate connection pool for each provider (keep-alive, HTTP/1.1 and HTTP/2 where possible).
- **No synchronous I/O** with the database on the hot path; only the in-memory snapshot and Valkey (ADR-006).
- **Asynchronous logging** with pino (no `console`) and redaction.
- **Benchmark in CI** (k6 with mock-provider) so that overhead regressions are visible.
- **Stable interface:** the public gateway API is the same as OpenAI/Anthropic, and the internal contracts (ConfigSnapshot, UsageEvent) have a JSON Schema; so if the benchmarks reject the SLO, the gateway can be rewritten in Go without changing the rest of the system.

## Consequences

### Positive

- one language and one toolset across the whole repository; faster MVP delivery.
- translators, schemas and cost calculation are written once and used in all apps.
- Fastify has about twice the throughput of Express and its route overhead is low.
- Nest's modular structure is also available for the gateway's management, health and metrics routes.

### Negative

- Node is single-threaded, and GC with tens of thousands of simultaneous streams raises tail latency; horizontal scaling (multiple replicas) is needed.
- the "lightweight hot path" rules must be enforced in code review; a global interceptor can raise overhead.
- memory use per stream is higher than in Go.

### Follow-up

- Card 9.4 (load test with k6) measures the gateway's overhead p50/p99 against a direct call to mock-provider.
- Card 22.4 is a comparative benchmark with competitors; if the SLO is not met, a new ADR is written to rewrite the data plane in Go.
