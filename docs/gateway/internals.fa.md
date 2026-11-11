[English](internals.fa.md) · [فارسی](internals.fa.md)

<div dir="rtl">

# ساختار داخلی گیت‌وی و چرخهٔ درخواست

کد: `apps/gateway/src` · کارت ۴.۱

## اجزا

| فایل              | نقش                                                                                     |
| ----------------- | --------------------------------------------------------------------------------------- |
| `main.ts`         | env، ساخت `UsageSink` و گیت‌وی، listen و drain با SIGTERM                               |
| `server.ts`       | نمونهٔ Fastify، ثبت مسیرها، request id، `/healthz`، `/readyz` و `/internal/health`      |
| `config-store.ts` | snapshot در حافظه: بارگذاری از دیسک، poll با ETag از control-api، swap اتمیک (کارت ۴.۲) |
| `auth.ts`         | احراز هویت کلید مجازی ([auth.md](auth.fa.md))                                           |
| `proxy.ts`        | مسیر داغ: canonical، resolve، retry و فال‌بک، ترجمهٔ پاسخ یا stream، رویداد مصرف        |
| `upstream.ts`     | undici dispatcher جدا برای هر provider (keep-alive، proxy)، timeoutهای چندلایه          |
| `usage-sink.ts`   | صف BullMQ با outbox محلی ([usage-pipeline.md](../usage-pipeline.fa.md))                 |

## چرخهٔ یک درخواست

```
Traefik ──▶ Fastify onRequest: x-request-id (از Traefik یا ULID تازه)، x-dirouter-instance
        ──▶ handleProxy(api)
              1. auth: HMAC + Map + timingSafeEqual، انقضا، IP          → 401/403
              2. اعتبارسنجی بدنه با zod و تبدیل به canonical             → 400
              3. router.resolve: alias/combo → کاندیداها
                 (فیلتر context window، breaker، cooldown، مدل مجاز)    → 404/403/503
              3b. bulkhead کلید (rateLimit.maxConcurrency)               → 429
              4. executeWithFallback: برای هر کاندیدا
                   bulkhead provider (maxConcurrency) — پر: کاندیدای بعدی
                   adapter.buildRequest → callUpstream (connect/TTFT/idle/total)
                   خطا → classify → retry با backoff یا کاندیدای بعدی
              5. پاسخ: json ترجمه‌شده، یا stream (هدر فقط با اولین رویداد upstream)
              6. emitUsage (همگام، بدون I/O)
```

- **بدون pipeline سنگین**: مسیرهای `/v1/*` handler مستقیم Fastify هستند، بدون interceptor یا pipe سراسری. اعتبارسنجی فقط یک بار و با zod انجام می‌شود. لاگ داخلی Fastify خاموش است و لاگ pino فقط در سطح info و بدون محتوای پیام‌هاست.
- **request id**: مقدار `X-Request-Id` ورودی در صورت معتبر بودن (`[\w.-]{1,128}`) استفاده می‌شود؛ وگرنه `req_<ULID>`. در پاسخ، لاگ و رویداد مصرف می‌آید.
- **stream امن**: تا وقتی اولین رویداد upstream نرسیده هیچ بایتی به کلاینت نمی‌رود، پس فال‌بک ممکن است. بعد از اولین بایت، خطا به‌صورت رویداد خطای استاندارد SSE فرستاده می‌شود (کارت ۵.۷؛ جزئیات پایین‌تر).
- **قطع کلاینت**: `AbortSignal` درخواست به `callUpstream` می‌رسد و اتصال upstream را می‌بندد. تست نشان می‌دهد این کار زیر یک ثانیه انجام می‌شود (`upstream.test.ts`).

## تنظیمات HTTP

| تنظیم                         | مقدار                                             | دلیل                                                                                                                                                                                                         |
| ----------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `bodyLimit`                   | 20MB                                              | تصویر base64 در پیام‌ها                                                                                                                                                                                      |
| `requestTimeout`              | 0                                                 | stream ده‌دقیقه‌ای؛ timeoutها در لایهٔ upstream کنترل می‌شوند                                                                                                                                                |
| `keepAliveTimeout`            | 95s                                               | باید از `idleConnTimeout` (۹۰s) در serversTransport به نام `long-stream` در Traefik بیشتر باشد. اگر گیت‌وی زودتر اتصال idle را ببندد، Traefik ممکن است روی اتصال در حال بسته شدن درخواست بفرستد و 502 بگیرد. |
| `trustProxy`                  | true                                              | IP واقعی از X-Forwarded-For که Traefik بازنویسی می‌کند                                                                                                                                                       |
| undici Agent برای هر provider | keep-alive، `connections: 256`، `connect.timeout` | اتصال‌های گرم و جدا؛ provider کند بقیه را گرسنه نمی‌گذارد                                                                                                                                                    |

