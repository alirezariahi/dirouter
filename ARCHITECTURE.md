[English](#english) · [فارسی](#persian)

<a id="english"></a>

# DiRouter architecture

> This document defines the target MVP architecture. Decisions and their rationale are recorded in the [ADRs](adr/README.md); domain terms are defined in the [glossary](GLOSSARY.md). A design described here does not imply that its implementation is complete.

## 1. Overview

DiRouter has two separate parts:

- **Data plane** (`apps/gateway`): the hot path for every LLM request. It handles virtual-key authentication, rate limits, budgets, routing, format translation, fallback, and streaming. It must be fast, stateless, and independent of the control plane.
- **Control plane** (`apps/control-api`, `apps/worker`, `apps/dashboard`): organization, user, provider, key, model, and combo management; configuration publication; usage-event processing; reporting; and the dashboard.

The primary design principle ([ADR-006](adr/0006-data-plane-independence.md)) is that **the data plane does not depend on the control plane**. If PostgreSQL, control-api, or worker becomes unavailable, existing traffic continues using the last valid configuration.

```mermaid
flowchart LR
  client["Client<br/>(OpenAI / Anthropic SDK, Claude Code, Cursor, ...)"]
  admin["Administrator<br/>(browser)"]

  subgraph edge["Edge"]
    traefik["Traefik v3<br/>TLS, routing, SSE"]
  end

  subgraph dp["Data plane"]
    gw1["gateway #1"]
    gw2["gateway #N"]
    disk[("On-disk snapshot<br/>+ local outbox")]
  end

  subgraph cp["Control plane"]
    api["control-api<br/>NestJS"]
    worker["worker<br/>BullMQ consumer"]
    dash["dashboard<br/>React + Vite"]
  end

  subgraph data["Data stores"]
    valkey[("Valkey<br/>Counters, cache, pub/sub, queue")]
    pg[("PostgreSQL 17<br/>Config, ledger, logs")]
  end

  providers["Providers<br/>OpenAI, Anthropic, Gemini, Azure, OpenAI-compatible"]

  client -->|"/v1/chat/completions<br/>/v1/messages"| traefik
  admin --> traefik
  traefik --> gw1 & gw2
  traefik -->|"/api"| api
  traefik -->|"/"| dash

  gw1 & gw2 -->|"HTTPS (+proxy)"| providers
  gw1 & gw2 <-->|"Rate limits, budgets, cooldown"| valkey
  gw1 & gw2 -->|"UsageEvent"| valkey
  gw1 & gw2 --- disk

  api -->|"ConfigSnapshot + pub/sub"| valkey
  api <--> pg
  worker -->|"Consume queue"| valkey
  worker -->|"Ledger, logs, aggregates"| pg
  dash -->|"REST"| api
```

## 2. Components

| Component         | Responsibilities                                                                                                     | Hard runtime dependencies                                                 |
| ----------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| **Traefik**       | TLS (Let's Encrypt), path routing, health checks, unbuffered SSE                                                     | None                                                                      |
| **gateway**       | OpenAI/Anthropic API compatibility, routing, fallback, circuit breakers, rate limits, budgets, usage publication     | None, provided a valid snapshot is available; Valkey has a local fallback |
| **control-api**   | Administrative API, dashboard authentication, RBAC, credential encryption, ConfigSnapshot generation and publication | PostgreSQL, Valkey                                                        |
| **worker**        | UsageEvent consumption, ledger/log writes, aggregate tables, partition maintenance                                   | PostgreSQL, Valkey                                                        |
| **dashboard**     | Persian, RTL administrative UI                                                                                       | control-api                                                               |
| **mock-provider** | Synthetic upstream with injected 429/5xx responses and delays for testing and chaos scenarios                        | None                                                                      |
| **Valkey**        | Rate-limit/budget counters, cooldown/breaker state, config pub/sub, BullMQ queue                                     | None                                                                      |
| **PostgreSQL**    | Source of truth for configuration, users, the financial ledger, and partitioned request logs                         | None                                                                      |

## 3. Request flow

```mermaid
sequenceDiagram
  autonumber
  participant C as Client
  participant T as Traefik
  participant G as gateway
  participant V as Valkey
  participant P1 as Provider A
  participant P2 as Provider B

  C->>T: POST /v1/messages (Bearer dr-live-...)
  T->>G: Proxy without buffering
  G->>G: HMAC key, look up in-memory snapshot
  G->>V: Rate limit and budget check (atomic Lua)
  V-->>G: Allowed
  G->>G: Resolve alias/combo, exclude circuit-open or cooling targets
  G->>G: Translate Anthropic to canonical to OpenAI
  G->>P1: Request (connect / TTFT / idle timeouts)
  P1-->>G: 529 overloaded
  G->>V: Record breaker error and credential cooldown
  G->>P2: Fall back before sending any client bytes
  P2-->>G: SSE stream
  G-->>C: Stream translated into Anthropic format
  G->>V: Update budget usage and publish UsageEvent asynchronously
```

Gateway stages:

1. **Ingress and authentication:** read the virtual key from `Authorization: Bearer` or `x-api-key`, hash it with HMAC-SHA256, and look it up in the in-memory snapshot. No database query occurs on the hot path.
2. **Validation:** validate the body with `@dirouter/contracts` schemas. Preserve unknown fields where the external API contracts allow them.
3. **Limits:** apply key-, project-, and team-level RPM, TPM, concurrency, and budget checks through atomic Lua scripts in Valkey. If Valkey is unavailable, use the local limiter and the configured `failMode`.
4. **Routing:** resolve the requested name to an alias, combo, or model and construct an ordered list of model/credential targets. Exclude circuit-open targets, cooling credentials, and locked models.
5. **Translation:** translate the request into the canonical model and then into the upstream API. This requires N + M translators rather than N × M.
6. **Dispatch and resilience:** apply layered timeouts, retry with backoff and jitter, and fallback to the next target. Stream fallback is allowed only before the first byte is sent to the client.
7. **Response:** translate the response or stream back to the inbound API format. Errors use that same format and a stable DiRouter code.
8. **Accounting:** calculate cost from usage and model prices, update budget counters in Valkey, and enqueue a `UsageEvent`. The response does not wait for asynchronous persistence.

Monetary values use USD decimal strings with up to eight fractional digits at contract boundaries and `Decimal(18,8)` in PostgreSQL. The shared money helpers use BigInt fixed-point arithmetic (`1 USD = 10^8` internal units); model prices are USD per million tokens. Budget exhaustion returns `budget_exceeded` with HTTP 429.

## 4. Usage-event flow

```mermaid
flowchart LR
  gw["gateway"] -->|"Enqueue asynchronously"| q[["BullMQ queue<br/>usage-events"]]
  gw -.->|"Valkey unavailable"| outbox[("Local outbox<br/>On-disk file")]
  outbox -.->|"Replay after recovery"| q
  q --> w["worker"]
  w -->|"Idempotent insert"| logs[("Request logs<br/>Monthly partitions")]
  w --> ledger[("Ledger")]
  w --> agg[("Aggregate tables<br/>Hourly / daily")]
  agg --> api["control-api"] --> dash["dashboard"]
```

- Each event has an `idempotencyKey`. Queue retries or outbox replays must not charge the same request twice; database writes use an appropriate unique key and `ON CONFLICT ... DO NOTHING`.
- Valkey holds live budget counters. PostgreSQL is the accounting source of truth, and worker periodically reconciles counters against it.
- Logs are stored in a partitioned table. Dashboard queries use aggregate tables instead of running expensive aggregations on raw logs.

## 5. Configuration flow

```mermaid
sequenceDiagram
  participant A as Administrator
  participant API as control-api
  participant PG as PostgreSQL
  participant V as Valkey
  participant G as gateway

  A->>API: Change combo
  API->>PG: Save in a transaction
  API->>API: Build ConfigSnapshot (version+1, checksum)
  API->>PG: Save versioned snapshot
  API->>V: SET config:latest + PUBLISH config:changed
  V-->>G: Change notification
  G->>API: GET /internal/config/snapshot?since=version
  G->>G: Validate schemaVersion and checksum, replace atomically
  G->>G: Persist last valid snapshot to disk
  Note over G: On control-api failure, keep the current snapshot and retry polling
```

- `ConfigSnapshot` carries a `schemaVersion` (format) and a monotonic `version`. Gateway rejects older versions and unknown schema versions.
- Provider secrets are included only as AES-256-GCM ciphertext. Gateway decrypts them in memory using `MASTER_KEY`.
- If control-api is unavailable at startup, gateway starts with a valid on-disk snapshot.

## 6. Resilience

| Risk                                         | Response                                                                       |
| -------------------------------------------- | ------------------------------------------------------------------------------ |
| Transient provider error (429, 5xx, timeout) | Classify errors, retry with backoff/jitter, and fall back through the combo    |
| Complete provider outage                     | Provider/model circuit breakers with half-open probes                          |
| A credential reaches its limit               | Cool down that credential and continue with another                            |
| Slow provider                                | Separate connect, TTFT, and idle timeouts; a per-provider concurrency bulkhead |
| control-api or PostgreSQL outage             | Continue using in-memory/on-disk snapshots                                     |
| Valkey outage                                | Local limiter, configurable `failMode`, and local usage outbox                 |
| New deployment                               | Graceful shutdown: stop accepting requests, drain open streams, then exit      |

## 7. Technology choices

| Layer                    | Choice                                                                      | ADR                                           |
| ------------------------ | --------------------------------------------------------------------------- | --------------------------------------------- |
| gateway                  | NestJS with the Fastify adapter and a lightweight hot path                  | [ADR-001](adr/0001-gateway-nestjs-fastify.md) |
| control-api, worker      | NestJS                                                                      | [ADR-001](adr/0001-gateway-nestjs-fastify.md) |
| Database                 | PostgreSQL 17 + Prisma                                                      | [ADR-002](adr/0002-postgresql-prisma.md)      |
| Counters, cache, pub/sub | Valkey                                                                      | [ADR-003](adr/0003-valkey.md)                 |
| Reverse proxy            | Traefik v3                                                                  | [ADR-004](adr/0004-traefik-reverse-proxy.md)  |
| Event queue              | BullMQ on Valkey                                                            | [ADR-005](adr/0005-bullmq-event-queue.md)     |
| Dashboard                | React + Vite + TypeScript, TanStack Router/Query, shadcn/ui, Tailwind (RTL) | None                                          |
| Schemas                  | Zod in `@dirouter/contracts`, with JSON Schema export                       | None                                          |
| Monorepo                 | pnpm workspaces + Turborepo, strict TypeScript, ESM                         | None                                          |
| Deployment               | Docker and Docker Compose (development, production, HA)                     | None                                          |

## 8. Shared packages

| Package                   | Contents                                                                                                          | Consumers                              |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| `@dirouter/contracts`     | OpenAI/Anthropic schemas, canonical model, ConfigSnapshot, UsageEvent, error formats and taxonomy                 | All applications as required           |
| `@dirouter/shared`        | Pino with redaction, errors, environment validation, versioned AES-256-GCM, ULID, HMAC, fixed-point money helpers | Node applications                      |
| `@dirouter/db`            | Prisma schema and client                                                                                          | control-api, worker                    |
| `@dirouter/model-catalog` | Model prices and capabilities                                                                                     | control-api, gateway through snapshots |
| `@dirouter/ui`            | React components                                                                                                  | dashboard                              |

Gateway must not depend on `@dirouter/db`; this enforces ADR-006 at the code level.

---

<a id="persian"></a>

# معماری DiRouter

> این سند معماری هدف MVP را تعریف می‌کند. تصمیم‌ها و دلایل آن‌ها در [ADRها](adr/README.md) ثبت شده‌اند و اصطلاحات دامنه در [واژه‌نامه](GLOSSARY.md) تعریف شده‌اند. وجود یک طراحی در این سند به معنای کامل بودن پیاده‌سازی آن نیست.

## 1. نمای کلی

DiRouter از دو بخش جدا تشکیل شده است:

- **صفحه داده (Data plane)** (`apps/gateway`): مسیر پرترافیک هر درخواست LLM. احراز هویت با virtual key، محدودیت نرخ، بودجه، مسیریابی، ترجمه قالب، fallback و streaming را انجام می‌دهد. باید سریع، بی‌حالت (stateless) و مستقل از صفحه کنترل باشد.
- **صفحه کنترل (Control plane)** (`apps/control-api`، `apps/worker`، `apps/dashboard`): مدیریت سازمان، کاربران، providerها، کلیدها، مدل‌ها و comboها؛ انتشار پیکربندی؛ پردازش رویدادهای مصرف؛ گزارش‌گیری و داشبورد.

اصل طراحی اصلی ([ADR-006](adr/0006-data-plane-independence.md)) این است که **صفحه داده به صفحه کنترل وابسته نیست**. اگر PostgreSQL، control-api یا worker در دسترس نباشند، ترافیک موجود با آخرین پیکربندی معتبر ادامه می‌یابد.

```mermaid
flowchart LR
  client["کلاینت<br/>(OpenAI / Anthropic SDK، Claude Code، Cursor، ...)"]
  admin["مدیر<br/>(مرورگر)"]

  subgraph edge["لبه شبکه"]
    traefik["Traefik v3<br/>TLS، مسیریابی، SSE"]
  end

  subgraph dp["صفحه داده"]
    gw1["gateway #1"]
    gw2["gateway #N"]
    disk[("اسنپ‌شات روی دیسک<br/>+ outbox محلی")]
  end

  subgraph cp["صفحه کنترل"]
    api["control-api<br/>NestJS"]
    worker["worker<br/>مصرف‌کننده BullMQ"]
    dash["dashboard<br/>React + Vite"]
  end

  subgraph data["ذخیره‌سازها"]
    valkey[("Valkey<br/>شمارنده‌ها، cache، pub/sub، صف")]
    pg[("PostgreSQL 17<br/>پیکربندی، دفتر مالی، لاگ‌ها")]
  end

  providers["Providerها<br/>OpenAI، Anthropic، Gemini، Azure، سازگار با OpenAI"]

  client -->|"/v1/chat/completions<br/>/v1/messages"| traefik
  admin --> traefik
  traefik --> gw1 & gw2
  traefik -->|"/api"| api
  traefik -->|"/"| dash

  gw1 & gw2 -->|"HTTPS (+proxy)"| providers
  gw1 & gw2 <-->|"محدودیت نرخ، بودجه، cooldown"| valkey
  gw1 & gw2 -->|"UsageEvent"| valkey
  gw1 & gw2 --- disk

  api -->|"ConfigSnapshot + pub/sub"| valkey
  api <--> pg
  worker -->|"مصرف از صف"| valkey
  worker -->|"دفتر مالی، لاگ‌ها، تجمیع‌ها"| pg
  dash -->|"REST"| api
```

## 2. اجزا

| جزء               | مسئولیت‌ها                                                                                                      | وابستگی‌های سخت زمان اجرا                                                |
| ----------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| **Traefik**       | TLS (Let's Encrypt)، مسیریابی بر اساس مسیر، health checkها، SSE بدون buffer                                     | ندارد                                                                    |
| **gateway**       | سازگاری با APIهای OpenAI/Anthropic، مسیریابی، fallback، circuit breakerها، محدودیت نرخ، بودجه، انتشار داده مصرف | ندارد، به شرط موجود بودن یک snapshot معتبر؛ Valkey یک fallback محلی دارد |
| **control-api**   | API مدیریتی، احراز هویت داشبورد، RBAC، رمزنگاری اعتبارنامه‌ها، ساخت و انتشار ConfigSnapshot                     | PostgreSQL، Valkey                                                       |
| **worker**        | مصرف UsageEvent، نوشتن در دفتر مالی/لاگ‌ها، جدول‌های تجمیع، نگهداری partitionها                                 | PostgreSQL، Valkey                                                       |
| **dashboard**     | رابط مدیریتی فارسی و RTL                                                                                        | control-api                                                              |
| **mock-provider** | upstream مصنوعی با پاسخ‌های تزریق‌شده 429/5xx و تأخیر برای تست و سناریوهای chaos                                | ندارد                                                                    |
| **Valkey**        | شمارنده‌های محدودیت نرخ/بودجه، وضعیت cooldown/breaker، pub/sub پیکربندی، صف BullMQ                              | ندارد                                                                    |
| **PostgreSQL**    | منبع حقیقت پیکربندی، کاربران، دفتر مالی و لاگ‌های درخواست پارتیشن‌بندی‌شده                                      | ندارد                                                                    |

## 3. جریان درخواست

```mermaid
sequenceDiagram
  autonumber
  participant C as کلاینت
  participant T as Traefik
  participant G as gateway
  participant V as Valkey
  participant P1 as Provider A
  participant P2 as Provider B

  C->>T: POST /v1/messages (Bearer dr-live-...)
  T->>G: ارسال بدون buffer
  G->>G: HMAC کلید، جست‌وجو در snapshot حافظه
  G->>V: بررسی محدودیت نرخ و بودجه (Lua اتمی)
  V-->>G: مجاز
  G->>G: حل alias/combo، حذف targetهای با circuit باز یا در cooldown
  G->>G: ترجمه Anthropic به canonical و سپس به OpenAI
  G->>P1: درخواست (timeoutهای اتصال / TTFT / بیکاری)
  P1-->>G: 529 overloaded
  G->>V: ثبت خطای breaker و cooldown اعتبارنامه
  G->>P2: fallback پیش از ارسال هر بایت به کلاینت
  P2-->>G: جریان SSE
  G-->>C: جریان ترجمه‌شده به قالب Anthropic
  G->>V: به‌روزرسانی مصرف بودجه و انتشار ناهمزمان UsageEvent
```

مراحل gateway:

1. **ورودی و احراز هویت:** کلید مجازی را از `Authorization: Bearer` یا `x-api-key` می‌خواند، با HMAC-SHA256 هش می‌کند و در snapshot حافظه جست‌وجو می‌کند. هیچ پرس‌وجوی پایگاه داده‌ای در مسیر پرترافیک انجام نمی‌شود.
2. **اعتبارسنجی:** بدنه درخواست را با schemaهای `@dirouter/contracts` اعتبارسنجی می‌کند. فیلدهای ناشناخته را، تا جایی که قراردادهای APIهای خارجی اجازه می‌دهند، حفظ می‌کند.
3. **محدودیت‌ها:** بررسی‌های RPM، TPM، همزمانی و بودجه را در سطح کلید، پروژه و تیم، از طریق اسکریپت‌های Lua اتمی در Valkey اعمال می‌کند. اگر Valkey در دسترس نباشد، از محدودکننده محلی و `failMode` پیکربندی‌شده استفاده می‌شود.
4. **مسیریابی:** نام درخواست‌شده را به یک alias، combo یا مدل تبدیل می‌کند و فهرست مرتبی از targetهای مدل/اعتبارنامه می‌سازد. targetهای با circuit باز، اعتبارنامه‌های در cooldown و مدل‌های قفل‌شده حذف می‌شوند.
5. **ترجمه:** درخواست را ابتدا به مدل canonical و سپس به API upstream ترجمه می‌کند. این کار به N + M مترجم نیاز دارد، نه N × M.
6. **ارسال و تاب‌آوری:** timeoutهای لایه‌ای، retry با backoff و jitter، و fallback به target بعدی را اعمال می‌کند. fallback در streaming فقط پیش از ارسال اولین بایت به کلاینت مجاز است.
7. **پاسخ:** پاسخ یا جریان را به قالب API ورودی برمی‌گرداند. خطاها همان قالب را دارند و یک کد پایدار DiRouter.
8. **حسابداری:** هزینه را از مصرف توکن و قیمت‌های مدل محاسبه می‌کند، شمارنده‌های بودجه را در Valkey به‌روز می‌کند و یک `UsageEvent` را به صف می‌فرستد. پاسخ منتظر ماندگاری ناهمزمان نمی‌ماند.

مقادیر پولی در مرزهای قرارداد به صورت رشته‌های اعشاری USD با حداکثر هشت رقم اعشار، و در PostgreSQL به صورت `Decimal(18,8)` هستند. کمک‌تابع‌های پولی مشترک از حساب نقطه‌ثابت BigInt استفاده می‌کنند (`1 USD = 10^8` واحد داخلی)؛ قیمت مدل‌ها بر حسب USD به ازای هر یک میلیون توکن است. اتمام بودجه با HTTP 429 و کد `budget_exceeded` پاسخ داده می‌شود.

## 4. جریان رویداد مصرف

```mermaid
flowchart LR
  gw["gateway"] -->|"صف‌بندی ناهمزمان"| q[["صف BullMQ<br/>usage-events"]]
  gw -.->|"Valkey در دسترس نیست"| outbox[("Outbox محلی<br/>فایل روی دیسک")]
  outbox -.->|"بازپخش پس از بازیابی"| q
  q --> w["worker"]
  w -->|"درج idempotent"| logs[("لاگ‌های درخواست<br/>partitionهای ماهانه")]
  w --> ledger[("دفتر مالی")]
  w --> agg[("جدول‌های تجمیع<br/>ساعتی / روزانه")]
  agg --> api["control-api"] --> dash["dashboard"]
```

- هر رویداد یک `idempotencyKey` دارد. تلاش‌های مجدد صف یا بازپخش outbox نباید یک درخواست را دوبار هزینه‌گذاری کنند؛ نوشتن در پایگاه داده از کلید یکتای مناسب و `ON CONFLICT ... DO NOTHING` استفاده می‌کند.
- Valkey شمارنده‌های زندهٔ بودجه را نگه می‌دارد. PostgreSQL منبع حقیقت حسابداری است و worker به‌صورت دوره‌ای شمارنده‌ها را با آن تطبیق می‌دهد.
- لاگ‌ها در یک جدول پارتیشن‌بندی‌شده ذخیره می‌شوند. پرس‌وجوهای داشبورد از جدول‌های تجمیع استفاده می‌کنند تا روی لاگ‌های خام تجمیع سنگین اجرا نشود.

## 5. جریان پیکربندی

```mermaid
sequenceDiagram
  participant A as مدیر
  participant API as control-api
  participant PG as PostgreSQL
  participant V as Valkey
  participant G as gateway

  A->>API: تغییر combo
  API->>PG: ذخیره در یک تراکنش
  API->>API: ساخت ConfigSnapshot (version+1، checksum)
  API->>PG: ذخیره snapshot نسخه‌دار
  API->>V: SET config:latest + PUBLISH config:changed
  V-->>G: اطلاع تغییر
  G->>API: GET /internal/config/snapshot?since=version
  G->>G: اعتبارسنجی schemaVersion و checksum، جایگزینی اتمی
  G->>G: ذخیره آخرین snapshot معتبر روی دیسک
  Note over G: در صورت خرابی control-api، snapshot فعلی نگه داشته می‌شود و polling دوباره تلاش می‌کند
```

- `ConfigSnapshot` دارای `schemaVersion` (قالب) و `version` یکنواخت است. gateway نسخه‌های قدیمی‌تر و schemaVersionهای ناشناخته را رد می‌کند.
- اسرار providerها فقط به صورت رمزنگاری‌شده با AES-256-GCM در snapshot قرار می‌گیرند. gateway آن‌ها را با استفاده از `MASTER_KEY` در حافظه رمزگشایی می‌کند.
- اگر control-api هنگام راه‌اندازی در دسترس نباشد، gateway با یک snapshot معتبر روی دیسک شروع می‌کند.

## 6. تاب‌آوری

| ریسک                                    | پاسخ                                                                                           |
| --------------------------------------- | ---------------------------------------------------------------------------------------------- |
| خطای گذرای provider (429، 5xx، timeout) | طبقه‌بندی خطاها، retry با backoff/jitter، و fallback از طریق combo                             |
| قطع کامل provider                       | circuit breakerهای provider/model با probeهای half-open                                        |
| رسیدن یک اعتبارنامه به سقف مجاز         | cooldown همان اعتبارنامه و ادامه با اعتبارنامه دیگر                                            |
| provider کند                            | timeoutهای جدا برای اتصال، TTFT و بیکاری؛ دیواره همزمانی (bulkhead) به‌ازای هر provider        |
| قطعی control-api یا PostgreSQL          | ادامه با snapshotهای حافظه/دیسک                                                                |
| قطعی Valkey                             | محدودکننده محلی، `failMode` قابل پیکربندی و outbox محلی مصرف                                   |
| استقرار نسخه جدید                       | خاموشی تدریجی: پذیرش درخواست متوقف می‌شود، جریان‌های باز تخلیه می‌شوند و سپس خروج انجام می‌شود |

## 7. انتخاب فناوری‌ها

| لایه                       | انتخاب                                                                      | ADR                                           |
| -------------------------- | --------------------------------------------------------------------------- | --------------------------------------------- |
| gateway                    | NestJS با adapter نوع Fastify و مسیر پرترافیک سبک                           | [ADR-001](adr/0001-gateway-nestjs-fastify.md) |
| control-api، worker        | NestJS                                                                      | [ADR-001](adr/0001-gateway-nestjs-fastify.md) |
| پایگاه داده                | PostgreSQL 17 + Prisma                                                      | [ADR-002](adr/0002-postgresql-prisma.md)      |
| شمارنده‌ها، cache، pub/sub | Valkey                                                                      | [ADR-003](adr/0003-valkey.md)                 |
| Reverse proxy              | Traefik v3                                                                  | [ADR-004](adr/0004-traefik-reverse-proxy.md)  |
| صف رویدادها                | BullMQ روی Valkey                                                           | [ADR-005](adr/0005-bullmq-event-queue.md)     |
| داشبورد                    | React + Vite + TypeScript، TanStack Router/Query، shadcn/ui، Tailwind (RTL) | ندارد                                         |
| Schemaها                   | Zod در `@dirouter/contracts`، با خروجی JSON Schema                          | ندارد                                         |
| Monorepo                   | pnpm workspaces + Turborepo، TypeScript سخت‌گیرانه، ESM                     | ندارد                                         |
| استقرار                    | Docker و Docker Compose (توسعه، تولید، HA)                                  | ندارد                                         |

## 8. بسته‌های مشترک

| بسته                      | محتوا                                                                                                              | مصرف‌کنندگان                            |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------- |
| `@dirouter/contracts`     | schemaهای OpenAI/Anthropic، مدل canonical، ConfigSnapshot، UsageEvent، قالب‌ها و طبقه‌بندی خطاها                   | همه برنامه‌ها، در صورت نیاز             |
| `@dirouter/shared`        | Pino با redaction، خطاها، اعتبارسنجی متغیرهای محیطی، AES-256-GCM نسخه‌دار، ULID، HMAC، کمک‌تابع‌های پولی نقطه‌ثابت | برنامه‌های Node                         |
| `@dirouter/db`            | schema و client مربوط به Prisma                                                                                    | control-api، worker                     |
| `@dirouter/model-catalog` | قیمت‌ها و قابلیت‌های مدل‌ها                                                                                        | control-api، gateway از طریق snapshotها |
| `@dirouter/ui`            | کامپوننت‌های React                                                                                                 | dashboard                               |

gateway نباید به `@dirouter/db` وابسته باشد؛ این قاعده ADR-006 را در سطح کد اجرا می‌کند.
