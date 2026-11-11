# DiRouter delivery plan (DiTask)

> Local-only English translation of the original 2026-11-07 planning snapshot. This is a plan, not a completion report. The [live DiTask board](https://ditask.ir/b/cmw5uvrbk003d5lxy2bf842de) is the source of truth for current progress.

## Local board import

The original Persian board import (`dikar.board`, version 1) and generator scripts are retained locally under `docs/board/` and `docs/tools/board/`. They are excluded from Git. From the external `docs/` directory, run `python3 tools/board/build_board.py` to regenerate the local import JSON and Persian board summary. Import the JSON using DiTask's data-transfer / board-import interface. The original export placed all cards in Backlog and associated them with their sprints; Sprint 1 was active.

This English summary is local-only and is not overwritten by the Persian generator.

## Technology stack

- Backend: NestJS with the Fastify adapter for gateway, control-api, and worker.
- Frontend: React + Vite + TypeScript, TanStack Router/Query, shadcn/ui, Tailwind, RTL.
- Database: PostgreSQL 17 + Prisma, partitioned logs and aggregate tables.
- Counters, cache, pub/sub, queue: Valkey + BullMQ.
- Reverse proxy: Traefik v3, Let's Encrypt TLS, SSE support.
- Deployment: Docker and Docker Compose (development, production, HA); pnpm + Turborepo monorepo.

## Conventions

- A title prefix is `epic.card`, for example `4.5` means epic 4, card 5.
- DiTask records dependencies in `blockedBy`; use them to determine execution order.
- Each card has Acceptance Criteria and Definition of Done checklists.
- Estimated duration is story points multiplied by 60 minutes.
- Versioned documentation is English; Persian counterparts are local-only under the external `docs/` directory.

## Epics

| Number | Epic                                       |
| ------ | ------------------------------------------ |
| 0      | Architecture and decisions                 |
| 1      | Monorepo and tooling                       |
| 2      | Docker and Traefik                         |
| 3      | Database and control-api                   |
| 4      | Gateway core                               |
| 5      | Routing and resilience                     |
| 6      | Limits, budgets, and accounting            |
| 7      | MVP dashboard                              |
| 8      | Observability                              |
| 9      | Testing and QA                             |
| 10     | MVP documentation                          |
| 11     | Additional APIs and providers              |
| 12     | Advanced routing and resilience            |
| 13     | Caching and token savings                  |
| 14     | Enterprise security                        |
| 15     | Guardrails                                 |
| 16     | Advanced dashboard and alerts              |
| 17     | Configuration, tracing, and HA             |
| 18     | Chaos and v1 documentation                 |
| 19     | Billing and sales                          |
| 20     | Agents, MCP, and intelligent routing       |
| 21     | Multimodality and plugins                  |
| 22     | Enterprise features, security, and release |

## Sprint 1 — MVP: resilient gateway, Docker, Traefik, and basic dashboard

**Goal:** An end-to-end gateway behind Traefik forwarding OpenAI and Anthropic requests to multiple providers with fallback, circuit breakers, rate limits, budgets, and accounting; a basic Persian dashboard; Docker deployment and documentation.

**Dates:** 2026-11-07 to 2026-11-20 · **Cards:** 66 · **Story points:** 280

| Card | Title                                                               | Type  | Priority | SP  | Dependencies            |
| ---- | ------------------------------------------------------------------- | ----- | -------- | --- | ----------------------- |
| 0.1  | Architecture document and foundational ADRs                         | Task  | Urgent   | 3   | —                       |
| 1.1  | Initialize the pnpm and Turborepo monorepo                          | Task  | Urgent   | 3   | —                       |
| 1.2  | Code-quality tools and commit conventions                           | Task  | High     | 2   | 1.1                     |
| 1.3  | Contracts package: shared schemas                                   | Task  | Urgent   | 5   | 1.1                     |
| 1.4  | Shared package: logging, errors, environment validation, and crypto | Task  | High     | 3   | 1.1                     |
| 1.5  | CI pipeline                                                         | Task  | High     | 3   | 1.2                     |
| 2.1  | Multi-stage Dockerfiles for all applications                        | Task  | Urgent   | 5   | 1.1                     |
| 2.2  | Development Docker Compose                                          | Task  | Urgent   | 3   | 2.1                     |
| 2.3  | Traefik reverse-proxy configuration                                 | Story | Urgent   | 5   | 2.2                     |
| 2.4  | Production Docker Compose                                           | Task  | High     | 3   | 2.3                     |
| 2.5  | Makefile and operational scripts                                    | Task  | Medium   | 2   | 2.2                     |
| 3.1  | Prisma schema design                                                | Task  | Urgent   | 8   | 1.1                     |
| 3.2  | Log partitioning and aggregate tables                               | Task  | High     | 5   | 3.1                     |
| 3.3  | NestJS control-api scaffold                                         | Task  | Urgent   | 3   | 1.3, 1.4, 3.1           |
| 3.4  | Dashboard authentication and initial setup wizard                   | Story | Urgent   | 5   | 3.3                     |
| 3.5  | Basic RBAC and organization, team, project, and user management     | Story | High     | 5   | 3.4                     |
| 3.6  | Provider and credential management                                  | Story | Urgent   | 5   | 3.5                     |
| 3.7  | Virtual-key management                                              | Story | Urgent   | 5   | 3.5                     |
| 3.8  | Model catalog, aliases, and combos                                  | Story | Urgent   | 5   | 3.6                     |
| 3.9  | Build and publish configuration snapshots                           | Task  | Urgent   | 5   | 3.8, 3.7                |
| 3.10 | Dashboard statistics and log API                                    | Story | High     | 5   | 3.2, 3.5                |
| 3.11 | Seed and sample data                                                | Task  | Medium   | 2   | 3.8                     |
| 4.1  | NestJS/Fastify gateway scaffold with a lightweight hot path         | Task  | Urgent   | 5   | 1.3, 1.4                |
| 4.2  | Gateway configuration synchronization with local fallback           | Task  | Urgent   | 5   | 4.1, 3.9                |
| 4.3  | Gateway virtual-key authentication                                  | Task  | Urgent   | 3   | 4.2                     |
| 4.4  | Canonical model and non-streaming OpenAI/Anthropic translators      | Task  | Urgent   | 8   | 1.3                     |
| 4.5  | Streaming SSE translator                                            | Task  | Urgent   | 8   | 4.4                     |
| 4.6  | OpenAI, Azure OpenAI, and OpenAI-compatible adapters                | Task  | Urgent   | 5   | 4.4                     |
| 4.7  | Anthropic adapter                                                   | Task  | Urgent   | 3   | 4.4                     |
| 4.8  | Outbound Gemini adapter                                             | Task  | High     | 5   | 4.4                     |
| 4.9  | Chat completions, messages, and models endpoints                    | Story | Urgent   | 5   | 4.3, 4.5, 4.6, 4.7, 5.1 |
| 4.10 | Outbound HTTP/HTTPS/SOCKS5 proxy                                    | Story | High     | 3   | 4.6                     |
| 5.1  | Routing engine                                                      | Task  | Urgent   | 8   | 4.2                     |
| 5.2  | Upstream error classification                                       | Task  | Urgent   | 3   | 4.6, 4.7                |
| 5.3  | Retry with backoff and fallback chains                              | Task  | Urgent   | 5   | 5.1, 5.2                |
| 5.4  | Layered timeouts                                                    | Task  | High     | 3   | 5.3                     |
| 5.5  | Per-provider and per-model circuit breakers                         | Task  | Urgent   | 5   | 5.3                     |
| 5.6  | Credential cooldown and model lockout                               | Task  | Urgent   | 3   | 5.5                     |
| 5.7  | Stream-safe fallback and bulkheads                                  | Task  | High     | 5   | 5.3, 4.5                |
| 5.8  | Graceful shutdown and draining                                      | Task  | High     | 3   | 6.4, 2.4                |
| 6.1  | Distributed Valkey rate limiter                                     | Task  | Urgent   | 5   | 4.3                     |
| 6.2  | Cost calculation and token estimation                               | Task  | Urgent   | 3   | 3.8                     |
| 6.3  | Key-, project-, and team-level budgets                              | Story | High     | 5   | 6.1, 6.2                |
| 6.4  | Usage-event pipeline with an outbox                                 | Task  | Urgent   | 8   | 6.2, 3.2                |
| 6.5  | Worker: queue processing, aggregation, and retention                | Task  | High     | 5   | 6.4                     |
| 7.1  | React dashboard scaffold with RTL and i18n                          | Task  | Urgent   | 8   | 1.1                     |
| 7.2  | Login and setup-wizard pages                                        | Story | Urgent   | 3   | 7.1, 3.4                |
| 7.3  | Overview page                                                       | Story | Urgent   | 5   | 7.1, 3.10               |
| 7.4  | Providers and credentials page                                      | Story | Urgent   | 5   | 7.1, 3.6                |
| 7.5  | Virtual-keys page                                                   | Story | Urgent   | 3   | 7.1, 3.7                |
| 7.6  | Models, aliases, and combo editor                                   | Story | Urgent   | 5   | 7.1, 3.8                |
| 7.7  | Request Log Explorer                                                | Story | Urgent   | 5   | 7.1, 3.10               |
| 7.8  | Health page                                                         | Story | High     | 3   | 7.1, 3.10, 5.6          |
| 7.9  | Organization, team, project, and user pages                         | Story | High     | 3   | 7.1, 3.5                |
| 7.10 | Tool-connection guide page                                          | Story | Medium   | 2   | 7.5                     |
| 8.1  | Prometheus metrics                                                  | Task  | High     | 3   | 5.5, 6.4                |
| 8.2  | Structured logs and correlation IDs                                 | Task  | High     | 2   | 4.1                     |
| 8.3  | Monitoring profile: Prometheus and Grafana                          | Task  | Medium   | 3   | 8.1, 2.2                |
| 9.1  | Mock provider with fault injection                                  | Task  | Urgent   | 5   | 1.3                     |
| 9.2  | Unit and integration tests                                          | Task  | High     | 5   | 5.3, 6.1                |
| 9.3  | Core end-to-end scenarios                                           | Task  | High     | 5   | 9.1, 4.9, 6.4, 2.3      |
| 9.4  | Baseline k6 load tests                                              | Task  | Medium   | 3   | 9.3                     |
| 10.1 | Main README and quick start                                         | Task  | High     | 2   | 4.9, 7.2                |
| 10.2 | Production deployment guide and environment-variable reference      | Task  | High     | 3   | 2.4                     |
| 10.3 | Dashboard user and concepts guide                                   | Task  | Medium   | 3   | 7.7                     |
| 10.4 | Operational runbook                                                 | Task  | High     | 3   | 9.3                     |

## Sprint 2 — v1: advanced resilience, enterprise security, caching, and analytics

**Goal:** Intelligent routing and hedging, caching and compression, MFA/SSO/audit, guardrails, alerts, an analytics dashboard, versioned configuration, and HA deployment with chaos tests.

**Dates:** 2026-11-21 to 2026-12-04 · **Cards:** 29 · **Story points:** 143

| Card | Title                                                             | Type  | Priority | SP  | Dependencies |
| ---- | ----------------------------------------------------------------- | ----- | -------- | --- | ------------ |
| 11.1 | Inbound Gemini API: generateContent and streaming                 | Story | High     | 5   | 4.8          |
| 11.2 | Inbound and outbound OpenAI Responses API                         | Story | High     | 8   | 4.5          |
| 11.3 | Bedrock, Vertex, and low-cost provider adapters                   | Task  | Medium   | 8   | 4.6          |
| 11.4 | Embeddings endpoint: /v1/embeddings                               | Story | Medium   | 3   | 4.9          |
| 12.1 | Latency, cost, least-used, and headroom routing strategies        | Task  | High     | 8   | 5.1          |
| 12.2 | Request hedging                                                   | Task  | Medium   | 5   | 12.1         |
| 12.3 | Periodic health probes and automatic credential disable/re-enable | Task  | High     | 3   | 5.6          |
| 12.4 | Session affinity and context-based routing                        | Task  | Medium   | 3   | 12.1         |
| 12.5 | Routing simulator: dry run                                        | Story | Medium   | 3   | 12.1, 7.6    |
| 13.1 | Exact cache on Valkey                                             | Story | High     | 5   | 4.9          |
| 13.2 | Semantic cache with pgvector                                      | Story | Medium   | 5   | 13.1, 11.4   |
| 13.3 | Context compression: RTK and deduplication                        | Story | Medium   | 8   | 4.4          |
| 14.1 | MFA with TOTP and passkeys                                        | Story | High     | 5   | 3.4          |
| 14.2 | SSO with OIDC                                                     | Story | High     | 5   | 3.5          |
| 14.3 | Custom roles and permission matrix                                | Story | Medium   | 5   | 3.5          |
| 14.4 | Complete audit log                                                | Story | High     | 3   | 3.5          |
| 14.5 | MASTER_KEY and provider-key rotation                              | Task  | Medium   | 3   | 6.5          |
| 15.1 | Guardrail engine                                                  | Story | High     | 8   | 4.9          |
| 15.2 | Guardrail-policy page                                             | Story | Medium   | 3   | 15.1, 7.1    |
| 16.1 | Costs and budgets page                                            | Story | High     | 5   | 6.3, 7.3     |
| 16.2 | Alerting system and notification channels                         | Story | High     | 5   | 6.5, 12.3    |
| 16.3 | Live view                                                         | Story | Medium   | 3   | 7.7          |
| 16.4 | Analytics page                                                    | Story | Medium   | 5   | 7.3, 13.1    |
| 16.5 | Model-comparison playground                                       | Story | Medium   | 5   | 7.6          |
| 17.1 | Versioned configuration: diffs, rollback, YAML import/export      | Story | High     | 5   | 3.9          |
| 17.2 | OpenTelemetry tracing                                             | Task  | Medium   | 3   | 8.1          |
| 17.3 | HA deployment: PostgreSQL, Valkey, and gateway replicas           | Task  | High     | 8   | 2.4          |
| 18.1 | Chaos tests                                                       | Task  | High     | 5   | 17.3, 9.4    |
| 18.2 | Sprint 2 documentation                                            | Task  | Medium   | 3   | 17.3         |

## Sprint 3 — billing, agents/MCP, and the v1.0 release

**Goal:** Wallet and payment gateways, a sales portal, MCP gateway and A2A, classifier routing, multimodality, SAML/SCIM, supply-chain security, benchmarks, and the v1.0 release.

**Dates:** 2026-12-05 to 2026-12-18 · **Cards:** 20 · **Story points:** 118

| Card | Title                                                  | Type  | Priority | SP  | Dependencies     |
| ---- | ------------------------------------------------------ | ----- | -------- | --- | ---------------- |
| 19.1 | Wallet and double-entry financial ledger               | Story | High     | 8   | 6.4              |
| 19.2 | Payment gateways: Zarinpal and Stripe                  | Story | High     | 8   | 19.1             |
| 19.3 | Gift and top-up codes                                  | Story | Medium   | 3   | 19.1             |
| 19.4 | Sales pricing and user groups                          | Story | High     | 5   | 19.1             |
| 19.5 | End-user portal                                        | Story | High     | 8   | 19.2, 19.4       |
| 19.6 | Invoices and profit reports                            | Story | Medium   | 5   | 19.4             |
| 20.1 | MCP Gateway                                            | Story | High     | 8   | 4.9              |
| 20.2 | DiRouter administrative MCP Server                     | Story | Medium   | 5   | 20.1             |
| 20.3 | A2A: Agent Card and basic JSON-RPC                     | Story | Low      | 5   | 20.1             |
| 20.4 | Classifier routing and automatic aliases               | Story | High     | 8   | 12.1             |
| 20.5 | Agent profiles and one-click configuration generation  | Story | Medium   | 3   | 7.10             |
| 21.1 | Image generation, TTS, and STT                         | Story | Medium   | 8   | 4.9              |
| 21.2 | Provider plugins with optional OAuth-subscription mode | Story | Low      | 8   | 4.6              |
| 22.1 | SAML and SCIM                                          | Story | Medium   | 8   | 14.2             |
| 22.2 | Change requests for sensitive operations               | Story | Low      | 5   | 17.1, 14.3       |
| 22.3 | Supply-chain security and threat model                 | Task  | High     | 5   | 1.5              |
| 22.4 | Performance optimization and comparative benchmarks    | Task  | High     | 5   | 18.1             |
| 22.5 | Documentation website                                  | Task  | Medium   | 5   | 18.2             |
| 22.6 | Optional Helm chart                                    | Task  | Low      | 5   | 17.3             |
| 22.7 | Release v1.0                                           | Task  | High     | 3   | 22.3, 22.4, 22.5 |
