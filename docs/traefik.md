# Traefik

> فایل‌ها: `deploy/traefik/traefik.yml` (static، production)، `deploy/traefik/traefik.dev.yml` (static، توسعه)، `deploy/traefik/dynamic/middlewares.yml` (dynamic، Go template با env)، و labelهای داکر در `compose.yaml`.

## entrypointها

| نام         | پورت                 | کار                                                                                                            |
| ----------- | -------------------- | -------------------------------------------------------------------------------------------------------------- |
| `web`       | 80                   | production: ریدایرکت دائمی به HTTPS؛ dev: سرو مستقیم HTTP (برای curl)                                          |
| `websecure` | 443                  | TLS. production: Let's Encrypt (`certResolver: le`)؛ dev: گواهی self-signed پیش‌فرض Traefik برای `*.localhost` |
| `traefik`   | 8082 (منتشر نمی‌شود) | ping (health check کانتینر) و متریک Prometheus                                                                 |

## روترها

| دامنه                              | سرویس                             | middlewareها                                                                    |
| ---------------------------------- | --------------------------------- | ------------------------------------------------------------------------------- |
| `api.<DOMAIN>`                     | gateway                           | `security-headers`، `compress`                                                  |
| `admin.<DOMAIN>`                   | control-api                       | `security-headers`، `control-api-cors`، `control-api-ratelimit`، `compress`     |
| `app.<DOMAIN>`                     | dashboard                         | `security-headers`، `compress`                                                  |
| `traefik.<DOMAIN>`                 | داشبورد Traefik (`api@internal`)  | `dashboard-ips` (ipAllowList)، `dashboard-auth` (basicAuth)، `security-headers` |
| `mail.localhost`، `mock.localhost` | mailpit و mock-provider (فقط dev) | —                                                                               |

providerها: داکر با `exposedByDefault: false` (فقط سرویس با `traefik.enable=true`) روی شبکهٔ `dirouter_edge`، و provider فایل برای پوشهٔ `dynamic/` با `watch`.

## middlewareها

- **security-headers:** HSTS (یک سال، includeSubdomains، preload، `forceSTSHeader` تا روی HTTP dev هم دیده شود)، `X-Content-Type-Options: nosniff`، `X-Frame-Options: DENY`، `Referrer-Policy: strict-origin-when-cross-origin`، حذف `Server` و `X-Powered-By`.
- **compress:** با `excludedContentTypes: text/event-stream`؛ فشرده‌سازی SSE یعنی بافر شدن، پس هرگز روی stream اعمال نمی‌شود.
- **control-api-cors:** فقط `app.<DOMAIN>`، با credential (کوکی refresh token).
- **control-api-ratelimit:** ۵۰ درخواست در ثانیه با burst ۱۰۰ در لبه. rate limit اصلی LLM در خود گیت‌وی است (Valkey، به ازای کلید).
- **dashboard-auth / dashboard-ips:** کاربران از `TRAEFIK_DASHBOARD_USERS` (htpasswd، جداشده با ویرگول) و IPها از `TRAEFIK_ALLOW_IPS`. اگر کاربری تعریف نشود، فقط یک کاربر نامعتبر هست و داشبورد عملاً بسته است.

## timeoutها و دلیل هر کدام

| تنظیم                                                                    | مقدار        | دلیل                                                                                            |
| ------------------------------------------------------------------------ | ------------ | ----------------------------------------------------------------------------------------------- |
| `respondingTimeouts.readTimeout`                                         | 300s         | خواندن بدنهٔ درخواست (پرامپت‌های بزرگ و تصویر)؛ مقدار پیش‌فرض ۶۰ ثانیه برای آپلود کند کم است    |
| `respondingTimeouts.writeTimeout`                                        | 0 (بی‌نهایت) | **SSE**: پاسخ stream ممکن است ده‌ها دقیقه طول بکشد؛ هر مقدار غیرصفر stream طولانی را قطع می‌کند |
| `respondingTimeouts.idleTimeout`                                         | 180s         | بستن keep-aliveهای بیکار کلاینت                                                                 |
| `serversTransports.long-stream.forwardingTimeouts.responseHeaderTimeout` | 0            | TTFT را خود گیت‌وی با timeout قابل تنظیم و فال‌بک کنترل می‌کند؛ Traefik نباید زودتر قطع کند     |
| `long-stream.dialTimeout`                                                | 5s           | اتصال به replica گیت‌وی در شبکهٔ داخلی باید سریع باشد                                           |
| `lifeCycle.graceTimeOut`                                                 | 60s (prod)   | هنگام توقف Traefik، streamهای باز فرصت تمام شدن دارند                                           |

## health check و خارج کردن replica ناسالم

سرویس gateway در Traefik health check روی `/readyz` هر ۲ ثانیه با timeout یک ثانیه دارد. گیت‌وی در این حالت‌ها 503 برمی‌گرداند: هنوز snapshot ندارد، یا در حال drain است (بعد از SIGTERM). پس replica ناسالم یا در حال خاموش شدن حداکثر در حدود ۲ تا ۳ ثانیه از چرخه خارج می‌شود. در dev چک روی `/healthz` است تا گیت‌وی بدون control-api هم route شود.

## TLS

- production: `ACME_EMAIL` در `.env`؛ challenge پیش‌فرض HTTP-01 روی پورت 80. برای wildcard، `dnsChallenge` را در `traefik.yml` فعال و متغیرهای provider DNS را به کانتینر بدهید.
- dev: `https://*.localhost` با گواهی self-signed (curl با `-k`) یا `http://*.localhost`.

## نتیجهٔ تست‌ها (۲۰۲۶-۱۱-۰۷)

| تست                                         | نتیجه                                                                                             |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| stream ده‌دقیقه‌ای Traefik → gateway → mock | ۶۰۲ ثانیه، ۶۰۰ chunk و `[DONE]`، حداکثر ۳ خط در ثانیه و فاصلهٔ ۲ ثانیه: بدون بافر و بدون قطع      |
| replica فریزشده (`docker pause`) زیر بار    | خروج از چرخه حدود ۳ ثانیه بعد؛ ۴ شکست از ۹۶۵۶ درخواست (فقط درخواست‌های در جریان روی همان replica) |
| هدرها                                       | HSTS، `nosniff`، `X-Frame-Options`، `Referrer-Policy` روی همهٔ پاسخ‌ها                            |
| production                                  | ریدایرکت 301 از HTTP به HTTPS                                                                     |

نکته: درخواستی که هم‌زمان با فریز شدن روی همان replica است تا timeout کلاینت معطل می‌ماند (Traefik برای POST retry نمی‌کند). برای خاموش شدن عادی (SIGTERM) این اتفاق نمی‌افتد چون گیت‌وی اول drain می‌کند.
