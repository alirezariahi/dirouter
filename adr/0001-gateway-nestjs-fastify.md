[English](#english) · [فارسی](#persian)

<a id="english"></a>

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

---

<a id="persian"></a>

# ADR-0001: Gateway با NestJS روی Fastify و مسیر پرترافیک سبک

- **Status:** Accepted
- **تاریخ:** 2026-11-07
- **تصمیم‌گیرندگان:** تیم DiRouter

## زمینه

Gateway، یعنی صفحه داده، برای هر درخواست LLM احراز هویت، محدودیت نرخ، مسیریابی، ترجمه قالب و streaming را انجام می‌دهد. سربار آن مستقیماً به تأخیر کاربر اضافه می‌شود. تحقیق اولیه رقبای داخلی پیشنهاد می‌کرد از Go استفاده شود، زیرا gatewayهای متمرکز بر سرعت مانند Bifrost، Antirion و Helicone از Go یا Rust استفاده می‌کنند.

با این حال تیم با TypeScript کار می‌کند. صفحه کنترل از NestJS استفاده می‌کند و schemaها، مترجم‌ها و محاسبات هزینه باید بین gateway، control-api و worker مشترک باشند.

### عوامل تصمیم

- تأخیر p99 سربار مسیر پرترافیک زیر ۵ میلی‌ثانیه (SLO مربوط به MVP).
- تحویل MVP در دو هفته با تیمی که TypeScript کار می‌کند.
- اشتراک قراردادها، مترجم‌ها و محاسبه هزینه بدون تولید کد بین زبان‌ها.
- امکان جایگزینی صفحه داده در آینده بدون شکستن کلاینت‌ها.

### گزینه‌های بررسی‌شده

1. **Go** برای gateway و NestJS برای صفحه کنترل.
2. **Node ساده + Fastify**، بدون NestJS، برای gateway.
3. **NestJS با adapter نوع Fastify** در کل پروژه، با مسیر پرترافیک سبک.
4. **NestJS با Express** در کل پروژه.

## تصمیم

گزینه ۳ انتخاب شد: **NestJS با adapter نوع Fastify**، با این قواعد برای مسیر پرترافیک:

- **بدون تزریق وابستگی برای هر درخواست:** هیچ provider با scope از نوع `REQUEST` یا `TRANSIENT` وجود ندارد. سرویس‌ها در زمان راه‌اندازی ساخته می‌شوند و singleton هستند.
- **بدون pipe، interceptor یا guard عمومی** روی مسیرهای `/v1/*`. احراز هویت، محدودیت‌ها و مسیریابی به‌صورت توابع async ساده داخل handler اجرا می‌شوند. قابلیت‌های Nest برای مسیرهای مدیریتی و سلامت استفاده می‌شوند.
- **اعتبارسنجی یک‌باره** با Zod، بدون class-validator یا class-transformer.
- **استریم مستقیم** از طریق `reply.raw` بدون buffer؛ ترجمه SSE به‌صورت افزایشی انجام می‌شود.
- **HTTP خروجی** با `undici` و یک connection pool جدا برای هر provider، keep-alive، HTTP/1.1 و در صورت پشتیبانی HTTP/2.
- **بدون I/O همزمان پایگاه داده** در مسیر پرترافیک؛ فقط از snapshot حافظه و Valkey استفاده می‌شود (ADR-006).
- **لاگ ناهمزمان** با Pino و redaction، بدون `console`.
- **بنچمارک در CI** با k6 و mock-provider برای شناسایی رگرسیون سربار.
- **ثبات رابط‌ها:** APIهای عمومی gateway با OpenAI/Anthropic سازگار می‌مانند و قراردادهای داخلی ConfigSnapshot/UsageEvent JSON Schema دارند. اگر بنچمارک‌ها SLO را برآورده نکنند، gateway بدون تغییر در بقیه سیستم می‌تواند به Go بازنویسی شود.

## پیامدها

### مثبت

- یک زبان و یک toolchain در کل مخزن، تحویل MVP را سریع‌تر می‌کند.
- مترجم‌ها، schemaها و محاسبات هزینه یک بار نوشته و دوباره استفاده می‌شوند.
- انتظار می‌رود Fastify توان عملیاتی بیشتر و سربار مسیریابی کمتری نسبت به Express داشته باشد؛ میزان واقعی بهره با بنچمارک پروژه سنجیده شود.
- ساختار ماژولار Nest برای مدیریت gateway، سلامت و metrics در دسترس می‌ماند.

### منفی

- Node کد JavaScript را روی یک thread اجرا می‌کند و garbage collection می‌تواند با ده‌ها هزار استریم همزمان تأخیر دنباله (tail latency) را بالا ببرد. مقیاس‌پذیری افقی لازم است.
- بازبینی کد باید قواعد مسیر پرترافیک سبک را اجرا کند؛ یک interceptor سراسری می‌تواند سربار را بالا ببرد.
- انتظار می‌رود حافظه مصرفی هر استریم بیشتر از Go باشد و باید اندازه‌گیری شود.

### پیگیری

- تست بار k6، سربار p50/p99 gateway را در برابر فراخوانی مستقیم mock-provider با k6 اندازه‌گیری می‌کند.
- بنچمارک‌های مقایسه‌ای باید gatewayهای رقیب را هم شامل شوند. اگر SLO برآورده نشود، برای بازنویسی صفحه داده با Go یک ADR جدید نوشته می‌شود.