## readiness و drain

- `/healthz`: فقط زنده بودن پروسه.
- `/readyz`: 200 فقط وقتی snapshot بارگذاری شده و در حال drain نیستیم. پیش از آن 503 با `no_config` می‌دهد، پس Traefik ترافیک نمی‌فرستد.
- **SIGTERM**: اول `readyz=503` تا Traefik (healthcheck هر ۲ ثانیه) replica را خارج کند، بعد مکث (حداکثر ۵ ثانیه) و `app.close()` که درخواست‌های در جریان را تمام می‌کند، و در آخر `usageSink.close()`.

## چرا NestJS در مسیر داغ نیست

ADR-001 «NestJS با FastifyAdapter و handler مستقیم برای `/v1/*`» را پیشنهاد کرده بود. گیت‌وی فعلی مستقیماً Fastify است، چون:

- مسیر داغ عمداً از DI، interceptor و pipe استفاده نمی‌کرد، پس پوستهٔ Nest فقط زمان بوت و وابستگی اضافه می‌کرد.
- گیت‌وی API مدیریتی ندارد. همهٔ endpointهای مدیریتی در control-api هستند که NestJS است.

اگر ماژول مشترکی با control-api لازم شد، می‌توان همین نمونهٔ Fastify را به `new FastifyAdapter(app)` داد بدون اینکه مسیرها تغییر کنند.

## overhead

`scripts/bench/overhead.mjs` mock-provider و گیت‌وی را از `dist` با `NODE_ENV=production` اجرا می‌کند و هر دو مسیر را ترتیبی و با keep-alive می‌زند (۳۰۰ درخواست warmup حساب نمی‌شود):

```bash
pnpm build && node scripts/bench/overhead.mjs 5000
```

| اجرا (۲۰۲۶-۱۱-۰۷، Apple Silicon) | مستقیم p50 | از گیت‌وی p50 | overhead p50 | overhead p95 |
| -------------------------------- | ---------- | ------------- | ------------ | ------------ |
| ۳۰۰۰ درخواست                     | 3.816ms    | 4.010ms       | **0.19ms**   | 0.27ms       |
| ۵۰۰۰ درخواست                     | 3.688ms    | 4.175ms       | **0.49ms**   | 0.47ms       |

هر دو اجرا زیر سقف ۳ms هستند. در p99 اختلاف منفی شد که از نویز زمان‌بندی است. overhead شامل auth، اعتبارسنجی zod، ترجمه به canonical و برگشت، resolve، یک hop اضافهٔ HTTP و رویداد مصرف است.

## فال‌بک امن در stream و bulkhead (کارت ۵.۷)

### stream

- **قبل از اولین بایت**: هدر 200 و اولین داده فقط وقتی فرستاده می‌شوند که اولین رویداد معنادار upstream رسیده باشد. اگر قبل از آن خطای HTTP، قطع اتصال، timeout یا رویداد error بیاید، تلاش «committed» نیست و executor مثل حالت غیر stream retry یا فال‌بک می‌کند.
- **بعد از اولین بایت**: هیچ تلاش دیگری مجاز نیست (`reason: committed`)، چون کلاینت بخشی از پاسخ را گرفته و ترکیب دو پاسخ خراب‌کننده است. گیت‌وی یک رویداد خطای استاندارد در فرمت کلاینت می‌فرستد و stream را می‌بندد:
  - OpenAI:
    ```
    data: {"error":{"message":"upstream stream interrupted","type":"api_error","param":null,"code":"connection"}}
    ```
    SDK رسمی openai آن را به `APIError` تبدیل می‌کند. `[DONE]` فرستاده نمی‌شود.
  - Anthropic:
    ```
    event: error
    data: {"type":"error","error":{"type":"api_error","message":"upstream stream interrupted"}}
    ```
    نوع همیشه یکی از نوع‌های استاندارد Anthropic است: `api_error`، `overloaded_error`، `rate_limit_error` یا `timeout_error` (`anthropicErrorType`). SDK رسمی آن را به خطا تبدیل می‌کند.
