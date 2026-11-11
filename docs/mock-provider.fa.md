[English](mock-provider.md) · [فارسی](mock-provider.fa.md)

<div dir="rtl">

# ارائه‌دهندهٔ ساختگی (Mock Provider)

کد: `apps/mock-provider` · تست: `apps/mock-provider/src/*.test.ts` و تست قراردادی `packages/providers` · کارت ۹.۱

یک provider ساختگی سازگار با OpenAI، Azure OpenAI و Anthropic (stream و non-stream، tool call) برای تست تاب‌آوری بدون هزینهٔ واقعی.

- در dev همیشه بالاست: `http://mock.localhost` و از داخل شبکه `http://mock-provider:8090`.
- در prod فقط با پروفایل `mock` اجرا می‌شود (`docker compose --profile mock`).

## مسیرها

| مسیر                                                                   | توضیح                                               |
| ---------------------------------------------------------------------- | --------------------------------------------------- |
| `POST /v1/chat/completions`                                            | OpenAI و OpenAI-compatible                          |
| `POST /openai/deployments/{deployment}/chat/completions?api-version=…` | Azure OpenAI                                        |
| `POST /v1/messages`                                                    | Anthropic                                           |
| `GET /v1/models`                                                       | لیست مدل‌ها                                         |
| `GET /__mock/stats`                                                    | تعداد درخواست بر اساس کلید و status، و ۲۰ بدنهٔ آخر |
| `POST /__mock/reset`                                                   | صفر کردن آمار                                       |
| `PUT /__mock/config`                                                   | `{"directives":"…"}` سناریوی پیش‌فرض سراسری         |
| `GET /healthz`                                                         | سلامت                                               |

## انتخاب سناریو

directiveها با `,` یا `;` جدا می‌شوند. منبع به ترتیب اولویت:

1. هدر `x-mock: <directives>`
2. کلید API به شکل `mock:<directives>`، در `Authorization: Bearer` یا `x-api-key`
3. پیش‌فرض سراسری: env `MOCK_DEFAULT` یا `PUT /__mock/config`

> گیت‌وی هدرهای کلاینت را به upstream نمی‌فرستد، پس برای تست از مسیر گیت‌وی سناریو را در **کلید credential** بگذارید (مثل `mock:status=503`). هدر `x-mock` برای تست مستقیم mock است.

| directive                                 | اثر                                                                                   |
| ----------------------------------------- | ------------------------------------------------------------------------------------- |
| `status=<code>`                           | همیشه همان status خطا (400، 401، 429، 500، 503، 529 …) با بدنهٔ خطای استاندارد هر API |
| `rate_limit`                              | 429                                                                                   |
| `overloaded`                              | 529 (Anthropic overloaded)                                                            |
| `auth`                                    | 401                                                                                   |
| `context_length`                          | 400 با پیام «maximum context length»                                                  |
| `retry_after=<s>`                         | هدر `Retry-After`                                                                     |
| `error_rate=<0..1>`                       | احتمال 503 تصادفی                                                                     |
| `latency=<min>-<max>`                     | تأخیر تصادفی (میلی‌ثانیه) قبل از پاسخ                                                 |
| `ttft=<ms>`                               | تأخیر قبل از هدر و اولین chunk                                                        |
| `chunk_delay=<ms>`                        | فاصلهٔ chunkهای stream                                                                |
| `chunks=<n>`                              | تعداد chunk متن (پیش‌فرض ۵)                                                           |
| `drop_after=<n>` (یا `stream_drop_after`) | قطع اتصال وسط stream بعد از n chunk                                                   |
| `tool[=name]`                             | پاسخ با فراخوانی ابزار (پیش‌فرض `get_weather`)                                        |
| `text=<str>`                              | متن پاسخ                                                                              |
| `no_usage`                                | بدون `usage` (برای تست تخمین توکن، کارت ۶.۲)                                          |

نمونه‌ها:

```bash
curl -s http://mock.localhost/v1/chat/completions -H 'x-mock: rate_limit,retry_after=2' \
  -H 'content-type: application/json' -d '{"model":"m","messages":[{"role":"user","content":"hi"}]}'
curl -sN http://mock.localhost/v1/chat/completions -H 'x-mock: chunks=20,chunk_delay=200,drop_after=5' \
  -H 'content-type: application/json' -d '{"model":"m","stream":true,"messages":[{"role":"user","content":"hi"}]}'
```

## providerهای dev در snapshot

`make dev-snapshot` این providerها را روی mock می‌سازد:

| مدل            | سناریو                      | کاربرد                                     |
| -------------- | --------------------------- | ------------------------------------------ |
| `mock/small`   | سالم                        | پیش‌فرض                                    |
| `mock/down`    | `status=503`                | fallback (combo `dev` / alias `gpt-4.1`)   |
| `mock/bad`     | `status=400`                | combo `dev-bad`: نباید fallback شود        |
| `mock/429`     | `rate_limit`                | combo `dev-429`: fallback به `mock/claude` |
| `mock/tool`    | `tool`                      | tool call                                  |
| `mock/nousage` | `no_usage`                  | تخمین توکن                                 |
| `mock/claude`  | سالم، type `anthropic`      | ترجمهٔ OpenAI به Anthropic                 |
| `mock/azure`   | سالم، type `azure-openai`   | مسیر deployment در Azure                   |
| `mock/long`    | ۶۰۰ chunk با فاصلهٔ ۱ ثانیه | stream ده‌دقیقه‌ای از Traefik              |

</div>
