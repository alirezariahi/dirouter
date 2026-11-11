[English](#english) · [فارسی](#persian)

<a id="english"></a>

# ADR-0001: Gateway with NestJS on Fastify and overhead reduction strategies

- **Status:** Accepted
- **Date:** 2026-11-07
- **Deciders:** DiRouter team

## Context

The gateway (data plane) runs on every LLM request: authentication, rate limiting, routing, format translation and streaming. Its overhead adds directly to the user's latency. [Competitor research](../research/feature-comparison.md#۷۲-چرا-go-برای-data-plane) showed that speed-focused gateways (Bifrost, Antirion, Helicone) are written in Go or Rust, and Go was proposed for the data plane.

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

---

<a id="persian"></a>

# ADR-0001: گیت‌وی با NestJS روی Fastify و راهکارهای کاهش overhead

- **وضعیت:** پذیرفته‌شده
- **تاریخ:** 2026-11-07
- **تصمیم‌گیرندگان:** تیم DiRouter

## زمینه (Context)

گیت‌وی (data plane) روی هر درخواست LLM اجرا می‌شود: احراز هویت، rate limit، مسیریابی، ترجمهٔ فرمت و stream. overhead آن مستقیم به latency کاربر اضافه می‌شود. [تحقیق رقبا](../research/feature-comparison.md#۷۲-چرا-go-برای-data-plane) نشان داد گیت‌وی‌های سرعت‌محور (Bifrost، Antirion، Helicone) با Go یا Rust نوشته شده‌اند و Go برای data plane پیشنهاد شد.

از طرف دیگر تیم TypeScript کار می‌کند، control plane با NestJS نوشته می‌شود و اسکیماها، مترجم‌ها و منطق هزینه باید بین گیت‌وی، control-api و worker مشترک باشند.

### معیارهای تصمیم (Decision Drivers)

- overhead p99 کمتر از ۵ms روی مسیر داغ (SLO اسپرینت ۱)
- سرعت تحویل MVP در دو هفته با یک تیم TypeScript
- اشتراک کد (contracts، مترجم‌ها، محاسبهٔ هزینه) بدون تولید کد بین زبان‌ها
- امکان جایگزینی بعدی data plane بدون شکستن کلاینت‌ها

### گزینه‌های بررسی‌شده (Considered Options)

1. **Go** برای گیت‌وی، NestJS برای control plane
2. **Node + Fastify خالص** (بدون Nest) برای گیت‌وی
3. **NestJS روی Fastify adapter** برای همه، با مسیر داغ سبک
4. **NestJS روی Express** برای همه

## تصمیم (Decision)

گزینهٔ ۳: **NestJS روی Fastify adapter**، با این قواعد برای مسیر داغ:

- **بدون DI در هر درخواست:** هیچ provider با scope `REQUEST` یا `TRANSIENT`؛ همهٔ سرویس‌ها singleton و در بوت ساخته می‌شوند.
- **بدون pipe، interceptor و guard عمومی** روی routeهای `/v1/*`. احراز هویت، limit و مسیریابی به‌صورت یک تابع سادهٔ async در handler اجرا می‌شوند. ابزارهای Nest فقط روی routeهای مدیریتی و health.
- **اعتبارسنجی یک‌باره** با اسکیمای zod (بدون class-validator و class-transformer).
- **stream مستقیم** با `reply.raw` و بدون buffer؛ ترجمهٔ SSE به‌صورت incremental.
- **کلاینت HTTP خروجی** با `undici` و connection pool جدا برای هر provider (keep-alive، HTTP/1.1 و در صورت امکان HTTP/2).
- **بدون I/O همگام** با دیتابیس در مسیر داغ؛ فقط snapshot حافظه و Valkey (ADR-006).
- **لاگ غیرهمگام** با pino (بدون `console`) و redact.
- **بنچمارک در CI** (k6 با mock-provider) تا regression در overhead دیده شود.
- **رابط ثابت:** API عمومی گیت‌وی همان OpenAI/Anthropic است و قرارداد داخلی (ConfigSnapshot، UsageEvent) JSON Schema دارد؛ پس اگر بنچمارک‌ها SLO را رد کنند، گیت‌وی بدون تغییر بقیهٔ سیستم با Go بازنویسی می‌شود.

## پیامدها (Consequences)

### مثبت

- یک زبان و یک مجموعه ابزار در کل مخزن؛ تحویل سریع‌تر MVP.
- مترجم‌ها، اسکیماها و محاسبهٔ هزینه یک بار نوشته و در همهٔ اپ‌ها استفاده می‌شوند.
- Fastify حدود دو برابر Express throughput دارد و overhead مسیرش کم است.
- ساختار ماژولار Nest برای routeهای مدیریتی، health و metrics گیت‌وی هم در دسترس است.

### منفی

- Node تک‌رشته‌ای است و GC در ده‌ها هزار stream هم‌زمان tail latency را بالا می‌برد؛ مقیاس افقی (چند replica) لازم است.
- قواعد «مسیر داغ سبک» باید در code review رعایت شوند؛ یک interceptor سراسری می‌تواند overhead را بالا ببرد.
- مصرف حافظه به ازای هر stream از Go بیشتر است.

### پیگیری

- کارت ۹.۴ (تست بار با k6) overhead p50/p99 گیت‌وی را در مقابل فراخوانی مستقیم mock-provider اندازه می‌گیرد.
- کارت ۲۲.۴ benchmark مقایسه‌ای با رقبا؛ اگر SLO برآورده نشد، ADR جدید برای بازنویسی data plane با Go.