- پیام خطای stream عمومی است و آدرس داخلی upstream یا پروکسی را لو نمی‌دهد. کلاس دقیق در لاگ و رویداد مصرف ثبت می‌شود.

### bulkhead

semaphore محلی هر node با صف کوتاه (`packages/routing/src/bulkhead.ts`):

| سطح        | تنظیم                                                         | پر بودن                                                                                                                                         |
| ---------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| provider   | `providers.max_concurrency` (`maxConcurrency` در API)         | کاندیدا بدون تماس با upstream کنار می‌رود و کاندیدای بعدی combo امتحان می‌شود؛ اگر کاندیدایی نماند 429 با `rate_limit_error` و `Retry-After: 1` |
| کلید مجازی | `virtual_keys.max_concurrency` (`maxConcurrency` در API کلید) | 429 فوری با `rate_limit_error` (کد `rate_limited`) و `Retry-After: 1`                                                                           |

- **صف**: پیش‌فرض ۱۶ منتظر و ۲ ثانیه، قابل تنظیم با `settings.bulkhead.queueSize` و `settings.bulkhead.queueTimeoutMs`. صف پر یعنی رد فوری. منتظری که کلاینتش قطع شود از صف حذف می‌شود.
- **بدون اثر روی سلامت**: رد شدن در bulkhead یک «skipped» در attempts است. breaker را باز نمی‌کند، credential را در cooldown نمی‌برد و شرط `fallbackOn` combo را لازم ندارد.
- **آزادسازی**: جای provider بعد از پایان کامل تلاش آزاد می‌شود (برای stream یعنی بعد از آخرین بایت) و جای کلید بعد از پایان کل درخواست، از جمله وقتی کلاینت قطع شود.
- **سقف اتصال undici**: pool هر provider هم `connections = maxConcurrency` (پیش‌فرض ۲۵۶) دارد. bulkhead جلوتر از آن درخواست را رد می‌کند تا در صف بی‌انتهای undici نماند.
- **شمارش محلی است**: با N replica سقف واقعی N × maxConcurrency است. سقف سراسری (rpm/tpm) کار rate limiter توزیع‌شده در کارت ۶.۱ است.
- وضعیت فعلی در `GET /internal/health` (با INTERNAL_TOKEN) زیر `bulkheads`: `[{name:"provider:<id>", active, queued, limit}]`.

### بررسی (۲۰۲۶-۱۱-۰۸)

- `apps/gateway/src/stream-safety.test.ts` (۹ تست):
  - فال‌بک stream قبل از اولین بایت؛ قطع وسط stream با رویداد خطای قابل‌پارس در هر دو فرمت و بدون فال‌بک (mock فقط یک درخواست گرفت)؛ SDKهای openai و anthropic هر دو خطا را می‌بینند
  - provider کند با سقف ۲ و شش درخواست هم‌زمان: دو تا 200، چهار تا 429، و `maxInFlight` در mock دقیقاً ۲
  - سرریز combo به هدف بعدی (۲ روی slow و ۳ روی ok، همه 200)
  - سقف کلید با 429 در فرمت OpenAI و Anthropic؛ آزاد شدن جا بعد از پایان درخواست و بعد از قطع کلاینت
- `packages/routing`: تست‌های Bulkhead (صف، timeout، abort، تغییر سقف) و admission در executor (بدون اثر روی breaker و cooldown).
- از Traefik با provider ساخته‌شده از control-api (`maxConcurrency: 2`، mock با `ttft=1500`): شش درخواست هم‌زمان نتیجه دادند:
  - دو تا 200 در ۱٫۵ ثانیه
  - دو تا 200 در ۳ ثانیه، که از صف آمدند
  - دو تا 429 بعد از timeout صف (۲ ثانیه)

  mock: `maxInFlight = 2`، ۴ درخواست رسیده. با کلید `maxConcurrency: 1` و سه درخواست: دو تا 200 (یکی از صف) و یک 429 با `Too many concurrent requests for this key (limit 1)`. قطع وسط stream در هر دو API رویداد خطای استاندارد داد.

</div>
