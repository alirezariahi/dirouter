[English](vertex.md) · [فارسی](vertex.fa.md)

<div dir="rtl">

# Google Vertex AI (کارت ۱۱.۳)

| فیلد               | مقدار                                                                                                                                            |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| type               | `vertex`                                                                                                                                         |
| baseUrl            | `https://{location}-aiplatform.googleapis.com` (یا endpoint سفارشی)                                                                              |
| options.project    | **الزامی**                                                                                                                                       |
| options.location   | پیش‌فرض `us-central1`                                                                                                                            |
| options.authMode   | `apiKey` برای ارسال `x-goog-api-key`؛ `serviceAccount` (یا secret از نوع JSON سرویس‌اکانت) کلید را با توکن مبادله می‌کند؛ در غیر این صورت Bearer |
| options.tokenUrl   | endpoint توکن در جریان سرویس‌اکانت؛ پیش‌فرض `token_uri` داخل کلید و سپس `https://oauth2.googleapis.com/token`                                    |
| options.apiVersion | پیش‌فرض `v1beta1` (Vertex فقط `v1` و `v1beta1` دارد؛ `v1beta` مربوط به Gemini API است و اینجا وجود ندارد)                                        |
| چت                 | `POST /v1beta1/projects/{project}/locations/{location}/publishers/google/models/{model}:generateContent`                                         |
| stream             | همان مسیر با `:streamGenerateContent?alt=sse`                                                                                                    |
| امبدینگ            | همان مسیر با `:predict`                                                                                                                          |

## احراز هویت

- حالت پیش‌فرض: `Authorization: Bearer <token>` — مناسب access token سرویس‌اکانت یا `gcloud auth print-access-token`.
- `options.authMode: "apiKey"`: هدر `x-goog-api-key` (برای endpointهایی که API key را می‌پذیرند).
- **سرویس‌اکانت (کارت ۲۷.۴):** فایل JSON کلید سرویس‌اکانت را کامل به‌عنوان secret در credential بگذارید. مثل بقیهٔ secretها با `MASTER_KEY` رمز می‌شود و فقط در حافظهٔ گیت‌وی باز می‌شود. گیت‌وی یک JWT با الگوریتم RS256 امضا می‌کند (`iss` = `client_email`، `scope` = `https://www.googleapis.com/auth/cloud-platform`، `aud` = آدرس توکن، عمر یک ساعت)، آن را با grant نوع JWT-bearer مبادله می‌کند، access token را برای هر credential کش می‌کند و پیش از انقضا تمدید می‌کند (۵ دقیقه پیش از انقضا، یا در نیمهٔ عمر برای توکن‌های کوتاه‌عمر). درخواست‌های هم‌زمان یک تمدید مشترک دارند. secret از نوع JSON با `"type": "service_account"` خودکار تشخیص داده می‌شود؛ `options.authMode: "serviceAccount"` آن را صریح می‌کند و هر secret دیگری را رد می‌کند. `options.scope` اسکوپ را عوض می‌کند.
- **خطای توکن:** اگر تمدید شکست بخورد ولی توکن کش‌شده هنوز معتبر باشد، همان توکن استفاده می‌شود و تمدید ۱۰ ثانیه بعد دوباره امتحان می‌شود. اگر توکن معتبری نباشد تلاش با کلاس `auth` شکست می‌خورد و **فقط همان credential** به cooldown می‌رود (با backoff نمایی)؛ circuit breaker خود provider دست نمی‌خورد و credentialهای دیگر همان provider کار می‌کنند. تست اتصال خطای endpoint توکن را گزارش می‌کند.
- فراخوانی توکن از همان proxy خروجی، timeoutها و محافظ SSRF فراخوانی مدل عبور می‌کند.
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
