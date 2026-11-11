[English](#english) · [فارسی](#persian)

<a id="english"></a>

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

---

<a id="persian"></a>

# برنامه‌ی تحویل DiRouter (DiTask)

> این نسخه‌ی انگلیسیِ محلیِ عکس‌فوری برنامه‌ریزی اصلیِ ۲۰۲۶-۱۱-۰۷ است. این یک برنامه است، نه گزارش تکمیل. [برد زنده‌ی DiTask](https://ditask.ir/b/cmw5uvrbk003d5lxy2bf842de) منبع حقیقت برای پیشرفت فعلی است.

## ورود محلی برد

فایل اصلی ورود برد فارسی (`dikar.board`، نسخه‌ی ۱) و اسکریپت‌های تولید آن به‌صورت محلی در `docs/board/` و `docs/tools/board/` نگهداری می‌شوند. این فایل‌ها از Git مستثنا شده‌اند. از پوشه‌ی بیرونی `docs/` دستور `python3 tools/board/build_board.py` را اجرا کنید تا JSON ورود محلی و خلاصه‌ی فارسی برد دوباره ساخته شوند. JSON را از رابط انتقال داده / ورود برد DiTask وارد کنید. خروجی اصلی همه‌ی کارت‌ها را در Backlog قرار داده و آن‌ها را به اسپرینت‌هایشان متصل کرده بود؛ اسپرینت ۱ فعال بود.

این خلاصه‌ی انگلیسی فقط محلی است و توسط تولیدکننده‌ی فارسی بازنویسی نمی‌شود.

## پشته‌ی فنی

- Backend: NestJS با Fastify adapter برای gateway، control-api و worker.
- Frontend: React + Vite + TypeScript، TanStack Router/Query، shadcn/ui، Tailwind، RTL.
- Database: PostgreSQL 17 + Prisma، با لاگ‌های پارتیشن‌بندی‌شده و جداول تجمیعی.
- شمارنده‌ها، کش، pub/sub و صف: Valkey + BullMQ.
- Reverse proxy: Traefik v3، با TLS از طریق Let's Encrypt و پشتیبانی از SSE.
- Deployment: Docker و Docker Compose (توسعه، production، HA)؛ مونوریپوی pnpm + Turborepo.

## قراردادها

- پیشوند عنوان هر کارت `epic.card` است؛ برای مثال `4.5` یعنی اپیک ۴، کارت ۵.
- DiTask وابستگی‌ها را در `blockedBy` ثبت می‌کند؛ ترتیب اجرا را از روی آن تعیین کنید.
- هر کارت چک‌لیست‌های Acceptance Criteria و Definition of Done را دارد.
- مدت تخمینی برابر است با استوری‌پوینت ضربدر ۶۰ دقیقه.
- مستندات نسخه‌دار انگلیسی هستند؛ معادل‌های فارسی فقط به‌صورت محلی در پوشه‌ی بیرونی `docs/` نگهداری می‌شوند.

## اپیک‌ها

| شماره | اپیک                               |
| ----- | ---------------------------------- |
| 0     | معماری و تصمیم‌ها                  |
| 1     | مونوریپو و ابزارها                 |
| 2     | Docker و Traefik                   |
| 3     | دیتابیس و control-api              |
| 4     | هستهٔ گیت‌وی                       |
| 5     | مسیریابی و تاب‌آوری                |
| 6     | محدودیت‌ها، بودجه‌ها و حسابداری    |
| 7     | داشبورد MVP                        |
| 8     | Observability                      |
| 9     | تست و QA                           |
| 10    | مستندات MVP                        |
| 11    | APIها و providerهای بیشتر          |
| 12    | مسیریابی و تاب‌آوری پیشرفته        |
| 13    | کش و صرفه‌جویی در توکن             |
| 14    | امنیت سازمانی                      |
| 15    | Guardrailها                        |
| 16    | داشبورد پیشرفته و هشدارها          |
| 17    | پیکربندی، tracing و HA             |
| 18    | Chaos و مستندات v1                 |
| 19    | صورت‌حساب و فروش                   |
| 20    | ایجنت‌ها، MCP و مسیریابی هوشمند    |
| 21    | چندرسانه‌ای و افزونه‌ها            |
| 22    | قابلیت‌های سازمانی، امنیت و انتشار |

## اسپرینت ۱ — MVP: گیت‌وی تاب‌آور، Docker، Traefik و داشبورد پایه

**هدف:** یک گیت‌وی end-to-end پشت Traefik که درخواست‌های OpenAI و Anthropic را با fallback، circuit breaker، rate limit، بودجه و حسابداری به چند provider می‌رساند؛ یک داشبورد فارسی پایه؛ استقرار با Docker و مستندات.

**بازه:** 2026-11-07 تا 2026-11-20 · **کارت‌ها:** 66 · **استوری‌پوینت:** 280

| کارت | عنوان                                                      | نوع    | اولویت | SP  | وابستگی‌ها              |
| ---- | ---------------------------------------------------------- | ------ | ------ | --- | ----------------------- |
| 0.1  | سند معماری و ADRهای پایه                                   | تسک    | فوری   | 3   | —                       |
| 1.1  | راه‌اندازی مونوریپو با pnpm و Turborepo                    | تسک    | فوری   | 3   | —                       |
| 1.2  | ابزارهای کیفیت کد و قراردادهای کامیت                       | تسک    | بالا   | 2   | 1.1                     |
| 1.3  | پکیج contracts: اسکیماهای مشترک                            | تسک    | فوری   | 5   | 1.1                     |
| 1.4  | پکیج shared: لاگر، خطا، اعتبارسنجی env و رمزنگاری          | تسک    | بالا   | 3   | 1.1                     |
| 1.5  | پایپلاین CI                                                | تسک    | بالا   | 3   | 1.2                     |
| 2.1  | Dockerfile چندمرحله‌ای برای همه‌ی اپ‌ها                    | تسک    | فوری   | 5   | 1.1                     |
| 2.2  | Docker Compose محیط توسعه                                  | تسک    | فوری   | 3   | 2.1                     |
| 2.3  | پیکربندی Traefik به‌عنوان ریورس پراکسی                     | استوری | فوری   | 5   | 2.2                     |
| 2.4  | Docker Compose محیط production                             | تسک    | بالا   | 3   | 2.3                     |
| 2.5  | Makefile و اسکریپت‌های عملیاتی                             | تسک    | متوسط  | 2   | 2.2                     |
| 3.1  | طراحی شِمای Prisma                                         | تسک    | فوری   | 8   | 1.1                     |
| 3.2  | پارتیشن‌بندی لاگ‌ها و جداول تجمیعی                         | تسک    | بالا   | 5   | 3.1                     |
| 3.3  | اسکلت control-api با NestJS                                | تسک    | فوری   | 3   | 1.3, 1.4, 3.1           |
| 3.4  | احراز هویت داشبورد و ویزارد راه‌اندازی اولیه               | استوری | فوری   | 5   | 3.3                     |
| 3.5  | RBAC پایه و مدیریت سازمان، تیم، پروژه و کاربر              | استوری | بالا   | 5   | 3.4                     |
| 3.6  | مدیریت Provider و Credential                               | استوری | فوری   | 5   | 3.5                     |
| 3.7  | مدیریت کلیدهای مجازی (Virtual Keys)                        | استوری | فوری   | 5   | 3.5                     |
| 3.8  | کاتالوگ مدل، Alias و Combo                                 | استوری | فوری   | 5   | 3.6                     |
| 3.9  | ساخت و انتشار Config Snapshot                              | تسک    | فوری   | 5   | 3.8, 3.7                |
| 3.10 | API آمار و لاگ برای داشبورد                                | استوری | بالا   | 5   | 3.2, 3.5                |
| 3.11 | Seed و داده‌های نمونه                                      | تسک    | متوسط  | 2   | 3.8                     |
| 4.1  | اسکلت گیت‌وی NestJS/Fastify با مسیر داغ سبک                | تسک    | فوری   | 5   | 1.3, 1.4                |
| 4.2  | همگام‌سازی Config گیت‌وی با fallback محلی                  | تسک    | فوری   | 5   | 4.1, 3.9                |
| 4.3  | احراز هویت کلید مجازی در گیت‌وی                            | تسک    | فوری   | 3   | 4.2                     |
| 4.4  | مدل canonical و مترجم‌های OpenAI و Anthropic (بدون stream) | تسک    | فوری   | 8   | 1.3                     |
| 4.5  | مترجم streaming (SSE)                                      | تسک    | فوری   | 8   | 4.4                     |
| 4.6  | آداپترهای OpenAI، Azure OpenAI و OpenAI-compatible         | تسک    | فوری   | 5   | 4.4                     |
| 4.7  | آداپتر Anthropic                                           | تسک    | فوری   | 3   | 4.4                     |
| 4.8  | آداپتر Gemini (خروجی)                                      | تسک    | بالا   | 5   | 4.4                     |
| 4.9  | Endpointهای chat completions، messages و models            | استوری | فوری   | 5   | 4.3, 4.5, 4.6, 4.7, 5.1 |
| 4.10 | پروکسی خروجی HTTP/HTTPS/SOCKS5                             | استوری | بالا   | 3   | 4.6                     |
| 5.1  | موتور مسیریابی                                             | تسک    | فوری   | 8   | 4.2                     |
| 5.2  | طبقه‌بندی خطاهای upstream                                  | تسک    | فوری   | 3   | 4.6, 4.7                |
| 5.3  | Retry با backoff و زنجیره‌ی fallback                       | تسک    | فوری   | 5   | 5.1, 5.2                |
| 5.4  | Timeoutهای چندلایه                                         | تسک    | بالا   | 3   | 5.3                     |
| 5.5  | Circuit breakerها برای هر provider و هر مدل                | تسک    | فوری   | 5   | 5.3                     |
| 5.6  | Cooldown اعتبار و lockout مدل                              | تسک    | فوری   | 3   | 5.5                     |
| 5.7  | fallback امن در stream و bulkhead                          | تسک    | بالا   | 5   | 5.3, 4.5                |
| 5.8  | Graceful shutdown و drain                                  | تسک    | بالا   | 3   | 6.4, 2.4                |
| 6.1  | Rate limiter توزیع‌شده روی Valkey                          | تسک    | فوری   | 5   | 4.3                     |
| 6.2  | محاسبه‌ی هزینه و تخمین توکن                                | تسک    | فوری   | 3   | 3.8                     |
| 6.3  | بودجه در سطح کلید، پروژه و تیم                             | استوری | بالا   | 5   | 6.1, 6.2                |
| 6.4  | خط لوله‌ی رویدادهای مصرف با outbox                         | تسک    | فوری   | 8   | 6.2, 3.2                |
| 6.5  | Worker: پردازش صف، تجمیع و نگهداری                         | تسک    | بالا   | 5   | 6.4                     |
| 7.1  | اسکلت داشبورد React با RTL و i18n                          | تسک    | فوری   | 8   | 1.1                     |
| 7.2  | صفحات ورود و ویزارد راه‌اندازی                             | استوری | فوری   | 3   | 7.1, 3.4                |
| 7.3  | صفحه‌ی Overview                                            | استوری | فوری   | 5   | 7.1, 3.10               |
| 7.4  | صفحه‌ی Providers و Credentials                             | استوری | فوری   | 5   | 7.1, 3.6                |
| 7.5  | صفحه‌ی کلیدهای مجازی                                       | استوری | فوری   | 3   | 7.1, 3.7                |
| 7.6  | صفحه‌ی مدل‌ها، Aliasها و ویرایشگر Combo                    | استوری | فوری   | 5   | 7.1, 3.8                |
| 7.7  | Request Log Explorer                                       | استوری | فوری   | 5   | 7.1, 3.10               |
| 7.8  | صفحه‌ی Health                                              | استوری | بالا   | 3   | 7.1, 3.10, 5.6          |
| 7.9  | صفحات سازمان، تیم، پروژه و کاربران                         | استوری | بالا   | 3   | 7.1, 3.5                |
| 7.10 | صفحه‌ی راهنمای اتصال ابزارها                               | استوری | متوسط  | 2   | 7.5                     |
| 8.1  | متریک‌های Prometheus                                       | تسک    | بالا   | 3   | 5.5, 6.4                |
| 8.2  | لاگ ساخت‌یافته و correlation ID                            | تسک    | بالا   | 2   | 4.1                     |
| 8.3  | پروفایل مانیتورینگ: Prometheus و Grafana                   | تسک    | متوسط  | 3   | 8.1, 2.2                |
| 9.1  | Mock provider با تزریق خطا                                 | تسک    | فوری   | 5   | 1.3                     |
| 9.2  | تست‌های واحد و یکپارچه‌سازی                                | تسک    | بالا   | 5   | 5.3, 6.1                |
| 9.3  | تست end-to-end سناریوهای اصلی                              | تسک    | بالا   | 5   | 9.1, 4.9, 6.4, 2.3      |
| 9.4  | تست بار پایه با k6                                         | تسک    | متوسط  | 3   | 9.3                     |
| 10.1 | README اصلی و Quick Start                                  | تسک    | بالا   | 2   | 4.9, 7.2                |
| 10.2 | راهنمای استقرار production و مرجع متغیرهای محیطی           | تسک    | بالا   | 3   | 2.4                     |
| 10.3 | راهنمای کاربر داشبورد و مفاهیم                             | تسک    | متوسط  | 3   | 7.7                     |
| 10.4 | Runbook عملیاتی                                            | تسک    | بالا   | 3   | 9.3                     |

## اسپرینت ۲ — v1: تاب‌آوری پیشرفته، امنیت سازمانی، کش و تحلیل

**هدف:** استراتژی‌های هوشمند مسیریابی و hedging، کش و فشرده‌سازی، MFA، SSO و audit، guardrail، هشدار، داشبورد تحلیلی، پیکربندی نسخه‌دار و استقرار HA با تست chaos.

**بازه:** 2026-11-21 تا 2026-12-04 · **کارت‌ها:** 29 · **استوری‌پوینت:** 143

| کارت | عنوان                                                      | نوع    | اولویت | SP  | وابستگی‌ها |
| ---- | ---------------------------------------------------------- | ------ | ------ | --- | ---------- |
| 11.1 | ورودی Gemini API: generateContent و streaming              | استوری | بالا   | 5   | 4.8        |
| 11.2 | OpenAI Responses API، ورودی و خروجی                        | استوری | بالا   | 8   | 4.5        |
| 11.3 | آداپترهای Bedrock، Vertex و providerهای کم‌هزینه           | تسک    | متوسط  | 8   | 4.6        |
| 11.4 | Endpoint embeddings: /v1/embeddings                        | استوری | متوسط  | 3   | 4.9        |
| 12.1 | استراتژی‌های latency، cost، least-used و headroom          | تسک    | بالا   | 8   | 5.1        |
| 12.2 | Request hedging                                            | تسک    | متوسط  | 5   | 12.1       |
| 12.3 | Health probe دوره‌ای و غیرفعال/فعال‌سازی خودکار credential | تسک    | بالا   | 3   | 5.6        |
| 12.4 | Session affinity و مسیریابی بر اساس context                | تسک    | متوسط  | 3   | 12.1       |
| 12.5 | شبیه‌ساز مسیریابی (dry run)                                | استوری | متوسط  | 3   | 12.1, 7.6  |
| 13.1 | Exact cache روی Valkey                                     | استوری | بالا   | 5   | 4.9        |
| 13.2 | Semantic cache با pgvector                                 | استوری | متوسط  | 5   | 13.1, 11.4 |
| 13.3 | فشرده‌سازی context: RTK و dedup                            | استوری | متوسط  | 8   | 4.4        |
| 14.1 | MFA با TOTP و Passkey                                      | استوری | بالا   | 5   | 3.4        |
| 14.2 | SSO با OIDC                                                | استوری | بالا   | 5   | 3.5        |
| 14.3 | نقش‌های سفارشی و ماتریس مجوز                               | استوری | متوسط  | 5   | 3.5        |
| 14.4 | Audit Log کامل                                             | استوری | بالا   | 3   | 3.5        |
| 14.5 | چرخش MASTER_KEY و کلیدهای provider                         | تسک    | متوسط  | 3   | 6.5        |
| 15.1 | موتور Guardrail                                            | استوری | بالا   | 8   | 4.9        |
| 15.2 | صفحه‌ی سیاست‌های Guardrail                                 | استوری | متوسط  | 3   | 15.1, 7.1  |
| 16.1 | صفحه‌ی هزینه و بودجه                                       | استوری | بالا   | 5   | 6.3, 7.3   |
| 16.2 | سیستم هشدار و کانال‌های اعلان                              | استوری | بالا   | 5   | 6.5, 12.3  |
| 16.3 | نمای زنده (Live)                                           | استوری | متوسط  | 3   | 7.7        |
| 16.4 | صفحه‌ی Analytics                                           | استوری | متوسط  | 5   | 7.3, 13.1  |
| 16.5 | Playground مقایسه‌ی مدل‌ها                                 | استوری | متوسط  | 5   | 7.6        |
| 17.1 | Config نسخه‌دار: diff، rollback و export/import YAML       | استوری | بالا   | 5   | 3.9        |
| 17.2 | Tracing با OpenTelemetry                                   | تسک    | متوسط  | 3   | 8.1        |
| 17.3 | استقرار HA: Postgres، Valkey و چند گیت‌وی                  | تسک    | بالا   | 8   | 2.4        |
| 18.1 | تست Chaos                                                  | تسک    | بالا   | 5   | 17.3, 9.4  |
| 18.2 | مستندات اسپرینت ۲                                          | تسک    | متوسط  | 3   | 17.3       |

## اسپرینت ۳ — صورت‌حساب، ایجنت/MCP و انتشار v1.0

**هدف:** کیف پول، درگاه پرداخت و پرتال فروش، MCP gateway و A2A، مسیریابی classifier، چندرسانه‌ای، SAML/SCIM، امنیت زنجیره‌ی تأمین، benchmark و انتشار v1.0.

**بازه:** 2026-12-05 تا 2026-12-18 · **کارت‌ها:** 20 · **استوری‌پوینت:** 118

| کارت | عنوان                                                        | نوع    | اولویت | SP  | وابستگی‌ها       |
| ---- | ------------------------------------------------------------ | ------ | ------ | --- | ---------------- |
| 19.1 | کیف پول و دفتر کل مالی (double-entry)                        | استوری | بالا   | 8   | 6.4              |
| 19.2 | درگاه پرداخت: Zarinpal و Stripe                              | استوری | بالا   | 8   | 19.1             |
| 19.3 | کد هدیه و کد شارژ                                            | استوری | متوسط  | 3   | 19.1             |
| 19.4 | قیمت‌گذاری فروش و گروه‌های کاربری                            | استوری | بالا   | 5   | 19.1             |
| 19.5 | پرتال کاربر نهایی                                            | استوری | بالا   | 8   | 19.2, 19.4       |
| 19.6 | فاکتور و گزارش سود                                           | استوری | متوسط  | 5   | 19.4             |
| 20.1 | MCP Gateway                                                  | استوری | بالا   | 8   | 4.9              |
| 20.2 | MCP Server مدیریتی DiRouter                                  | استوری | متوسط  | 5   | 20.1             |
| 20.3 | A2A: Agent Card و JSON-RPC پایه                              | استوری | پایین  | 5   | 20.1             |
| 20.4 | Classifier routing و aliasهای auto                           | استوری | بالا   | 8   | 12.1             |
| 20.5 | پروفایل ایجنت‌ها و تولید پیکربندی یک‌کلیکی                   | استوری | متوسط  | 3   | 7.10             |
| 21.1 | تصویر، TTS و STT                                             | استوری | متوسط  | 8   | 4.9              |
| 21.2 | سیستم افزونه‌ی provider (همراه با حالت اختیاری اشتراک OAuth) | استوری | پایین  | 8   | 4.6              |
| 22.1 | SAML و SCIM                                                  | استوری | متوسط  | 8   | 14.2             |
| 22.2 | Change request برای عملیات حساس                              | استوری | پایین  | 5   | 17.1, 14.3       |
| 22.3 | امنیت زنجیره‌ی تأمین و مدل تهدید                             | تسک    | بالا   | 5   | 1.5              |
| 22.4 | بهینه‌سازی کارایی و benchmark مقایسه‌ای                      | تسک    | بالا   | 5   | 18.1             |
| 22.5 | سایت مستندات                                                 | تسک    | متوسط  | 5   | 18.2             |
| 22.6 | Helm chart (اختیاری)                                         | تسک    | پایین  | 5   | 17.3             |
| 22.7 | انتشار نسخه‌ی v1.0                                           | تسک    | بالا   | 3   | 22.3, 22.4, 22.5 |
