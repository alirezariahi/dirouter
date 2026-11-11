[English](gemini.fa.md) · [فارسی](gemini.fa.md)

<div dir="rtl">

# Google Gemini (کارت ۴.۸)

- `type: gemini`، `baseUrl: https://generativelanguage.googleapis.com` (پیش‌فرض control-api)
- مسیرها: `POST /{apiVersion}/models/{model}:generateContent` و برای stream
  `:streamGenerateContent?alt=sse`. `apiVersion` پیش‌فرض `v1beta` است (`options.apiVersion`).
- احراز هویت: هدر `x-goog-api-key` (کلید هرگز در query string نمی‌رود).
- نام مدل upstream با یا بدون پیشوند `models/` پذیرفته می‌شود (`gemini-2.5-flash` یا `models/gemini-2.5-flash`).
- کشف مدل: `GET /v1beta/models?pageSize=1000`؛ فقط مدل‌هایی که `generateContent` دارند برمی‌گردند (embedding حذف می‌شود).

## ترجمهٔ درخواست (canonical → Gemini)

| canonical                                                                   | Gemini                                                                                                                                                                                |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `system`                                                                    | `systemInstruction.parts[]`                                                                                                                                                           |
| پیام `user` / `assistant`                                                   | `contents[]` با نقش `user` / `model`؛ پیام‌های هم‌نقش پشت‌سرهم ادغام می‌شوند                                                                                                          |
| متن                                                                         | `{ text }`                                                                                                                                                                            |
| تصویر base64 / URL                                                          | `inlineData` / `fileData` (mimeType از پسوند حدس زده می‌شود)                                                                                                                          |
| `tool_call`                                                                 | `functionCall { name, args }`                                                                                                                                                         |
| `tool_result`                                                               | `functionResponse { name, response }`؛ نام تابع از tool_call هم‌شناسه در تاریخچه پیدا می‌شود. خروجی JSON شیء دست‌نخورده می‌رود، متن ساده به شکل `{ result }` و خطا به شکل `{ error }` |
| `tools`                                                                     | `tools[0].functionDeclarations[]`                                                                                                                                                     |
| `toolChoice`                                                                | `toolConfig.functionCallingConfig.mode`: auto→`AUTO`، none→`NONE`، required→`ANY`، تابع مشخص→`ANY` + `allowedFunctionNames`                                                           |
| `maxOutputTokens`، `temperature`، `topP`، `topK`، `stop` (حداکثر ۵)، `seed` | `generationConfig.*`                                                                                                                                                                  |
| `response_format` json_object / json_schema                                 | `responseMimeType: application/json` (+ `responseSchema`)                                                                                                                             |
| `reasoning` (effort یا budget)                                              | `thinkingConfig { thinkingBudget, includeThoughts: true }`؛ effort: minimal=512، low=1024، medium=8192، high=24576                                                                    |

فیلدهای بدون معادل (`user`، `parallel_tool_calls: false`، reasoning قبلی، تصویر داخل tool_result) با گزارش drop در لاگ debug کنار گذاشته می‌شوند.

### اسکیمای ابزار

Gemini فقط زیرمجموعهٔ OpenAPI از JSON Schema را می‌پذیرد. گیت‌وی اسکیما را پاک‌سازی می‌کند:

- حذف کلیدهای ناشناخته مثل `$schema`، `additionalProperties`، `$ref`، `$comment`
- `type: ["string","null"]` → `type: "string", nullable: true`
- `const` → `enum` و `oneOf` → `anyOf`
- enum همیشه رشته‌ای می‌شود؛ شیء با `properties` خالی بدون properties می‌رود

### safetySettings پیش‌فرض

هر درخواست چهار دستهٔ HARASSMENT، HATE_SPEECH، SEXUALLY_EXPLICIT و DANGEROUS_CONTENT را با آستانهٔ `BLOCK_NONE` می‌فرستد تا رفتار مثل OpenAI و Anthropic باشد و گیت‌وی خودش پاسخ را مسدود نکند.

- `options.safetyThreshold`: آستانهٔ همهٔ دسته‌ها، مثلاً `BLOCK_ONLY_HIGH`
- `options.safetySettings`: فهرست کامل جایگزین (همان شکل API گوگل)

### امضای thought (Gemini 2.5 و 3)

روی `functionCall` ممکن است `thoughtSignature` بیاید که باید در نوبت بعد عیناً برگردد (Gemini 3 بدون آن 400 می‌دهد). canonical جایی برای آن ندارد، پس داخل شناسهٔ tool call جاسازی می‌شود: `call_xxx__ts__<signature>`. کلاینت‌های OpenAI و Anthropic این شناسه را دست‌نخورده برمی‌گردانند و گیت‌وی امضا را دوباره روی `functionCall` می‌گذارد.

