[English](control-api.md) · [فارسی](control-api.fa.md)

<div dir="rtl">

# API مدیریتی (control-api)

پایه: `https://admin.<DOMAIN>/api/v1` · Swagger: `/api/docs` (JSON: `/api/docs/openapi.json`) · کارت‌های ۳.۳ و ۳.۱۰

- **احراز هویت**: `Authorization: Bearer <accessToken>` از `/auth/login`؛ refresh در کوکی ([auth.md](../control-api/auth.fa.md)).
- **خطاها**: `application/problem+json` با `code` پایدار (`not_found`، `forbidden`، `validation_failed` با `errors[]`، `conflict`، `login_locked` و …) و `requestId`.
- **دسترسی**: همهٔ مسیرهای سازمانی زیر `/orgs/:orgId/…` هستند با ماتریس [rbac.md](../rbac.fa.md). عضو نبودن یعنی 404.

| گروه (tag)    | مسیرها                                                                                   | سند                                            |
| ------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------- |
| auth          | `/auth/setup`، `login`، `refresh`، `logout`، `password`، `me`، `invitations/accept`      | [auth.md](../control-api/auth.fa.md)           |
| organizations | `/orgs/:orgId`، `members`، `invitations`، `teams`، `projects`                            | [rbac.md](../rbac.fa.md)                       |
| providers     | `/orgs/:orgId/providers` و credentialها، `test` و `discover`                             | [providers.md](../control-api/providers.fa.md) |
| virtual keys  | `/orgs/:orgId/keys`، `revoke` و `rotate`                                                 | [keys.md](../control-api/keys.fa.md)           |
| models        | `catalog`، `models` (و `sync-catalog`)، `aliases` و `combos`                             | [routing.md](../concepts/routing.fa.md)        |
| stats & logs  | `stats/overview`، `stats/timeseries`، `stats/top`، `logs`، `logs/:id` و `health/runtime` | پایین همین صفحه                                |

`openapi.test.ts` در CI بررسی می‌کند که سند کامل است:

- هر عملیات اسکیمای پاسخ دارد.
- هر عملیات نوشتنیِ دارای بدنه، اسکیمای درخواست دارد. همهٔ اسکیماها از همان zod اعتبارسنجی ساخته می‌شوند، پس سند و رفتار یکی‌اند.
- endpointهای `/internal/*` در سند عمومی نیستند.

## آمار و لاگ (کارت ۳.۱۰، مجوز `usage:read`)

فیلترهای مشترک:

- `from` و `to` (ISO؛ پیش‌فرض ۲۴ ساعت اخیر، و برای لاگ‌ها ۷ روز اخیر؛ حداکثر ۴۰۰ روز)
- `projectId`، `apiKeyId`
- `model` (نام درخواستی: مدل، alias یا combo)

| endpoint                                                                     | منبع                                                         | خروجی                                                                                                                                                   |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET stats/overview`                                                         | `usage_hourly`، یا `usage_daily` برای بازهٔ بیش از ۷ روز     | requests، errors، errorRate، توکن‌ها، costUsd، avgLatencyMs، avgTtftMs، `latencyP50/P95/P99Ms` (تقریبی از هیستوگرام: مرز بالای سطل)، activeKeys، models |
| `GET stats/timeseries?granularity=hour\|day`                                 | ساعتی یا روزانه                                              | نقطه‌های هر bucket                                                                                                                                      |
| `GET stats/top?by=model\|key\|project\|provider&metric=cost\|requests&limit` | تجمیعی                                                       | پرمصرف‌ها                                                                                                                                               |
| `GET logs?status&httpStatus&limit&cursor`                                    | `request_log` (همیشه با بازهٔ زمانی، تا پارتیشن‌ها هرس شوند) | جدیدترین اول، با `nextCursor`                                                                                                                           |
| `GET logs/:id`                                                               | `request_log`                                                | جزئیات و **همهٔ تلاش‌ها** (`attempts`)                                                                                                                  |
| `GET health/runtime`                                                         | گیت‌وی (`/internal/health`، همگام بین replicaها)             | breaker هر provider و مدل؛ cooldown، lockout و غیرفعالی هر credential. فقط موارد همین سازمان.                                                           |

- **cursor پایدار**: مرتب‌سازی روی `(created_at, id)` است و cursor همان جفت به‌صورت base64url. صفحهٔ بعد `WHERE (created_at, id) < cursor` است. پس ردیف‌هایی که وسط صفحه‌بندی می‌رسند یا timestamp یکسان دارند، صفحه‌ها را جابه‌جا یا تکراری نمی‌کنند.
- تست integration:
  - ۱۳۰ ردیف (۳۰ تا با timestamp یکسان) در صفحه‌های ۱۷تایی، با ورود ۵ ردیف تازه وسط کار: دقیقاً ۱۳۰ شناسهٔ یکتا، بدون تکرار یا جاافتادگی.
  - داده‌های سازمان دیگر در هیچ endpointی دیده نشدند.

</div>
