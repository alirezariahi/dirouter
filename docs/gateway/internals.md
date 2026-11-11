[English](#english) · [فارسی](#persian)

<a id="english"></a>

# Gateway internal structure and request lifecycle

Code: `apps/gateway/src` · card 4.1

## Components

| file              | role                                                                                                 |
| ----------------- | ---------------------------------------------------------------------------------------------------- |
| `main.ts`         | env, creation of `UsageSink` and the gateway, listen, and drain on SIGTERM                           |
| `server.ts`       | Fastify instance, route registration, request id, `/healthz`, `/readyz` and `/internal/health`       |
| `config-store.ts` | in-memory snapshot: load from disk, poll with ETag from control-api, atomic swap (card 4.2)          |
| `auth.ts`         | virtual key authentication ([auth.md](auth.md))                                                      |
| `proxy.ts`        | hot path: canonical, resolve, retry and fallback, translation of the response or stream, usage event |
| `upstream.ts`     | separate undici dispatcher for each provider (keep-alive, proxy), multi-layer timeouts               |
| `usage-sink.ts`   | BullMQ queue with a local outbox ([usage-pipeline.md](../usage-pipeline.md))                         |

## Life of a request

```
Traefik ──▶ Fastify onRequest: x-request-id (from Traefik, or a fresh ULID), x-dirouter-instance
        ──▶ handleProxy(api)
              1. auth: HMAC + Map + timingSafeEqual, expiry, IP          → 401/403
              2. body validation with zod and conversion to canonical    → 400
              3. router.resolve: alias/combo → candidates
                 (context window filter, breaker, cooldown, allowed model) → 404/403/503
              3b. key bulkhead (rateLimit.maxConcurrency)                → 429
              4. executeWithFallback: for each candidate
                   provider bulkhead (maxConcurrency) — full: next candidate
                   adapter.buildRequest → callUpstream (connect/TTFT/idle/total)
                   error → classify → retry with backoff, or next candidate
              5. response: translated JSON, or stream (headers sent only with the first upstream event)
              6. emitUsage (synchronous, no I/O)
```

- **No heavy pipeline**: the `/v1/*` routes are direct Fastify handlers, with no global interceptors or pipes. Validation is done once, with zod. Fastify's internal logging is off, and the pino log is only at info level and contains no message content.
- **request id**: the incoming `X-Request-Id` is used if it is valid (`[\w.-]{1,128}`); otherwise `req_<ULID>`. It appears in the response, the log and the usage event.
- **Safe stream**: no byte goes to the client until the first upstream event arrives, so fallback is still possible. After the first byte, an error is sent as a standard SSE error event (card 5.7; details below).
- **Client disconnect**: the request's `AbortSignal` reaches `callUpstream` and closes the upstream connection. A test shows this takes under a second (`upstream.test.ts`).

## HTTP settings

| setting                        | value                                             | reason                                                                                                                                                                                                                           |
| ------------------------------ | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bodyLimit`                    | 20MB                                              | base64 images in messages                                                                                                                                                                                                        |
| `requestTimeout`               | 0                                                 | ten-minute stream; timeouts are controlled in the upstream layer                                                                                                                                                                 |
| `keepAliveTimeout`             | 95s                                               | must be greater than `idleConnTimeout` (90s) in the serversTransport named `long-stream` in Traefik. If the gateway closes an idle connection earlier, Traefik may send a request on a connection that is closing and get a 502. |
| `trustProxy`                   | true                                              | the real IP from X-Forwarded-For, which Traefik rewrites                                                                                                                                                                         |
| undici Agent for each provider | keep-alive, `connections: 256`, `connect.timeout` | warm, separate connections; a slow provider does not starve the others                                                                                                                                                           |

## Readiness and drain

- `/healthz`: only the liveness of the process.
- `/readyz`: 200 only when the snapshot is loaded and we are not draining. Before that it returns 503 with `no_config`, so Traefik sends no traffic.
- **SIGTERM**: first `readyz=503`, so Traefik (healthcheck every 2 seconds) removes the replica; then a pause (maximum 5 seconds), then `app.close()`, which finishes in-flight requests; and finally `usageSink.close()`.

## Why NestJS is not in the hot path

ADR-001 proposed "NestJS with FastifyAdapter and direct handlers for `/v1/*`". The current gateway is plain Fastify, because:

- The hot path deliberately did not use DI, interceptors or pipes, so the Nest shell only added boot time and extra dependencies.
- The gateway has no management API. All management endpoints are in control-api, which is NestJS.

If a module shared with control-api becomes necessary, the same Fastify instance can be passed to `new FastifyAdapter(app)` without changing any routes.

## Overhead

`scripts/bench/overhead.mjs` runs the mock provider and the gateway from `dist` with `NODE_ENV=production`, and hits both paths sequentially with keep-alive (300 warmup requests are not counted):

```bash
pnpm build && node scripts/bench/overhead.mjs 5000
```

| run (2026-11-07, Apple Silicon) | direct p50 | via gateway p50 | overhead p50 | overhead p95 |
| ------------------------------- | ---------- | --------------- | ------------ | ------------ |
| 3000 requests                   | 3.816ms    | 4.010ms         | **0.19ms**   | 0.27ms       |
| 5000 requests                   | 3.688ms    | 4.175ms         | **0.49ms**   | 0.47ms       |

Both runs are under the 3 ms threshold. At p99 the difference came out negative, which is scheduling noise. The overhead includes auth, zod validation, translation to canonical and back, resolution, one extra HTTP hop, and the usage event.

## Safe stream fallback and bulkhead (card 5.7)

### Stream

- **Before the first byte**: the 200 header and the first data are sent only when the first meaningful upstream event has arrived. If an HTTP error, connection drop, timeout or error event arrives before that, the attempt is not "committed", and the executor retries or falls back as it does in non-stream mode.
- **After the first byte**: no other attempt is allowed (`reason: committed`), because the client has already received part of the response, and combining two broken responses would be harmful. The gateway sends a standard error event in the client's format and closes the stream:
  - OpenAI:
    ```
    data: {"error":{"message":"upstream stream interrupted","type":"api_error","param":null,"code":"connection"}}
    ```
    The official openai SDK converts this to an `APIError`. `[DONE]` is not sent.
  - Anthropic:
    ```
    event: error
    data: {"type":"error","error":{"type":"api_error","message":"upstream stream interrupted"}}
    ```
    The type is always one of the standard Anthropic types: `api_error`, `overloaded_error`, `rate_limit_error` or `timeout_error` (`anthropicErrorType`). The official SDK converts it into an error.
- The stream error message is generic and does not reveal the internal address of the upstream or the proxy. The exact class is recorded in the logs and the usage event.

### Bulkhead

A local semaphore on each node, with a short queue (`packages/routing/src/bulkhead.ts`):

| level       | setting                                                          | when full                                                                                                                                                              |
| ----------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| provider    | `providers.max_concurrency` (`maxConcurrency` in the API)        | the candidate is skipped without contacting upstream, and the next combo candidate is tried; if no candidate remains, 429 with `rate_limit_error` and `Retry-After: 1` |
| virtual key | `virtual_keys.max_concurrency` (`maxConcurrency` in the key API) | immediate 429 with `rate_limit_error` (code `rate_limited`) and `Retry-After: 1`                                                                                       |

- **Queue**: the default is 16 waiting and 2 seconds, configurable with `settings.bulkhead.queueSize` and `settings.bulkhead.queueTimeoutMs`. A full queue means immediate rejection. A waiter whose client disconnects is removed from the queue.
- **No effect on health**: a rejection in the bulkhead is a "skipped" entry in attempts. It does not open the breaker, does not put the credential into cooldown, and does not require the combo's `fallbackOn`.
- **Release**: the provider slot is freed after the attempt fully ends (for a stream, after the last byte), and the key slot is freed after the whole request ends, including when the client disconnects.
- **undici connection cap**: each provider's pool also has `connections = maxConcurrency` (default 256). The bulkhead rejects before that, so requests do not wait in undici's unbounded queue.
- **Counting is local**: with N replicas, the real cap is N × maxConcurrency. The global cap (rpm/tpm) is the job of the distributed rate limiter in card 6.1.
- The current status in `GET /internal/health` (with INTERNAL_TOKEN), under `bulkheads`: `[{name:"provider:<id>", active, queued, limit}]`.

### Verification (2026-11-08)

- `apps/gateway/src/stream-safety.test.ts` (9 tests):
  - stream fallback before the first byte; a stream cut in the middle with a parsable error event in both formats and no fallback (the mock received only one request); the openai and anthropic SDKs both see the error
  - a slow provider with a cap of 2 and six simultaneous requests: two 200, four 429, and `maxInFlight` at the mock exactly 2
  - combo overflow to the next target (2 on slow and 3 on ok, all 200)
  - a key cap with 429 in the OpenAI and Anthropic formats; the slot is freed after the request ends and after a client disconnect
- `packages/routing`: Bulkhead tests (queue, timeout, abort, cap change) and admission in the executor (no effect on breaker and cooldown).
- Through Traefik, with a provider created from control-api (`maxConcurrency: 2`, mock with `ttft=1500`): six simultaneous requests gave:
  - two 200 in 1.5 seconds
  - two 200 in 3 seconds, which came from the queue
  - two 429 after the queue timeout (2 seconds)

  mock: `maxInFlight = 2`, 4 requests arrived. With a key of `maxConcurrency: 1` and three requests: two 200 (one from the queue) and one 429 with `Too many concurrent requests for this key (limit 1)`. A stream cut in the middle gave a standard error event in both APIs.

---

<a id="persian"></a>

# ساختار داخلی گیت‌وی و چرخهٔ درخواست

کد: `apps/gateway/src` · کارت ۴.۱

## اجزا

| فایل              | نقش                                                                                     |
| ----------------- | --------------------------------------------------------------------------------------- |
| `main.ts`         | env، ساخت `UsageSink` و گیت‌وی، listen و drain با SIGTERM                               |
| `server.ts`       | نمونهٔ Fastify، ثبت مسیرها، request id، `/healthz`، `/readyz` و `/internal/health`      |
| `config-store.ts` | snapshot در حافظه: بارگذاری از دیسک، poll با ETag از control-api، swap اتمیک (کارت ۴.۲) |
| `auth.ts`         | احراز هویت کلید مجازی ([auth.md](auth.md))                                              |
| `proxy.ts`        | مسیر داغ: canonical، resolve، retry و فال‌بک، ترجمهٔ پاسخ یا stream، رویداد مصرف        |
| `upstream.ts`     | undici dispatcher جدا برای هر provider (keep-alive، proxy)، timeoutهای چندلایه          |
| `usage-sink.ts`   | صف BullMQ با outbox محلی ([usage-pipeline.md](../usage-pipeline.md))                    |

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