اگر تاریخچه tool callی بدون امضا داشته باشد (مثلاً از مدل دیگری در combo آمده)، اولین functionCall هر نوبت امضای جایگزین مستند گوگل `skip_thought_signature_validator` را می‌گیرد.

## ترجمهٔ پاسخ (Gemini → canonical)

- partهای `thought: true` → reasoning؛ بقیهٔ متن‌ها پشت‌سرهم ادغام می‌شوند.
- `functionCall` → tool_call. شناسه از `functionCall.id` یا ساخته‌شده است و آرگومان‌ها رشتهٔ JSON هستند.
- finishReason:

| Gemini                                                                            | canonical                                     |
| --------------------------------------------------------------------------------- | --------------------------------------------- |
| `STOP`                                                                            | `stop`، یا `tool_calls` اگر functionCall داشت |
| `MAX_TOKENS`                                                                      | `length`                                      |
| `SAFETY`، `RECITATION`، `BLOCKLIST`، `PROHIBITED_CONTENT`، `SPII`، `IMAGE_SAFETY` | `content_filter`                              |
| `MALFORMED_FUNCTION_CALL`، `UNEXPECTED_TOOL_CALL`                                 | `error`                                       |
| بقیه                                                                              | `other`                                       |

بدون candidate و با `promptFeedback.blockReason` هم `content_filter` است.

- usageMetadata:
  - inputTokens = `promptTokenCount` + `toolUsePromptTokenCount`
  - outputTokens = `candidatesTokenCount` + `thoughtsTokenCount` (در Gemini، thoughts جزو candidates نیست)
  - cacheReadTokens = `cachedContentTokenCount` (زیرمجموعهٔ promptTokenCount)
  - reasoningTokens = `thoughtsTokenCount`
  - بدون usageMetadata، گیت‌وی با tokenizer تخمین می‌زند (کارت ۶.۲).

### stream

هر رویداد SSE یک GenerateContentResponse کامل است و فریم‌بندی گوگل `\r\n\r\n` است که SseParser پشتیبانی می‌کند. functionCall همیشه کامل در یک chunk می‌آید و به `tool_call_start` و یک `tool_call_delta` تبدیل می‌شود. usageMetadata تجمعی است و فقط آخرینش، همراه finish، یک بار گزارش می‌شود. خطای داخل stream (`{"error":{...}}`) رویداد error می‌شود.

## طبقه‌بندی خطا

بدنهٔ خطای گوگل: `{"error":{"code","message","status","details"}}`

| شرط                                              | کلاس                                                                                         |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| 429 / `RESOURCE_EXHAUSTED`                       | `rate_limit`؛ `RetryInfo.retryDelay` (مثلاً `17s`) → `retryAfterMs` اگر هدر Retry-After نبود |
| 500 / `INTERNAL`، 503 / `UNAVAILABLE`            | `server` (retry و فال‌بک)                                                                    |
| 401 / 403، یا 400 با `API_KEY_INVALID`           | `auth` (credential غیرفعال می‌شود)                                                           |
| 400 با «input token count … exceeds the maximum» | `context_length`                                                                             |
| بقیهٔ 400ها                                      | `bad_request`                                                                                |

`upstreamType` همان `status` گوگل است (مثلاً `RESOURCE_EXHAUSTED`).

## mock

mock-provider مسیرهای Gemini را دارد: `POST /v1beta/models/{model}:generateContent|streamGenerateContent` و `GET /v1beta/models`. کلید با هدر `x-goog-api-key` می‌آید و directiveهای `mock:...` (مثلاً `mock:tool`، `mock:rate_limit`، `mock:context_length`) همان‌طور کار می‌کنند. خطاها شکل گوگل دارند و tool call امضای `c2lnLW1vY2s=` دارد.

seed دو provider می‌سازد: `mock-gemini` (مدل `mock/gemini`) و `mock-gemini-tool` (مدل `mock/gemini-tool`).

## بررسی (۲۰۲۶-۱۱-۰۸)

- تست‌ها:
  - `packages/translator/src/gemini.test.ts` (۱۵ تست)
  - `packages/providers` (۶ تست Gemini روی mock)
  - `apps/gateway/src/gemini.test.ts` (۷ تست با SDKهای رسمی `openai` و `@anthropic-ai/sdk`): متن، stream و رفت‌وبرگشت کامل tool calling. بدنهٔ ارسالی به upstream هم بررسی می‌شود: systemInstruction، functionResponse با نام درست، و برگشت thoughtSignature.
- از طریق Traefik (`https://api.localhost`):
  - `/v1/chat/completions` و `/v1/messages` با `mock/gemini` و `mock/gemini-tool`، stream و غیر stream
  - tool_use و tool_calls با `finish_reason`/`stop_reason` درست
  - usage در آخرین chunk
- control-api: `POST /providers/prv_mock-gemini/test` با ok و `/discover` دو مدل generateContent را برگرداند.
- ⏳ تست با Gemini واقعی نیاز به یک کلید API گوگل دارد.

</div>
