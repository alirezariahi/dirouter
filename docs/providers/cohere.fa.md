[English](cohere.md) · [فارسی](cohere.fa.md)

<div dir="rtl">

# Cohere (کارت ۱۱.۳)

| فیلد            | مقدار                             |
| --------------- | --------------------------------- |
| type            | `cohere`                          |
| baseUrl پیش‌فرض | `https://api.cohere.com`          |
| چت              | `POST /v2/chat`                   |
| امبدینگ         | `POST /v2/embed`                  |
| کشف مدل         | `GET /v1/models`                  |
| احراز هویت      | `Authorization: Bearer <api key>` |

## چت

- `messages[]` با نقش‌های `system`، `user`، `assistant` و `tool`؛ system به پیام `system` تبدیل می‌شود.
- `max_tokens`، `temperature`، `p` (top_p)، `k` (top_k)، `stop_sequences`، `stream`.
- ابزارها به شکل `tools[].function` و `tool_choice` با مقادیر `REQUIRED` / `NONE`.
- stream: رویدادهای `message-start`، `content-delta`، `tool-call-start`، `tool-call-delta`، `message-end` به canonical decode می‌شوند. در رویدادهای tool-call مقدار `delta.message.tool_calls` یک شیء تکی است (هر رویداد برای یک فراخوانی)؛ آرایهٔ تک‌عضوی هم پذیرفته می‌شود.
- finishReason: `COMPLETE`/`STOP_SEQUENCE`→`stop`، `MAX_TOKENS`→`length`، `TOOL_CALL`→`tool_calls`، `ERROR`→`error`.
- usage از `usage.tokens.input_tokens` و `output_tokens`.

## امبدینگ

- `texts[]`، `input_type: "search_document"`، `embedding_types: ["float"]`.
- `dimensions` به `output_dimension` تبدیل می‌شود.
- پاسخ: `embeddings.float[][]` و usage از `meta.billed_units.input_tokens`.
- حداکثر ۹۶ متن در هر درخواست (`maxEmbeddingBatch`)؛ آداپتر یک batch را به چند فراخوانی تقسیم نمی‌کند.

## پیکربندی نمونه

```json
{
  "type": "cohere",
  "name": "Cohere",
  "baseUrl": "https://api.cohere.com",
  "credentials": [{ "name": "production", "secret": "co-..." }]
}
```

مدل‌های چت: `command-r-plus`، `command-r`، `command-a-03-2025` و…  
مدل‌های امبدینگ: `embed-multilingual-v3.0`، `embed-english-v3.0`، `embed-v4.0`.

تست قراردادی: `packages/providers/src/native.test.ts` — ساخت درخواست v2، ابزارها، پارس پاسخ/استریم و امبدینگ.

</div>
