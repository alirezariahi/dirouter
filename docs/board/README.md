[English](#english) · [فارسی](#persian)

<a id="english"></a>

# DiRouter board (DiTask)

> This file is generated automatically from `tools/board/build_board.py`; do not edit it by hand.

## Importing into DiTask

Import the `docs/board/dirouter-board.json` file through the "data transfer / board import" section in DiTask. All cards are in the "📥 Backlog" list and are linked to their sprints; Sprint 1 is active.

## Technology stack

- **Backend:** NestJS (on the Fastify adapter) for the gateway, control-api, and worker
- **Frontend:** React + Vite + TypeScript, TanStack Router/Query, shadcn/ui, Tailwind (RTL)
- **Database:** PostgreSQL 17 + Prisma (partitioned logs + aggregate tables)
- **Counters, cache, pub/sub, and queue:** Valkey + BullMQ
- **Reverse proxy:** Traefik v3 (TLS with Let's Encrypt, SSE support)
- **Deployment:** Docker and docker compose (dev, prod, HA); pnpm + Turborepo monorepo

## Conventions

- The number at the start of each card title is "epic.row" (for example, 4.5 means epic 4, card 5).
- Dependencies are recorded in DiTask's blockedBy field; use it to determine the execution order.
- Each card has two checklists: "Acceptance criteria" and "Definition of Done (DoD)".
- Estimated time = story points × 60 minutes.

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
| 11     | More APIs and providers                    |
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

**Goal:** An end-to-end gateway behind Traefik that forwards OpenAI and Anthropic requests to multiple providers with fallback, circuit breakers, rate limits, budgets, and accounting; a basic Persian dashboard; Docker deployment and documentation.

**Dates:** 2026-11-07 to 2026-11-20 · **Cards:** 66 · **Story points:** 280

| #    | Title                                                               | Type  | Priority | SP  | Dependencies            |
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

| #    | Title                                                             | Type  | Priority | SP  | Dependencies |
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

| #    | Title                                                  | Type  | Priority | SP  | Dependencies     |
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

---

<a id="persian"></a>

# برد DiRouter (دی‌تسک)

> این فایل خودکار از `tools/board/build_board.py` ساخته می‌شود؛ دستی ویرایش نکنید.

## ورود به دی‌تسک

فایل `docs/board/dirouter-board.json` را از بخش «انتقال اطلاعات / ورود برد» در دی‌تسک وارد کنید. همهٔ کارت‌ها در لیست «📥 بک‌لاگ» قرار دارند و به اسپرینت خود متصل‌اند؛ اسپرینت ۱ فعال است.

## پشتهٔ فنی

- **Backend:** NestJS (روی Fastify adapter) برای gateway، control-api و worker
- **Frontend:** React + Vite + TypeScript، TanStack Router/Query، shadcn/ui، Tailwind (RTL)
- **دیتابیس:** PostgreSQL 17 + Prisma (لاگ‌ها پارتیشن‌بندی‌شده + جداول تجمیعی)
- **شمارنده، کش، pub/sub و صف:** Valkey + BullMQ
- **ریورس پراکسی:** Traefik v3 (TLS با Let's Encrypt، پشتیبانی SSE)
- **استقرار:** Docker و docker compose (dev، prod، HA)؛ مونوریپو pnpm + Turborepo

## قراردادها

- شمارهٔ ابتدای عنوان هر کارت = «اپیک.ردیف» (مثلاً ۴.۵ یعنی اپیک ۴، کارت ۵).
- وابستگی‌ها در فیلد blockedBy دی‌تسک ثبت شده‌اند؛ ترتیب اجرا را از آن بگیرید.
- هر کارت دو چک‌لیست دارد: «معیار پذیرش» و «تعریف انجام (DoD)».
- برآورد زمان = استوری‌پوینت × ۶۰ دقیقه.

## اپیک‌ها

| شماره | اپیک                         |
| ----- | ---------------------------- |
| ۰     | معماری و تصمیم‌ها            |
| ۱     | مونوریپو و ابزار             |
| ۲     | داکر و Traefik               |
| ۳     | دیتابیس و control-api        |
| ۴     | هستهٔ گیت‌وی                 |
| ۵     | مسیریابی و تاب‌آوری          |
| ۶     | محدودیت، بودجه و حسابداری    |
| ۷     | داشبورد MVP                  |
| ۸     | Observability                |
| ۹     | تست و QA                     |
| ۱۰    | مستندات MVP                  |
| ۱۱    | API و providerهای بیشتر      |
| ۱۲    | مسیریابی و تاب‌آوری پیشرفته  |
| ۱۳    | کش و صرفه‌جویی توکن          |
| ۱۴    | امنیت سازمانی                |
| ۱۵    | Guardrail                    |
| ۱۶    | داشبورد پیشرفته و هشدار      |
| ۱۷    | پیکربندی، tracing و HA       |
| ۱۸    | Chaos و مستندات v1           |
| ۱۹    | صورت‌حساب و فروش             |
| ۲۰    | ایجنت، MCP و مسیریابی هوشمند |
| ۲۱    | چندرسانه‌ای و افزونه‌ها      |
| ۲۲    | سازمانی، امنیت و انتشار      |

## اسپرینت ۱ — MVP: گیت‌وی تاب‌آور، داکر، Traefik و داشبورد پایه

**هدف:** یک گیت‌وی end-to-end پشت Traefik که درخواست OpenAI و Anthropic را با فال‌بک، circuit breaker، rate limit، بودجه و حسابداری به چند provider می‌رساند؛ داشبورد فارسی پایه؛ کاملاً داکرایز و مستند.

**بازه:** 2026-11-07 تا 2026-11-20 · **کارت:** ۶۶ · **استوری‌پوینت:** ۲۸۰

| #    | عنوان                                                       | نوع    | اولویت | SP  | وابستگی                 |
| ---- | ----------------------------------------------------------- | ------ | ------ | --- | ----------------------- |
| ۰.۱  | سند معماری و ADRهای پایه                                    | تسک    | فوری   | ۳   | —                       |
| ۱.۱  | راه‌اندازی مونوریپو با pnpm و Turborepo                     | تسک    | فوری   | ۳   | —                       |
| ۱.۲  | ابزارهای کیفیت کد و قراردادهای کامیت                        | تسک    | بالا   | ۲   | ۱.۱                     |
| ۱.۳  | پکیج contracts: اسکیماهای مشترک                             | تسک    | فوری   | ۵   | ۱.۱                     |
| ۱.۴  | پکیج shared: لاگر، خطا، env و رمزنگاری                      | تسک    | بالا   | ۳   | ۱.۱                     |
| ۱.۵  | پایپلاین CI                                                 | تسک    | بالا   | ۳   | ۱.۲                     |
| ۲.۱  | Dockerfile چندمرحله‌ای برای همهٔ اپ‌ها                      | تسک    | فوری   | ۵   | ۱.۱                     |
| ۲.۲  | docker-compose محیط توسعه                                   | تسک    | فوری   | ۳   | ۲.۱                     |
| ۲.۳  | پیکربندی Traefik به‌عنوان ریورس پراکسی                      | استوری | فوری   | ۵   | ۲.۲                     |
| ۲.۴  | docker-compose محیط production                              | تسک    | بالا   | ۳   | ۲.۳                     |
| ۲.۵  | Makefile و اسکریپت‌های عملیاتی                              | تسک    | متوسط  | ۲   | ۲.۲                     |
| ۳.۱  | طراحی شِمای Prisma                                          | تسک    | فوری   | ۸   | ۱.۱                     |
| ۳.۲  | پارتیشن‌بندی لاگ‌ها و جداول تجمیعی                          | تسک    | بالا   | ۵   | ۳.۱                     |
| ۳.۳  | اسکلت control-api با NestJS                                 | تسک    | فوری   | ۳   | ۱.۳، ۱.۴، ۳.۱           |
| ۳.۴  | احراز هویت داشبورد و ویزارد راه‌اندازی                      | استوری | فوری   | ۵   | ۳.۳                     |
| ۳.۵  | RBAC پایه و مدیریت سازمان، تیم، پروژه و کاربر               | استوری | بالا   | ۵   | ۳.۴                     |
| ۳.۶  | مدیریت Provider و Credential                                | استوری | فوری   | ۵   | ۳.۵                     |
| ۳.۷  | مدیریت کلیدهای مجازی (Virtual Keys)                         | استوری | فوری   | ۵   | ۳.۵                     |
| ۳.۸  | کاتالوگ مدل، Alias و Combo                                  | استوری | فوری   | ۵   | ۳.۶                     |
| ۳.۹  | ساخت و انتشار Config Snapshot                               | تسک    | فوری   | ۵   | ۳.۸، ۳.۷                |
| ۳.۱۰ | API آمار و لاگ برای داشبورد                                 | استوری | بالا   | ۵   | ۳.۲، ۳.۵                |
| ۳.۱۱ | Seed و داده‌های نمونه                                       | تسک    | متوسط  | ۲   | ۳.۸                     |
| ۴.۱  | اسکلت گیت‌وی NestJS + Fastify با مسیر داغ سبک               | تسک    | فوری   | ۵   | ۱.۳، ۱.۴                |
| ۴.۲  | همگام‌سازی Config در گیت‌وی با fallback محلی                | تسک    | فوری   | ۵   | ۴.۱، ۳.۹                |
| ۴.۳  | احراز هویت کلید مجازی در گیت‌وی                             | تسک    | فوری   | ۳   | ۴.۲                     |
| ۴.۴  | مدل canonical و مترجم OpenAI ⇄ Anthropic (بدون stream)      | تسک    | فوری   | ۸   | ۱.۳                     |
| ۴.۵  | مترجم streaming (SSE)                                       | تسک    | فوری   | ۸   | ۴.۴                     |
| ۴.۶  | آداپتر OpenAI، Azure OpenAI و OpenAI-compatible             | تسک    | فوری   | ۵   | ۴.۴                     |
| ۴.۷  | آداپتر Anthropic                                            | تسک    | فوری   | ۳   | ۴.۴                     |
| ۴.۸  | آداپتر Gemini (خروجی)                                       | تسک    | بالا   | ۵   | ۴.۴                     |
| ۴.۹  | Endpointهای /v1/chat/completions، /v1/messages و /v1/models | استوری | فوری   | ۵   | ۴.۳، ۴.۵، ۴.۶، ۴.۷، ۵.۱ |
| ۴.۱۰ | پروکسی خروجی (HTTP/HTTPS/SOCKS5)                            | استوری | بالا   | ۳   | ۴.۶                     |
| ۵.۱  | موتور مسیریابی (Router)                                     | تسک    | فوری   | ۸   | ۴.۲                     |
| ۵.۲  | طبقه‌بندی خطاهای upstream                                   | تسک    | فوری   | ۳   | ۴.۶، ۴.۷                |
| ۵.۳  | Retry با backoff و زنجیرهٔ فال‌بک                           | تسک    | فوری   | ۵   | ۵.۱، ۵.۲                |
| ۵.۴  | Timeoutهای چندلایه                                          | تسک    | بالا   | ۳   | ۵.۳                     |
| ۵.۵  | Circuit Breaker برای provider و مدل                         | تسک    | فوری   | ۵   | ۵.۳                     |
| ۵.۶  | Cooldown کلید و Lockout مدل                                 | تسک    | فوری   | ۳   | ۵.۵                     |
| ۵.۷  | فال‌بک امن در stream و Bulkhead                             | تسک    | بالا   | ۵   | ۵.۳، ۴.۵                |
| ۵.۸  | Graceful Shutdown و drain                                   | تسک    | بالا   | ۳   | ۶.۴، ۲.۴                |
| ۶.۱  | Rate Limiter توزیع‌شده روی Valkey                           | تسک    | فوری   | ۵   | ۴.۳                     |
| ۶.۲  | محاسبهٔ هزینه و تخمین توکن                                  | تسک    | فوری   | ۳   | ۳.۸                     |
| ۶.۳  | بودجه در سطح کلید، پروژه و تیم                              | استوری | بالا   | ۵   | ۶.۱، ۶.۲                |
| ۶.۴  | خط لولهٔ رویداد مصرف با outbox                              | تسک    | فوری   | ۸   | ۶.۲، ۳.۲                |
| ۶.۵  | اپ worker: پردازش صف، تجمیع و نگهداری                       | تسک    | بالا   | ۵   | ۶.۴                     |
| ۷.۱  | اسکلت داشبورد React با RTL و i18n                           | تسک    | فوری   | ۸   | ۱.۱                     |
| ۷.۲  | صفحات ورود و ویزارد راه‌اندازی                              | استوری | فوری   | ۳   | ۷.۱، ۳.۴                |
| ۷.۳  | صفحهٔ Overview                                              | استوری | فوری   | ۵   | ۷.۱، ۳.۱۰               |
| ۷.۴  | صفحهٔ Providers و Credentials                               | استوری | فوری   | ۵   | ۷.۱، ۳.۶                |
| ۷.۵  | صفحهٔ کلیدهای مجازی                                         | استوری | فوری   | ۳   | ۷.۱، ۳.۷                |
| ۷.۶  | صفحهٔ مدل‌ها، Aliasها و ویرایشگر Combo                      | استوری | فوری   | ۵   | ۷.۱، ۳.۸                |
| ۷.۷  | Request Log Explorer                                        | استوری | فوری   | ۵   | ۷.۱، ۳.۱۰               |
| ۷.۸  | صفحهٔ Health                                                | استوری | بالا   | ۳   | ۷.۱، ۳.۱۰، ۵.۶          |
| ۷.۹  | صفحات سازمان، تیم، پروژه و کاربران                          | استوری | بالا   | ۳   | ۷.۱، ۳.۵                |
| ۷.۱۰ | صفحهٔ راهنمای اتصال ابزارها                                 | استوری | متوسط  | ۲   | ۷.۵                     |
| ۸.۱  | متریک‌های Prometheus                                        | تسک    | بالا   | ۳   | ۵.۵، ۶.۴                |
| ۸.۲  | لاگ ساخت‌یافته و correlation id                             | تسک    | بالا   | ۲   | ۴.۱                     |
| ۸.۳  | پروفایل monitoring: Prometheus و Grafana                    | تسک    | متوسط  | ۳   | ۸.۱، ۲.۲                |
| ۹.۱  | Mock Provider با تزریق خطا                                  | تسک    | فوری   | ۵   | ۱.۳                     |
| ۹.۲  | تست واحد و یکپارچه                                          | تسک    | بالا   | ۵   | ۵.۳، ۶.۱                |
| ۹.۳  | تست end-to-end سناریوهای اصلی                               | تسک    | بالا   | ۵   | ۹.۱، ۴.۹، ۶.۴، ۲.۳      |
| ۹.۴  | تست بار پایه با k6                                          | تسک    | متوسط  | ۳   | ۹.۳                     |
| ۱۰.۱ | README اصلی و Quick Start                                   | تسک    | بالا   | ۲   | ۴.۹، ۷.۲                |
| ۱۰.۲ | راهنمای استقرار production و مرجع متغیرهای محیطی            | تسک    | بالا   | ۳   | ۲.۴                     |
| ۱۰.۳ | راهنمای کاربر داشبورد و مفاهیم                              | تسک    | متوسط  | ۳   | ۷.۷                     |
| ۱۰.۴ | Runbook عملیاتی                                             | تسک    | بالا   | ۳   | ۹.۳                     |

## اسپرینت ۲ — v1: تاب‌آوری پیشرفته، امنیت سازمانی، کش و آنالیتیکس

**هدف:** استراتژی‌های هوشمند مسیریابی و hedging، کش و فشرده‌سازی، MFA و SSO و audit، guardrail، هشدار، داشبورد تحلیلی، config نسخه‌دار و استقرار HA با تست chaos.

**بازه:** 2026-11-21 تا 2026-12-04 · **کارت:** ۲۹ · **استوری‌پوینت:** ۱۴۳

| #    | عنوان                                                      | نوع    | اولویت | SP  | وابستگی    |
| ---- | ---------------------------------------------------------- | ------ | ------ | --- | ---------- |
| ۱۱.۱ | ورودی Gemini API (generateContent و stream)                | استوری | بالا   | ۵   | ۴.۸        |
| ۱۱.۲ | OpenAI Responses API (ورودی و خروجی)                       | استوری | بالا   | ۸   | ۴.۵        |
| ۱۱.۳ | آداپترهای Bedrock، Vertex و providerهای ارزان              | تسک    | متوسط  | ۸   | ۴.۶        |
| ۱۱.۴ | Endpoint امبدینگ /v1/embeddings                            | استوری | متوسط  | ۳   | ۴.۹        |
| ۱۲.۱ | استراتژی‌های latency، cost، least-used و headroom          | تسک    | بالا   | ۸   | ۵.۱        |
| ۱۲.۲ | Request Hedging                                            | تسک    | متوسط  | ۵   | ۱۲.۱       |
| ۱۲.۳ | Health probe دوره‌ای و غیرفعال/فعال‌سازی خودکار credential | تسک    | بالا   | ۳   | ۵.۶        |
| ۱۲.۴ | Session affinity و مسیریابی بر اساس context                | تسک    | متوسط  | ۳   | ۱۲.۱       |
| ۱۲.۵ | شبیه‌ساز مسیریابی (dry-run)                                | استوری | متوسط  | ۳   | ۱۲.۱، ۷.۶  |
| ۱۳.۱ | Exact Cache روی Valkey                                     | استوری | بالا   | ۵   | ۴.۹        |
| ۱۳.۲ | Semantic Cache با pgvector                                 | استوری | متوسط  | ۵   | ۱۳.۱، ۱۱.۴ |
| ۱۳.۳ | فشرده‌سازی کانتکست (RTK و dedup)                           | استوری | متوسط  | ۸   | ۴.۴        |
| ۱۴.۱ | MFA با TOTP و Passkey                                      | استوری | بالا   | ۵   | ۳.۴        |
| ۱۴.۲ | SSO با OIDC                                                | استوری | بالا   | ۵   | ۳.۵        |
| ۱۴.۳ | نقش‌های سفارشی و ماتریس مجوز                               | استوری | متوسط  | ۵   | ۳.۵        |
| ۱۴.۴ | Audit Log کامل                                             | استوری | بالا   | ۳   | ۳.۵        |
| ۱۴.۵ | چرخش MASTER_KEY و کلیدهای provider                         | تسک    | متوسط  | ۳   | ۶.۵        |
| ۱۵.۱ | موتور Guardrail                                            | استوری | بالا   | ۸   | ۴.۹        |
| ۱۵.۲ | صفحهٔ سیاست‌های Guardrail                                  | استوری | متوسط  | ۳   | ۱۵.۱، ۷.۱  |
| ۱۶.۱ | صفحهٔ هزینه و بودجه                                        | استوری | بالا   | ۵   | ۶.۳، ۷.۳   |
| ۱۶.۲ | سیستم هشدار و کانال‌های اعلان                              | استوری | بالا   | ۵   | ۶.۵، ۱۲.۳  |
| ۱۶.۳ | نمای زنده (Live)                                           | استوری | متوسط  | ۳   | ۷.۷        |
| ۱۶.۴ | صفحهٔ Analytics                                            | استوری | متوسط  | ۵   | ۷.۳، ۱۳.۱  |
| ۱۶.۵ | Playground مقایسهٔ مدل‌ها                                  | استوری | متوسط  | ۵   | ۷.۶        |
| ۱۷.۱ | Config نسخه‌دار: diff، rollback و export/import YAML       | استوری | بالا   | ۵   | ۳.۹        |
| ۱۷.۲ | Tracing با OpenTelemetry                                   | تسک    | متوسط  | ۳   | ۸.۱        |
| ۱۷.۳ | استقرار HA: Postgres، Valkey و چند گیت‌وی                  | تسک    | بالا   | ۸   | ۲.۴        |
| ۱۸.۱ | تست Chaos                                                  | تسک    | بالا   | ۵   | ۱۷.۳، ۹.۴  |
| ۱۸.۲ | مستندات اسپرینت ۲                                          | تسک    | متوسط  | ۳   | ۱۷.۳       |

## اسپرینت ۳ — صورت‌حساب، ایجنت/MCP و انتشار v1.0

**هدف:** کیف پول و درگاه پرداخت و پرتال فروش، MCP gateway و A2A، مسیریابی classifier، چندرسانه‌ای، SAML/SCIM، امنیت زنجیرهٔ تأمین، benchmark و انتشار v1.0.

**بازه:** 2026-12-05 تا 2026-12-18 · **کارت:** ۲۰ · **استوری‌پوینت:** ۱۱۸

| #    | عنوان                                                       | نوع    | اولویت | SP  | وابستگی          |
| ---- | ----------------------------------------------------------- | ------ | ------ | --- | ---------------- |
| ۱۹.۱ | کیف پول و دفتر کل مالی (double-entry)                       | استوری | بالا   | ۸   | ۶.۴              |
| ۱۹.۲ | درگاه پرداخت: زرین‌پال و Stripe                             | استوری | بالا   | ۸   | ۱۹.۱             |
| ۱۹.۳ | کد هدیه و کد شارژ                                           | استوری | متوسط  | ۳   | ۱۹.۱             |
| ۱۹.۴ | قیمت‌گذاری فروش و گروه‌های کاربری                           | استوری | بالا   | ۵   | ۱۹.۱             |
| ۱۹.۵ | پرتال کاربر نهایی                                           | استوری | بالا   | ۸   | ۱۹.۲، ۱۹.۴       |
| ۱۹.۶ | فاکتور و گزارش سود                                          | استوری | متوسط  | ۵   | ۱۹.۴             |
| ۲۰.۱ | MCP Gateway                                                 | استوری | بالا   | ۸   | ۴.۹              |
| ۲۰.۲ | MCP Server مدیریتی DiRouter                                 | استوری | متوسط  | ۵   | ۲۰.۱             |
| ۲۰.۳ | A2A: Agent Card و JSON-RPC پایه                             | استوری | پایین  | ۵   | ۲۰.۱             |
| ۲۰.۴ | Classifier routing و aliasهای auto                          | استوری | بالا   | ۸   | ۱۲.۱             |
| ۲۰.۵ | پروفایل ایجنت‌ها و تولید پیکربندی یک‌کلیکی                  | استوری | متوسط  | ۳   | ۷.۱۰             |
| ۲۱.۱ | تصویر، TTS و STT                                            | استوری | متوسط  | ۸   | ۴.۹              |
| ۲۱.۲ | سیستم افزونهٔ provider (همراه با حالت اشتراک OAuth اختیاری) | استوری | پایین  | ۸   | ۴.۶              |
| ۲۲.۱ | SAML و SCIM                                                 | استوری | متوسط  | ۸   | ۱۴.۲             |
| ۲۲.۲ | Change Request برای تغییرات حساس                            | استوری | پایین  | ۵   | ۱۷.۱، ۱۴.۳       |
| ۲۲.۳ | امنیت زنجیرهٔ تأمین و مدل تهدید                             | تسک    | بالا   | ۵   | ۱.۵              |
| ۲۲.۴ | بهینه‌سازی کارایی و benchmark مقایسه‌ای                     | تسک    | بالا   | ۵   | ۱۸.۱             |
| ۲۲.۵ | سایت مستندات                                                | تسک    | متوسط  | ۵   | ۱۸.۲             |
| ۲۲.۶ | Helm chart (اختیاری)                                        | تسک    | پایین  | ۵   | ۱۷.۳             |
| ۲۲.۷ | انتشار نسخهٔ v1.0                                           | تسک    | بالا   | ۳   | ۲۲.۳، ۲۲.۴، ۲۲.۵ |
