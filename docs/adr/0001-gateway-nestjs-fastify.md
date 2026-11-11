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
