[English](responses.md) · [فارسی](responses.fa.md)

<div dir="rtl">

# OpenAI Responses API (کارت ۱۱.۲)

گیت‌وی `POST /v1/responses` را می‌پذیرد، به canonical ترجمه می‌کند و پاسخ را دقیقاً با شکل Responses API برمی‌گرداند. providerها لازم نیست Responses را پشتیبانی کنند: مسیر از همان آداپترهای Chat Completions / Messages / Gemini استفاده می‌کند.

## درخواست

```bash
curl https://api.example.com/v1/responses \
  -H "authorization: Bearer $DIROUTER_KEY" \
  -H 'content-type: application/json' \
  -d '{
    "model": "gpt-4.1",
    "instructions": "پاسخ کوتاه بده",
    "input": "سلام",
    "max_output_tokens": 256,
    "stream": false
  }'
```

فیلدهای پشتیبانی‌شده:

| Responses                                          | canonical                                    |
| -------------------------------------------------- | -------------------------------------------- |
| `input` رشته                                       | یک پیام `user`                               |
| `input[]` از نوع `message`                         | پیام با `role` (پیش‌فرض `user`)              |
| `input_text` / `input_image`                       | متن / تصویر URL                              |
| `function_call`                                    | `tool_call` (id از `call_id` یا `id` یا نام) |
| `function_call_output`                             | `tool_result`                                |
| `reasoning` + `summary[]`                          | `reasoning`                                  |
| `instructions` و پیام `developer`                  | `system[]`                                   |
| `tools[]` (نوع `function`)                         | `tools[]`                                    |
| `tool_choice` (رشته یا تابع مشخص)                  | `toolChoice`                                 |
| `parallel_tool_calls`                              | `parallelToolCalls`                          |
| `text.format` (`text`/`json_object`/`json_schema`) | `responseFormat`                             |
| `max_output_tokens`، `temperature`، `top_p`        | همان فیلدها                                  |
| `reasoning.effort`                                 | `reasoning.effort`                           |
| `metadata`، `user`                                 | همان فیلدها                                  |
| `stream`                                           | `stream`                                     |

قطعه‌های بدون معادل (مثلاً `input_file`) با `onDrop` گزارش و حذف می‌شوند؛ حدس زده نمی‌شوند.

## پاسخ

```json
{
  "id": "resp_cmpl_...",
  "object": "response",
  "created_at": 1760000000,
  "status": "completed",
  "model": "gpt-4.1",
  "output": [
    {
      "type": "message",
      "id": "msg_cmpl_...",
      "status": "completed",
      "role": "assistant",
      "content": [{ "type": "output_text", "text": "...", "annotations": [] }]
    }
  ],
  "output_text": "...",
  "usage": {
    "input_tokens": 12,
    "output_tokens": 5,
    "total_tokens": 17,
    "input_tokens_details": { "cached_tokens": 0 },
    "output_tokens_details": { "reasoning_tokens": 0 }
  },
  "error": null,
  "incomplete_details": null
}
```

- متن، reasoning و `function_call` هر سه در `output[]` می‌آیند.
- `status`: `completed`، `incomplete` (برای `length`/`content_filter`/`refusal`) یا `failed`.
- `usage` فقط وقتی provider usage بدهد می‌آید؛ در غیر این صورت گیت‌وی برای صورت‌حساب تخمین می‌زند.

## stream

پاسخ SSE با رویدادهای استاندارد Responses:

```
event: response.created
event: response.output_text.delta
event: response.reasoning_summary_text.delta
event: response.output_item.added
event: response.function_call_arguments.delta
event: response.completed
```

- `response.completed` خروجی کامل (شامل reasoning، message و function callها) و usage را دارد.
- خطای upstream به `response.failed` با `error.code` و `error.message` تبدیل می‌شود.
- اگر کش دقیق فعال باشد و همان درخواست قبلاً ذخیره شده باشد، پاسخ stream از کش بازپخش می‌شود.

## ادامهٔ گفتگو با `previous_response_id`

اگر `stateRedis` (Valkey) در دسترس باشد، گیت‌وی بعد از هر پاسخ موفق، پیام‌های canonical + پاسخ assistant را با کلید `resp:<response_id>` و TTL هفت‌روز ذخیره می‌کند.

- در درخواست بعدی `previous_response_id` را بفرستید؛ تاریخچه قبل از پیام‌های جدید به canonical اضافه می‌شود.
- شناسهٔ ناشناخته یا منقضی → خطای ۴۰۰ با `param: "previous_response_id"`.
- بدون Valkey، فیلد نادیده گرفته می‌شود و فقط پیام‌های همان درخواست استفاده می‌شوند.

## سازگاری

- اکثر SDKها و ابزارهایی که `openai.responses.create(...)` را صدا می‌زنند بدون تغییر کار می‌کنند؛ فقط `baseURL` را روی DiRouter بگذارید.
- برای ابزارهایی که هنوز Chat Completions می‌خواهند، `/v1/chat/completions` مسیر اصلی است؛ Responses یک ورودی اضافه است.
- محدودیت‌های مدل، rate limit و بودجهٔ virtual key عیناً اعمال می‌شوند.

## تست‌ها

- `packages/translator/src/responses.test.ts` — ورودی (متن، پیام‌ها، تصویر، tool replay، reasoning)، خروجی و توالی کامل رویدادهای stream.
- `apps/gateway/src/gateway.test.ts` — `/v1/responses` واقعی روی mock-provider، شامل `previous_response_id` معتبر و منقضی/ناموجود.

```bash
pnpm --filter @dirouter/translator test
pnpm --filter @dirouter/gateway test
```

</div>
