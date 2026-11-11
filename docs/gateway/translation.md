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
