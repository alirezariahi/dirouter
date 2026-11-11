[English](#english) · [فارسی](#persian)

<a id="english"></a>

# Traefik

> Files: `deploy/traefik/traefik.yml` (static, production), `deploy/traefik/traefik.dev.yml` (static, development), `deploy/traefik/dynamic/middlewares.yml` (dynamic, Go template with env), and the Docker labels in `compose.yaml`.

## Entrypoints

| Name        | Port                 | Purpose                                                                                                               |
| ----------- | -------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `web`       | 80                   | production: permanent redirect to HTTPS; dev: serves HTTP directly (for curl)                                         |
| `websecure` | 443                  | TLS. production: Let's Encrypt (`certResolver: le`); dev: Traefik's default self-signed certificate for `*.localhost` |
| `traefik`   | 8082 (not published) | ping (container health check) and Prometheus metrics                                                                  |

## Routers

| Domain                             | Service                              | Middlewares                                                                     |
| ---------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------- |
| `api.<DOMAIN>`                     | gateway                              | `security-headers`, `compress`                                                  |
| `admin.<DOMAIN>`                   | control-api                          | `security-headers`, `control-api-cors`, `control-api-ratelimit`, `compress`     |
| `app.<DOMAIN>`                     | dashboard                            | `security-headers`, `compress`                                                  |
| `traefik.<DOMAIN>`                 | Traefik dashboard (`api@internal`)   | `dashboard-ips` (ipAllowList), `dashboard-auth` (basicAuth), `security-headers` |
| `mail.localhost`, `mock.localhost` | mailpit and mock-provider (dev only) | —                                                                               |

Providers: Docker with `exposedByDefault: false` (only services with `traefik.enable=true`) on the `dirouter_edge` network, and the file provider for the `dynamic/` folder with `watch`.

## Middlewares

- **security-headers:** HSTS (one year, includeSubdomains, preload, and `forceSTSHeader` so that it is seen even over HTTP in dev), `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, and removal of `Server` and `X-Powered-By`.
- **compress:** with `excludedContentTypes: text/event-stream`. Compressing SSE means buffering, so it is never applied to streams.
- **control-api-cors:** only `app.<DOMAIN>`, with credentials (the refresh token cookie).
- **control-api-ratelimit:** 50 requests per second with a burst of 100 at the edge. The main LLM rate limit is in the gateway itself (Valkey, per key).
- **dashboard-auth / dashboard-ips:** users come from `TRAEFIK_DASHBOARD_USERS` (htpasswd, comma-separated) and IPs from `TRAEFIK_ALLOW_IPS`. If no user is defined, only one invalid user exists and the dashboard is effectively closed.

## Timeouts and their reasons

| Setting                                                                  | Value        | Reason                                                                                                       |
| ------------------------------------------------------------------------ | ------------ | ------------------------------------------------------------------------------------------------------------ |
| `respondingTimeouts.readTimeout`                                         | 300s         | Reading the request body (large prompts and images); the default of 60 seconds is too short for slow uploads |
| `respondingTimeouts.writeTimeout`                                        | 0 (infinite) | **SSE**: a stream response may take tens of minutes; any non-zero value cuts long streams                    |
| `respondingTimeouts.idleTimeout`                                         | 180s         | Closing idle client keep-alives                                                                              |
| `serversTransports.long-stream.forwardingTimeouts.responseHeaderTimeout` | 0            | The gateway itself controls TTFT with an adjustable timeout and fallback; Traefik must not cut earlier       |
| `long-stream.dialTimeout`                                                | 5s           | Connecting to a gateway replica on the internal network must be fast                                         |
| `lifeCycle.graceTimeOut`                                                 | 60s (prod)   | When Traefik stops, open streams have time to finish                                                         |

## Health check and removing an unhealthy replica

The gateway service has a health check in Traefik on `/readyz` every 2 seconds with a timeout of one second. The gateway returns 503 in these states: it has no snapshot yet, or it is draining (after SIGTERM). So an unhealthy replica, or one that is shutting down, leaves the rotation within about 2 to 3 seconds at most. In dev the check is on `/healthz`, so that the gateway is routed even without control-api.

## TLS

- production: `ACME_EMAIL` in `.env`; the default challenge is HTTP-01 on port 80. For a wildcard, enable `dnsChallenge` in `traefik.yml` and pass the DNS provider variables to the container.
- dev: `https://*.localhost` with a self-signed certificate (curl with `-k`), or `http://*.localhost`.

## Test results (2026-11-07)

| Test                                       | Result                                                                                                                      |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| Ten-minute stream Traefik → gateway → mock | 602 seconds, 600 chunks and `[DONE]`, at most 3 lines per second and a 2-second interval: no buffering and no cut           |
| Frozen replica (`docker pause`) under load | Left the rotation about 3 seconds later; 4 failures out of 9656 requests (only the in-flight requests on that same replica) |
| Headers                                    | HSTS, `nosniff`, `X-Frame-Options`, `Referrer-Policy` on all responses                                                      |
| production                                 | 301 redirect from HTTP to HTTPS                                                                                             |

Note: a request that is made at the same time as the freeze, on the same replica, waits until the client timeout (Traefik does not retry POST). A normal shutdown (SIGTERM) does not cause this, because the gateway drains first.

---

<a id="persian"></a>

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
