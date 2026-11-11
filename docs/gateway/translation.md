[English](#english) · [فارسی](#persian)

<a id="english"></a>

# OpenAI ⇄ Anthropic translation

> Code: `packages/translator` (card 4.4). Each input is first translated into the canonical model (`@dirouter/contracts`), and then into the destination API.

## Request

| canonical                      | OpenAI Chat                                                                           | Anthropic Messages                                                           | notes                                                                                     |
| ------------------------------ | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `system[]`                     | `system` and `developer` messages (joined with `\n\n`)                                | `system` (a string, or blocks when `cache_control` is present)               | the position of a system message in the middle of a conversation is not kept in Anthropic |
| `user` message                 | `content` as a string or parts                                                        | `content` blocks                                                             | consecutive messages with the same role are merged for Anthropic                          |
| image                          | `image_url` (URL or data URL)                                                         | `image` with a `source` of type `url` or `base64`                            | `file` (Files API) cannot be transferred                                                  |
| `tool_call`                    | `assistant.tool_calls[]` (argument as a JSON string)                                  | `tool_use` block (`input` object)                                            | invalid argument → `{}` and a drop is reported                                            |
| `tool` / `tool_result` message | `tool` message with `tool_call_id` (text only)                                        | `tool_result` block at the start of a `user` message                         | the order of results is kept; images in tool results are removed for OpenAI               |
| `reasoning`                    | `reasoning_effort` (input) / `reasoning_content` (response from compatible providers) | signed `thinking` block and `redacted_thinking`                              | thinking without a signature is not sent to Anthropic                                     |
| `tools[]`                      | `tools[].function`                                                                    | `tools[]` with `input_schema`                                                | Anthropic server tools go only to Anthropic                                               |
| `toolChoice`                   | `auto` / `none` / `required` / `{function}`                                           | `auto` / `none` / `any` / `tool`                                             |                                                                                           |
| `parallelToolCalls=false`      | `parallel_tool_calls: false`                                                          | `tool_choice.disable_parallel_tool_use`                                      |                                                                                           |
| `maxOutputTokens`              | `max_completion_tokens` (OpenAI) or `max_tokens` (compatible)                         | `max_tokens` (required; default 4096 or the model cap)                       |                                                                                           |
| `temperature`                  | 0 to 2                                                                                | 0 to 1                                                                       | above 1 for Anthropic is capped at 1                                                      |
| `topK`                         | —                                                                                     | `top_k`                                                                      |                                                                                           |
| `stop[]`                       | `stop`                                                                                | `stop_sequences`                                                             |                                                                                           |
| `seed`                         | `seed`                                                                                | —                                                                            |                                                                                           |
| `responseFormat`               | `response_format`                                                                     | —                                                                            | Anthropic has no native JSON mode                                                         |
| `reasoning.budgetTokens`       | effort: <4k=low, <16k=medium, the rest=high                                           | `thinking.budget_tokens` (minimum 1024; `max_tokens` higher than the budget) | effort→budget: minimal 1024, low 2048, medium 8192, high 16384                            |
| `user`                         | `user`                                                                                | `metadata.user_id`                                                           |                                                                                           |
| `stream`                       | `stream` + always `stream_options.include_usage`                                      | `stream`                                                                     |                                                                                           |
| `passthrough`                  | unknown input fields of OpenAI                                                        | unknown input fields of Anthropic                                            | sent only to a provider of the same family                                                |

## Response

| canonical            | OpenAI                                      | Anthropic                                     |
| -------------------- | ------------------------------------------- | --------------------------------------------- |
| `finishReason: stop` | `stop`                                      | `end_turn` (`stop_sequence` also → stop)      |
| `length`             | `length`                                    | `max_tokens`, `model_context_window_exceeded` |
| `tool_calls`         | `tool_calls` (the old `function_call` too)  | `tool_use`                                    |
| `content_filter`     | `content_filter`                            | `refusal`                                     |
| `refusal`            | `message.refusal` and `finish_reason: stop` | `refusal`                                     |
| `other`              | `stop`                                      | `end_turn` (`pause_turn` → other)             |

### usage

- canonical: `inputTokens` is the total input; `cacheReadTokens` and `cacheWriteTokens` are subsets of it; `reasoningTokens` is a subset of `outputTokens`.
- OpenAI: `prompt_tokens` = total input; `cached_tokens` = cache read.
- Anthropic: `input_tokens` **does not include** cache tokens, so `inputTokens = input + cache_creation + cache_read`, and vice versa.
- If an OpenAI-compatible response has no `usage` at all, `CanonicalResponse.usage` stays empty (it is not set to zero), and the gateway estimates it with a tokenizer. Details are in [concepts/cost.md](../concepts/cost.md).

## Dropped fields

The translator reports each field that has no equivalent through `onDrop(field, reason)`, and the gateway logs it at debug level. The list: `n>1`, `input_audio` and `file` in OpenAI, `document` and image `file` in Anthropic, `top_k` to OpenAI, `seed` and `response_format` to Anthropic, reasoning to OpenAI, thinking without a signature to Anthropic, images in tool results to OpenAI, and temperature above 1 to Anthropic.

## Tests

`pnpm --filter @dirouter/translator test` — more than 40 golden pairs in both directions, round-trip tests on real fixtures (`packages/contracts/src/__fixtures__`), and validation of the output against the destination schema. Coverage: `pnpm --filter @dirouter/translator coverage` (about 94% statements).

Stream (card 4.5): `packages/translator/src/stream.test.ts` includes 10,000 chunks without memory growth, multi-byte Persian text split across chunks, and a tool call in both directions. Closing the upstream after a client disconnect is tested in `apps/gateway/src/upstream.test.ts`: between the client's `abort` and the upstream socket closing, it takes less than 1 second. Implementation: the Fastify request's `AbortSignal` reaches `callUpstream`.

---

<a id="persian"></a>

# ترجمهٔ OpenAI ⇄ Anthropic

> کد: `packages/translator` (کارت ۴.۴). هر ورودی ابتدا به مدل canonical (`@dirouter/contracts`) و سپس به API مقصد ترجمه می‌شود.

## درخواست

| canonical                   | OpenAI Chat                                                                | Anthropic Messages                                                   | یادداشت                                                                 |
| --------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `system[]`                  | پیام‌های `system` و `developer` (به هم پیوسته با `\n\n`)                   | `system` (رشته، یا بلوک‌ها وقتی `cache_control` هست)                 | جایگاه system میانهٔ گفتگو در Anthropic حفظ نمی‌شود                     |
| پیام `user`                 | `content` رشته یا parts                                                    | `content` بلوک‌ها                                                    | پیام‌های هم‌نقش پشت‌سرهم برای Anthropic ادغام می‌شوند                   |
| تصویر                       | `image_url` (URL یا data URL)                                              | `image` با `source` از نوع `url` یا `base64`                         | `file` (Files API) قابل‌انتقال نیست                                     |
| `tool_call`                 | `assistant.tool_calls[]` (آرگومان رشتهٔ JSON)                              | بلوک `tool_use` (`input` شیء)                                        | آرگومان نامعتبر → `{}` و گزارش drop                                     |
| پیام `tool` / `tool_result` | پیام `tool` با `tool_call_id` (فقط متن)                                    | بلوک `tool_result` در اول پیام `user`                                | ترتیب نتیجه‌ها حفظ می‌شود؛ تصویر در نتیجهٔ ابزار برای OpenAI حذف می‌شود |
| `reasoning`                 | `reasoning_effort` (ورودی) / `reasoning_content` (پاسخ providerهای سازگار) | بلوک `thinking` امضاشده و `redacted_thinking`                        | thinking بدون امضا به Anthropic فرستاده نمی‌شود                         |
| `tools[]`                   | `tools[].function`                                                         | `tools[]` با `input_schema`                                          | server toolهای Anthropic فقط به Anthropic می‌روند                       |
| `toolChoice`                | `auto` / `none` / `required` / `{function}`                                | `auto` / `none` / `any` / `tool`                                     |                                                                         |
| `parallelToolCalls=false`   | `parallel_tool_calls: false`                                               | `tool_choice.disable_parallel_tool_use`                              |                                                                         |
| `maxOutputTokens`           | `max_completion_tokens` (OpenAI) یا `max_tokens` (سازگار)                  | `max_tokens` (اجباری؛ پیش‌فرض ۴۰۹۶ یا سقف مدل)                       |                                                                         |
| `temperature`               | ۰ تا ۲                                                                     | ۰ تا ۱                                                               | بالای ۱ برای Anthropic به ۱ محدود می‌شود                                |
| `topK`                      | —                                                                          | `top_k`                                                              |                                                                         |
| `stop[]`                    | `stop`                                                                     | `stop_sequences`                                                     |                                                                         |
| `seed`                      | `seed`                                                                     | —                                                                    |                                                                         |
| `responseFormat`            | `response_format`                                                          | —                                                                    | Anthropic حالت JSON بومی ندارد                                          |
| `reasoning.budgetTokens`    | effort: <۴k=low، <۱۶k=medium، بقیه=high                                    | `thinking.budget_tokens` (حداقل ۱۰۲۴؛ `max_tokens` بالاتر از budget) | effort→budget: minimal ۱۰۲۴، low ۲۰۴۸، medium ۸۱۹۲، high ۱۶۳۸۴          |
| `user`                      | `user`                                                                     | `metadata.user_id`                                                   |                                                                         |
| `stream`                    | `stream` + همیشه `stream_options.include_usage`                            | `stream`                                                             |                                                                         |
| `passthrough`               | فیلدهای ناشناختهٔ ورودی OpenAI                                             | فیلدهای ناشناختهٔ ورودی Anthropic                                    | فقط به provider همان خانواده فرستاده می‌شود                             |

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
- اگر پاسخ OpenAI-compatible اصلاً `usage` نداشته باشد، `CanonicalResponse.usage` خالی می‌ماند (صفر گذاشته نمی‌شود) و گیت‌وی با tokenizer تخمین می‌زند. جزئیات در [concepts/cost.md](../concepts/cost.md).

## فیلدهای کنارگذاشته‌شده

مترجم هر فیلد بی‌معادل را با `onDrop(field, reason)` گزارش می‌کند و گیت‌وی آن را با سطح debug لاگ می‌کند. فهرست: `n>1`، `input_audio` و `file` در OpenAI، `document` و تصویر `file` در Anthropic، `top_k` به OpenAI، `seed` و `response_format` به Anthropic، reasoning به OpenAI، thinking بدون امضا به Anthropic، تصویر در نتیجهٔ ابزار به OpenAI، دمای بالای ۱ به Anthropic.

## تست‌ها

`pnpm --filter @dirouter/translator test` — بیش از ۴۰ جفت golden در دو جهت، round-trip روی fixtureهای واقعی (`packages/contracts/src/__fixtures__`) و اعتبارسنجی خروجی با اسکیمای مقصد. پوشش: `pnpm --filter @dirouter/translator coverage` (حدود ۹۴٪ statements).

stream (کارت ۴.۵): `packages/translator/src/stream.test.ts` شامل ۱۰٬۰۰۰ chunk بدون رشد حافظه، فارسی چندبایتی شکسته بین chunkها، و tool call در هر دو جهت. بستن upstream بعد از قطع کلاینت در `apps/gateway/src/upstream.test.ts` تست شده: بین `abort` کلاینت و بسته شدن سوکت upstream کمتر از ۱ ثانیه طول می‌کشد. پیاده‌سازی: `AbortSignal` درخواست Fastify به `callUpstream` می‌رسد.
