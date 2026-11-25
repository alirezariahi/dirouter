[English](mock-provider.md) · [فارسی](mock-provider.fa.md)

<div dir="rtl">

# ارائه‌دهندهٔ ساختگی (Mock Provider)

کد: `apps/mock-provider` · تست: `apps/mock-provider/src/*.test.ts` و تست قراردادی `packages/providers` · کارت ۹.۱

یک provider ساختگی سازگار با OpenAI، Azure OpenAI و Anthropic (stream و non-stream، tool call) برای تست تاب‌آوری بدون هزینهٔ واقعی.

- در dev همیشه بالاست: `http://mock.localhost` و از داخل شبکه `http://mock-provider:8090`.
- در prod فقط با پروفایل `mock` اجرا می‌شود (`docker compose --profile mock`).

## مسیرها

| مسیر                                                                       | توضیح                                                                                                                 |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `POST /v1/chat/completions`                                                | OpenAI و OpenAI-compatible                                                                                            |
| `POST /openai/deployments/{deployment}/chat/completions?api-version=…`     | Azure OpenAI                                                                                                          |
| `POST /v1/messages`                                                        | Anthropic                                                                                                             |
| `POST /model/{modelId}/converse` و `/converse-stream`                      | AWS Bedrock Converse (stream با eventstream باینری؛ امضا بررسی نمی‌شود)                                               |
| `GET /v1/models`                                                           | لیست مدل‌ها                                                                                                           |
| `GET /__mock/stats`                                                        | تعداد درخواست بر اساس کلید و status، و ۲۰ بدنهٔ آخر                                                                   |
| `POST /__mock/reset`                                                       | صفر کردن آمار                                                                                                         |
| `PUT /__mock/config`                                                       | `{"directives":"…"}` سناریوی پیش‌فرض سراسری                                                                           |
| `GET /healthz`                                                             | سلامت                                                                                                                 |
| `POST /oauth2/token`                                                       | endpoint توکن JWT-bearer گوگل (کارت ۲۷.۴)                                                                             |
| `POST /{tenant}/oauth2/v2.0/token`                                         | endpoint توکن client credentials نسخهٔ ۲ در Entra ID                                                                  |
| `POST /{v1,v1beta1}/projects/…/publishers/google/models/{m}:{verb}`        | Vertex AI (با همان handler جمینای)                                                                                    |
| `GET/PUT /__mock/oauth`                                                    | توکن‌های صادرشده برای هر هویت؛ `{"ttlSeconds":n,"reset":true}`                                                        |
| `GET /catalog/prices.json`                                                 | فهرست قیمت ساختگی برای همگام‌سازی کاتالوگ (کارت ۲۷.۵)؛ تا تنظیم نشود 404                                              |
| `PUT /__mock/catalog`                                                      | بدنه = فهرست قیمت (قالب LiteLLM یا DiRouter)؛ `{}` آن را پاک می‌کند                                                   |
| `GET /v1/realtime?model=…` (WebSocket)، `/openai/v1/realtime?model=…`      | Realtime API (کارت ۳۰.۵)، نام رویدادهای GA یا beta با `OpenAI-Beta: realtime=v1`                                      |
| `POST /v1/completions`، `/openai/deployments/{d}/completions`              | completions قدیمی (کارت ۳۰.۴): فقط مدل‌های instruct/davinci/babbage، برای مدل چت 404                                  |
| `POST /v1/images/edits`، `/v1/images/variations`، `/v1/audio/translations` | ویرایش و گونه‌سازی تصویر (multipart، توکن‌های gpt-image برای هر تصویر بارگذاری‌شده ۶۵) و ترجمه به انگلیسی (کارت ۳۰.۴) |

### Realtime (کارت ۳۰.۵)

endpoint وب‌سوکت به `session.update`، `input_audio_buffer.append/commit/clear`، `conversation.item.create/delete`، `response.create` و `response.cancel` مثل OpenAI پاسخ می‌دهد و هر رویداد دیگری را با رویداد `error` رد می‌کند. مصرف قطعی است تا صورت‌حساب قابل بررسی باشد: متن ورودی یک توکن به ازای هر ۴ نویسهٔ گفتگو، صوت commit‌شده ۱۰ توکن به ازای هر ثانیه PCM16 در ۲۴ کیلوهرتز (۴۸٬۰۰۰ بایت)، و هر پاسخ `text` سناریو (یک توکن به ازای هر ۴ نویسه) به‌علاوهٔ ۲ توکن صوتی برای هر delta وقتی خروجی صوتی روشن است. handshake به `status=` احترام می‌گذارد (با همان وضعیت HTTP رد می‌شود) و `chunks=`، `chunk_delay=`، `text=` و `no_usage` پاسخ را شکل می‌دهند. `GET /__mock/stats` بخش `realtime` دارد: نشست‌های بازشده و باز، نوع رویدادهای دریافتی از کلاینت، آخرین مدل، هدر احراز و پرچم beta بالادست، و `cutMidResponse` (نشست‌هایی که سوکتشان وسط پخش پاسخ بسته شد).

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

Structured output (کارت ۲۷.۱): اگر درخواست Anthropic فیلد `output_config.format` (یا درخواست Bedrock فیلد `additionalModelRequestFields.output_config.format`) داشته باشد، متن پاسخ JSON ساخته‌شده از schema است؛ اگر ابزار `dirouter_structured_output` گیت‌وی را داشته باشد، پاسخ فراخوانی همان ابزار با ورودی ساخته‌شده از schema است. رشته‌ها `"mock"`، عددها `1` (یا `minimum`)، بولی‌ها `true` و آرایه‌ها به تعداد `minItems` عضو می‌گیرند.

prompt caching در مسیر Bedrock (کارت ۲۷.۳): prompt تا آخرین `cachePoint` پیشوند کش‌شده است؛ اولین درخواست با یک پیشوند `cacheWriteInputTokens` و درخواست‌های بعدی `cacheReadInputTokens` گزارش می‌کنند. `POST /__mock/reset` کش را خالی می‌کند.

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

## endpointهای توکن OAuth (کارت ۲۷.۴)

`POST /oauth2/token` grant نوع JWT-bearer گوگل را می‌پذیرد: assertion باید JWT با الگوریتم RS256 و claimهای `iss`، `scope`، `aud` (که به `/oauth2/token` ختم شود)، `iat` و `exp` (حداکثر یک ساعت بعد) باشد؛ امضا بررسی نمی‌شود. `POST /{tenant}/oauth2/v2.0/token` grant نوع client credentials در Entra ID را می‌پذیرد (`scope` باید به `/.default` ختم شود). هویتی (`iss` یا `client_id`) که `fail` در آن باشد پاسخ `401 invalid_client` می‌گیرد تا یک credential شکست بخورد و دیگری کار کند. توکن‌های صادرشده با `mock-oauth-` شروع می‌شوند؛ هر درخواستی که چنین توکنی را پس از انقضا (یا توکنی را که mock صادر نکرده) بفرستد `401` می‌گیرد، پس معلوم می‌شود گیت‌وی به‌موقع تمدید می‌کند یا نه. `PUT /__mock/oauth {"ttlSeconds":4}` عمر توکن‌های جدید را کوتاه می‌کند؛ `GET /__mock/oauth` شمارش `byIdentity` و `refused` را برمی‌گرداند.

</div>
