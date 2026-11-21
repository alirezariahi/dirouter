[English](vertex.md) · [فارسی](vertex.fa.md)

<div dir="rtl">

# Google Vertex AI (کارت ۱۱.۳)

| فیلد               | مقدار                                                                                                     |
| ------------------ | --------------------------------------------------------------------------------------------------------- |
| type               | `vertex`                                                                                                  |
| baseUrl            | `https://{location}-aiplatform.googleapis.com` (یا endpoint سفارشی)                                       |
| options.project    | **الزامی**                                                                                                |
| options.location   | پیش‌فرض `us-central1`                                                                                     |
| options.authMode   | `apiKey` برای ارسال `x-goog-api-key`؛ در غیر این صورت Bearer                                              |
| options.apiVersion | پیش‌فرض `v1beta1` (Vertex فقط `v1` و `v1beta1` دارد؛ `v1beta` مربوط به Gemini API است و اینجا وجود ندارد) |
| چت                 | `POST /v1beta1/projects/{project}/locations/{location}/publishers/google/models/{model}:generateContent`  |
| stream             | همان مسیر با `:streamGenerateContent?alt=sse`                                                             |
| امبدینگ            | همان مسیر با `:predict`                                                                                   |

## احراز هویت

- حالت پیش‌فرض: `Authorization: Bearer <token>` — مناسب access token سرویس‌اکانت یا `gcloud auth print-access-token`.
- `options.authMode: "apiKey"`: هدر `x-goog-api-key` (برای endpointهایی که API key را می‌پذیرند).
- credentialهای اضافی (`credential.headers`) روی هدرها اعمال می‌شوند؛ می‌توانید هدرهای سفارشی سرویس‌اکانت را آنجا بگذارید.

## ترجمه

Vertex از همان هستهٔ Gemini استفاده می‌کند (`VertexAdapter extends GeminiAdapter`)، بنابراین:

- درخواست/پاسخ/stream/ابزارها/thoughtSignature دقیقاً مانند [gemini](gemini.fa.md) ترجمه می‌شوند.
- تفاوت فقط در URL (project/location/publisher) و هدر احراز هویت است.
- `upstreamModel` را بدون پیشوند `models/` بگذارید؛ گیت‌وی خودش `publishers/google/models/...` را می‌سازد.

## پیکربندی نمونه

```json
{
  "type": "vertex",
  "name": "Vertex europe-west4",
  "baseUrl": "https://europe-west4-aiplatform.googleapis.com",
  "options": { "project": "my-gcp-project", "location": "europe-west4" },
  "credentials": [{ "name": "sa-token", "secret": "ya29..." }]
}
```

## محدودیت‌ها

- بدون `options.project` هر درخواست با خطای صریح رد می‌شود.
- کشف مدل از `publishers/google/models` انجام می‌شود؛ مدل‌های publisherهای دیگر فهرست نمی‌شوند.
- امبدینگ از فعل‌های `embedContent` / `batchEmbedContents` در Gemini استفاده نمی‌کند: درخواست `:predict` با بدنهٔ `{"instances":[{"content":"…"}],"parameters":{"outputDimensionality":N}}` است و پاسخ از `predictions[].embeddings.values` خوانده می‌شود (usage جمع `statistics.token_count` است).
- اندازهٔ batch امبدینگ: ۲۵۰ متن در هر درخواست در `us-central1`، ۵ متن در locationهای دیگر و ۱ متن برای مدل‌های `gemini-embedding-*`. با `options.maxEmbeddingBatch` می‌توان آن را تغییر داد.

تست‌ها: `packages/providers/src/bedrock.test.ts` (بخش Vertex) — URL منطقه‌ای، Bearer و API key، الزام project و درخواست/پاسخ امبدینگ با `:predict`.

</div>
