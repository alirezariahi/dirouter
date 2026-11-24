[English](translation.md) · [فارسی](translation.fa.md)

<div dir="rtl">

# ترجمهٔ OpenAI ⇄ Anthropic

> کد: `packages/translator` (کارت ۴.۴). هر ورودی ابتدا به مدل canonical (`@dirouter/contracts`) و سپس به API مقصد ترجمه می‌شود.

## درخواست

| canonical                   | OpenAI Chat                                                                | Anthropic Messages                                                   | یادداشت                                                                                |
| --------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `system[]`                  | پیام‌های `system` و `developer` (به هم پیوسته با `\n\n`)                   | `system` (رشته، یا بلوک‌ها وقتی `cache_control` هست)                 | جایگاه system میانهٔ گفتگو در Anthropic حفظ نمی‌شود                                    |
| پیام `user`                 | `content` رشته یا parts                                                    | `content` بلوک‌ها                                                    | پیام‌های هم‌نقش پشت‌سرهم برای Anthropic ادغام می‌شوند                                  |
| تصویر                       | `image_url` (URL یا data URL)                                              | `image` با `source` از نوع `url` یا `base64`                         | تصویر `file` (Files API) قابل‌انتقال نیست؛ سند و صوت: [پایین‌تر](#documents-and-audio) |
| `tool_call`                 | `assistant.tool_calls[]` (آرگومان رشتهٔ JSON)                              | بلوک `tool_use` (`input` شیء)                                        | آرگومان نامعتبر → `{}` و گزارش drop                                                    |
| پیام `tool` / `tool_result` | پیام `tool` با `tool_call_id` (فقط متن)                                    | بلوک `tool_result` در اول پیام `user`                                | ترتیب نتیجه‌ها حفظ می‌شود؛ تصویر در نتیجهٔ ابزار برای OpenAI حذف می‌شود                |
| `reasoning`                 | `reasoning_effort` (ورودی) / `reasoning_content` (پاسخ providerهای سازگار) | بلوک `thinking` امضاشده و `redacted_thinking`                        | thinking بدون امضا به Anthropic فرستاده نمی‌شود                                        |
| `tools[]`                   | `tools[].function`                                                         | `tools[]` با `input_schema`                                          | server toolهای Anthropic فقط به Anthropic می‌روند                                      |
| `toolChoice`                | `auto` / `none` / `required` / `{function}`                                | `auto` / `none` / `any` / `tool`                                     |                                                                                        |
| `parallelToolCalls=false`   | `parallel_tool_calls: false`                                               | `tool_choice.disable_parallel_tool_use`                              |                                                                                        |
| `maxOutputTokens`           | `max_completion_tokens` (OpenAI) یا `max_tokens` (سازگار)                  | `max_tokens` (اجباری؛ پیش‌فرض ۴۰۹۶ یا سقف مدل)                       |                                                                                        |
| `temperature`               | ۰ تا ۲                                                                     | ۰ تا ۱                                                               | بالای ۱ برای Anthropic به ۱ محدود می‌شود                                               |
| `topK`                      | —                                                                          | `top_k`                                                              |                                                                                        |
| `stop[]`                    | `stop`                                                                     | `stop_sequences`                                                     |                                                                                        |
| `seed`                      | `seed`                                                                     | —                                                                    |                                                                                        |
| `responseFormat`            | `response_format`                                                          | `output_config.format` یا ابزار اجباری                               | [Structured output](#structured-output) را ببینید                                      |
| `reasoning.budgetTokens`    | effort: <۴k=low، <۱۶k=medium، بقیه=high                                    | `thinking.budget_tokens` (حداقل ۱۰۲۴؛ `max_tokens` بالاتر از budget) | effort→budget: minimal ۱۰۲۴، low ۲۰۴۸، medium ۸۱۹۲، high ۱۶۳۸۴                         |
| `user`                      | `user`                                                                     | `metadata.user_id`                                                   |                                                                                        |
| `stream`                    | `stream` + همیشه `stream_options.include_usage`                            | `stream`                                                             |                                                                                        |
| `passthrough`               | فیلدهای ناشناختهٔ ورودی OpenAI                                             | فیلدهای ناشناختهٔ ورودی Anthropic                                    | فقط به provider همان خانواده فرستاده می‌شود                                            |

## پاسخ

| canonical            | OpenAI                                    | Anthropic                                     |
| -------------------- | ----------------------------------------- | --------------------------------------------- |
| `finishReason: stop` | `stop`                                    | `end_turn` (`stop_sequence` هم → stop)        |
| `length`             | `length`                                  | `max_tokens`، `model_context_window_exceeded` |
| `tool_calls`         | `tool_calls` (`function_call` قدیمی هم)   | `tool_use`                                    |
| `content_filter`     | `content_filter`                          | `refusal`                                     |
| `refusal`            | `message.refusal` و `finish_reason: stop` | `refusal`                                     |
| `other`              | `stop`                                    | `end_turn` (`pause_turn` → other)             |

### usage

- canonical: `inputTokens` کل ورودی؛ `cacheReadTokens` و `cacheWriteTokens` زیرمجموعهٔ آن؛ `reasoningTokens` زیرمجموعهٔ `outputTokens`.
- OpenAI: `prompt_tokens` = کل ورودی؛ `cached_tokens` = cache read.
- Anthropic: `input_tokens` **شامل** توکن‌های cache نیست؛ پس `inputTokens = input + cache_creation + cache_read` و برعکس.
- اگر پاسخ OpenAI-compatible اصلاً `usage` نداشته باشد، `CanonicalResponse.usage` خالی می‌ماند (صفر گذاشته نمی‌شود) و گیت‌وی با tokenizer تخمین می‌زند. جزئیات در [concepts/cost.md](../concepts/cost.fa.md).

<a id="structured-output"></a>

## Structured output

> کارت ۲۷.۱. `response_format` (و `output_config.format` کلاینت Anthropic) روی همهٔ providerها کار می‌کند.

| مقصد                                       | `json_schema`                                                                  | `json_object`                                                      |
| ------------------------------------------ | ------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| OpenAI و سازگارها                          | `response_format` بدون تغییر                                                   | `response_format` بدون تغییر                                       |
| Gemini و Vertex                            | `responseMimeType` + `responseJsonSchema`                                      | `responseMimeType: application/json`                               |
| Anthropic، مدل با پشتیبانی بومی            | `output_config.format: {type: json_schema, schema}`                            | دستور system برای پاسخ با یک شیء JSON (به‌عنوان drop گزارش می‌شود) |
| Anthropic، مدل قدیمی‌تر                    | ابزار اجباری `dirouter_structured_output` که `input_schema` آن همان schema است | همان ابزار با `{"type":"object"}`                                  |
| Bedrock (Converse)، پیش‌فرض                | ابزار اجباری `dirouter_structured_output` (`toolConfig.toolChoice.tool`)       | همان ابزار با `{"type":"object"}`                                  |
| Bedrock، مدلی که ابزار اجباری را رد می‌کند | `additionalModelRequestFields.output_config.format`                            | دستور system                                                       |

- پشتیبانی بومی از روی نام مدل upstream تعیین می‌شود: Claude Opus 4.1، 4.5، 4.8 و 5.x، Sonnet 5.x، Haiku 4.5 و 5.x، Fable و Mythos. در Bedrock ابزار اجباری پیش‌فرض است و فقط مدل‌هایی که `tool_choice` اجباری را رد می‌کنند (Opus 5.5، Sonnet 5.5، Fable و Mythos 5.1 به بعد) فیلد بومی را می‌گیرند. گزینهٔ provider به نام `structuredOutput` (`native` یا `tool`) این انتخاب را عوض می‌کند، مثلاً برای مدلی که هنوز در فهرست نیست.
- فراخوانی ابزار جایگزین دوباره به متن تبدیل می‌شود: کلاینت JSON را در `message.content` (در stream به‌صورت content delta) و `finish_reason: stop` می‌گیرد، نه tool call. فراخوانی هر ابزار دیگری `finish_reason: tool_calls` را نگه می‌دارد.
- اگر کلاینت ابزارهای خودش را هم بفرستد، ابزار جایگزین به آن‌ها اضافه می‌شود و `tool_choice` برابر `any` می‌شود (یا روی ابزاری که کلاینت نام برده می‌ماند). با extended thinking، Anthropic ابزار اجباری را رد می‌کند؛ پس ابزار در system prompt خواسته می‌شود و `tool_choice: auto` است.
- `output_config.format` کلاینت Anthropic (یا `output_format` قدیمی) به `responseFormat` در canonical تبدیل می‌شود تا به OpenAI و Gemini هم برسد؛ بقیهٔ فیلدهای `output_config` (`effort`) همچنان به Anthropic می‌رسند.
- نام ابزار `dirouter_structured_output` رزرو است.

<a id="documents-and-audio"></a>

## سند و صوت

> کارت ۲۷.۲. PDF، فایل‌های دیگر و صوت به هر providerی که بتواند بخواندشان می‌رسند؛ اگر مقصد نتواند، کلاینت خطای 400 می‌گیرد که بخش مربوط را نام می‌برد، نه پاسخی که فایل بی‌صدا از آن حذف شده باشد.

بخش‌های canonical: `document` (منبع `base64`، `url`، `text` یا `file`: شناسهٔ فایل provider همراه با مبدأ آن، به‌علاوهٔ `filename`، `title`، `context` و `citations`) و `audio` (منبع `base64` یا `url`).

| ورودی                                                                                   | canonical                                                                                       |
| --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| OpenAI Chat `file` (`file_data` به‌صورت data URL یا base64 خام + `filename`؛ `file_id`) | `document` (`base64`؛ `file` با مبدأ `openai`)                                                  |
| OpenAI Chat `input_audio` (`wav`، `mp3`)                                                | `audio` (`audio/wav`، `audio/mpeg`)                                                             |
| Responses `input_file` (`file_data`، `file_url`، `file_id`)                             | `document` (`base64`، `url`، `file`)                                                            |
| Anthropic `document` (`base64`، `url`، `text`، `content`، `file`)                       | `document`؛ منبع `content` بلوک‌های متنی‌اش را نگه می‌دارد                                      |
| Gemini `inlineData` / `fileData`                                                        | بر اساس media type: `image`، `document` (PDF، `text/*`، `application/*`) یا `audio` (`audio/*`) |

| canonical                             | OpenAI Chat                                 | Anthropic                                | Gemini / Vertex | Bedrock (Converse)                                                      |
| ------------------------------------- | ------------------------------------------- | ---------------------------------------- | --------------- | ----------------------------------------------------------------------- |
| PDF درون‌خطی                          | `file.file_data` (data URL)                 | `document` `base64`                      | `inlineData`    | `document` با `format: pdf` و `source.bytes`                            |
| سند متنی                              | بخش متنی                                    | `document` `text`                        | بخش متنی        | `document` با `format: txt`                                             |
| فایل‌های دیگر (docx، csv، …) درون‌خطی | 400                                         | 400 (`text/*` به منبع text تبدیل می‌شود) | `inlineData`    | `document` با قالب خودش (pdf، csv، doc، docx، xls، xlsx، html، txt، md) |
| سند با URL                            | 400                                         | `document` `url`                         | `fileData`      | 400 (Converse فقط S3 می‌خواند)                                          |
| شناسهٔ فایل                           | فقط شناسهٔ OpenAI                           | فقط شناسهٔ Anthropic                     | 400             | 400                                                                     |
| صوت درون‌خطی                          | `input_audio` (wav، mp3؛ قالب‌های دیگر 400) | 400                                      | `inlineData`    | 400                                                                     |
| صوت با URL                            | 400                                         | 400                                      | `fileData`      | 400                                                                     |

- نام سند در Converse فقط حرف، رقم، فاصلهٔ تکی، خط تیره، پرانتز و کروشه می‌پذیرد: عنوان یا نام فایل پاک‌سازی و شماره‌گذاری می‌شود (`report 1`).
- مسیریابی: گیت‌وی پیش از ارسال فقط مقصدهایی را نگه می‌دارد که سند و صوت درخواست را می‌پذیرند (`MEDIA_INPUT` برای هر نوع provider در `packages/providers`، و قابلیت‌های مدل `documents` و `audioInput`؛ `false` مدل را کنار می‌گذارد و مقدار خالی تصمیم را به نوع provider می‌سپارد). اگر مقصدی نماند، پاسخ 400 با نام مدل است؛ combo مقصدهایی را که ورودی را نمی‌پذیرند رد می‌کند. aliasهای `auto` فقط مدل‌هایی را انتخاب می‌کنند که قابلیتشان `true` باشد. کاتالوگ مدل‌های OpenAI، Anthropic و Gemini را علامت زده است.
- جزئیاتی که مقصد نمی‌تواند حمل کند (URL برای Bedrock، flac برای OpenAI) را مترجم با `UnsupportedContentError` رد می‌کند و پاسخ 400 (`invalid_request`) است.
- تخمین توکن برای هر KB سند حدود ۲۵۰ و برای هر KB صوت ۲ توکن حساب می‌کند.

## فیلدهای کنارگذاشته‌شده

مترجم هر فیلد بی‌معادل را با `onDrop(field, reason)` گزارش می‌کند و گیت‌وی آن را با سطح debug لاگ می‌کند. فهرست: `n>1` و بخش `file` بدون داده و شناسه در OpenAI، تصویر `file` در Anthropic، ویدیو و بخش‌های ناشناختهٔ دیگر در Gemini و Responses، `top_k` به OpenAI، `seed` به Anthropic، `json_object` به مدل Claude با structured output بومی (به‌صورت دستور فرستاده می‌شود)، reasoning به OpenAI، thinking بدون امضا به Anthropic، تصویر در نتیجهٔ ابزار به OpenAI، دمای بالای ۱ به Anthropic.

## تست‌ها

`pnpm --filter @dirouter/translator test` — بیش از ۴۰ جفت golden در دو جهت، round-trip روی fixtureهای واقعی (`packages/contracts/src/__fixtures__`) و اعتبارسنجی خروجی با اسکیمای مقصد. پوشش: `pnpm --filter @dirouter/translator coverage` (حدود ۹۴٪ statements).

stream (کارت ۴.۵): `packages/translator/src/stream.test.ts` شامل ۱۰٬۰۰۰ chunk بدون رشد حافظه، فارسی چندبایتی شکسته بین chunkها، و tool call در هر دو جهت. بستن upstream بعد از قطع کلاینت در `apps/gateway/src/upstream.test.ts` تست شده: بین `abort` کلاینت و بسته شدن سوکت upstream کمتر از ۱ ثانیه طول می‌کشد. پیاده‌سازی: `AbortSignal` درخواست Fastify به `callUpstream` می‌رسد.

## ورودی‌های Sprint 2

- [Gemini API inbound](gemini-inbound.fa.md) — `generateContent`، `streamGenerateContent`، `countTokens` و احراز هویت `x-goog-api-key`.
- [OpenAI Responses](responses.fa.md) — `/v1/responses`، `previous_response_id` و stream.
- [Embeddings](embeddings.fa.md) — `/v1/embeddings` و `:embedContent` / `:batchEmbedContents`.

</div>
