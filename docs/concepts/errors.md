# طبقه‌بندی خطاهای upstream

> کد: `packages/providers/src/errors.ts` (کارت ۵.۲). رفتار هر کلاس در خود کد ثابت است؛ config فقط می‌تواند فال‌بک را **محدودتر** کند (`combo.fallbackOn`)، نه بازتر.

| کلاس             | از چه پاسخی                                                            | retry روی همان هدف      | فال‌بک به هدف بعدی               | اثر روی credential                                      |
| ---------------- | ---------------------------------------------------------------------- | ----------------------- | -------------------------------- | ------------------------------------------------------- |
| `rate_limit`     | 429 (با `Retry-After`، `retry-after-ms` یا `x-ratelimit-reset-*`)      | ✅ (بعد از Retry-After) | ✅                               | cooldown تا Retry-After؛ `insufficient_quota` → غیرفعال |
| `overloaded`     | 529، `overloaded_error`، 503 با پیام overload                          | ✅                      | ✅                               | —                                                       |
| `server`         | سایر 5xx                                                               | ✅                      | ✅                               | —                                                       |
| `timeout`        | 408، timeout اتصال/TTFT/idle گیت‌وی                                    | ✅                      | ✅                               | —                                                       |
| `connection`     | خطای شبکه (ECONNREFUSED، ECONNRESET، DNS، TLS)                         | ✅                      | ✅                               | —                                                       |
| `auth`           | 401، 403                                                               | ❌                      | ✅                               | غیرفعال‌سازی credential                                 |
| `not_found`      | 404 (مدل یا deployment ناموجود)                                        | ❌                      | ✅                               | —                                                       |
| `context_length` | 413، یا 400 با «context length / prompt is too long / maximum context» | ❌                      | ✅ فقط به هدف با context بزرگ‌تر | —                                                       |
| `content_filter` | 400 با «content policy / content filter / safety»                      | ❌                      | ❌                               | —                                                       |
| `bad_request`    | سایر 4xx                                                               | ❌                      | ❌ **هرگز**                      | —                                                       |

نکات:

- `bad_request` و `content_filter` هرگز به provider دیگر فرستاده نمی‌شوند؛ درخواست نادرست در همه‌جا نادرست است و فرستادنش فقط هزینه و نشت داده می‌سازد.
- خطای stream (رویداد `error` وسط stream) با همین جدول طبقه‌بندی می‌شود؛ فال‌بک فقط تا قبل از ارسال اولین بایت به کلاینت (کارت ۵.۷).
- پیام خام provider برای لاگ نگه داشته می‌شود (`upstreamType`)؛ به کلاینت کد پایدار DiRouter برمی‌گردد (`upstream_error`، `upstream_timeout`، `upstream_overloaded`، `rate_limited`، `no_available_provider`).
