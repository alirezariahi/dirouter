[English](embeddings.md) · [فارسی](embeddings.fa.md)

<div dir="rtl">

# Endpoint امبدینگ (کارت ۱۱.۴)

گیت‌وی دو سطح ورودی امبدینگ دارد:

| ورودی                                            | پاسخ                                       |
| ------------------------------------------------ | ------------------------------------------ |
| `POST /v1/embeddings` (OpenAI)                   | `{ object: "list", data: [...], usage }`   |
| `POST /v1beta/models/{model}:embedContent`       | `{ embedding: { values }, usageMetadata }` |
| `POST /v1beta/models/{model}:batchEmbedContents` | `{ embeddings: [{ values }] }`             |

هر دو از یک pipeline استفاده می‌کنند: احراز هویت virtual key، resolve مدل، مسیریابی با fallback، timeout/retry، بودجه، health و ثبت usage.

## OpenAI

```bash
curl https://api.example.com/v1/embeddings \
  -H "authorization: Bearer $DIROUTER_KEY" \
  -H 'content-type: application/json' \
  -d '{ "model": "text-embedding-3-small", "input": ["سلام", "دنیا"], "dimensions": 512 }'
```

- `input`: رشته یا آرایهٔ رشته‌ها (حداکثر ۲٬۰۴۸).
- **آرایهٔ توکن پشتیبانی نمی‌شود** و با خطای ۴۲۲ رد می‌شود؛ متن بفرستید تا خود provider توکنیز کند.
- `dimensions` به providerهایی که از آن پشتیبانی می‌کنند پاس می‌شود (`dimensions` برای OpenAI/Jina، `output_dimension` برای Voyage/Cohere، `outputDimensionality` برای Gemini/Vertex).
- `encoding_format`: هر دو مقدار `float` (پیش‌فرض) و `base64` پشتیبانی می‌شوند. SDKهای رسمی OpenAI به‌صورت پیش‌فرض `base64` می‌خواهند و خودشان decode می‌کنند، پس بدون تغییر کار می‌کنند. درخواست به upstream همیشه با float است (همهٔ providerها base64 ندارند) و گیت‌وی پاسخ را به float32 little-endian کدگذاری می‌کند؛ همان قالبی که OpenAI استفاده می‌کند.
- هدرهای `x-dirouter-model` و `x-dirouter-provider` مدل و provider واقعیِ انتخاب‌شده را نشان می‌دهند.
- `usage.prompt_tokens` از provider می‌آید؛ اگر provider usage ندهد، با تخمین `ceil(length / 4)` پر می‌شود و `usageEstimated` در رویداد usage ثبت می‌گردد.

## Gemini

```bash
curl https://api.example.com/v1beta/models/text-embedding-004:embedContent \
  -H "x-goog-api-key: $DIROUTER_KEY" \
  -H 'content-type: application/json' \
  -d '{ "content": { "parts": [{ "text": "سلام" }] } }'
```

- برای بیش از یک متن از `:batchEmbedContents` با `requests[]` استفاده کنید.
- نام مدل همان slug مدل DiRouter است؛ `models/` هم پذیرفته می‌شود.
- `outputDimensionality` در ورودی Gemini فعلاً خوانده نمی‌شود؛ برای کنترل ابعاد از `dimensions` در `/v1/embeddings` استفاده کنید یا مدل را طوری تعریف کنید که ابعاد دلخواه را بدهد.

## آداپترها

| نوع provider        | مسیر upstream                                                                           | نکته                                                                   |
| ------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `openai`            | `POST /embeddings`                                                                      | `encoding_format: "float"`                                             |
| `openai-compatible` | `POST /embeddings`                                                                      | با preset (Mistral، Voyage، Jina و…)                                   |
| `azure-openai`      | مسیر deployment + `api-version`                                                         | مانند chat                                                             |
| `gemini`            | `:embedContent` / `:batchEmbedContents`                                                 | `x-goog-api-key`                                                       |
| `vertex`            | `projects/{project}/locations/{location}/publishers/google/models/{model}:embedContent` | `options.project` الزامی؛ `options.location` پیش‌فرض `us-central1`     |
| `cohere`            | `POST /v2/embed`                                                                        | `texts[]`، `input_type: search_document`، `embedding_types: ["float"]` |
| `mistral`           | `POST /embeddings` (OpenAI-compatible)                                                  | `dimensions` پاس می‌شود                                                |
| `voyage`            | `POST /embeddings`                                                                      | `input_type: document`، `output_dimension`                             |
| `jina`              | `POST /embeddings`                                                                      | `dimensions`                                                           |

providerهایی که آداپتر امبدینگ ندارند (مثلاً Anthropic و Bedrock) در صورت انتخاب، خطای `does not support embeddings` می‌دهند و fallback به کاندیدای بعدی انجام می‌شود.

## محدودیت‌ها و fallback

- rate limit و بودجهٔ virtual key مثل chat اعمال می‌شود.
- مدل باید در snapshot مجاز باشد؛ در غیر این صورت ۴۰۳/۴۰۴.
- خطای auth باعث غیرفعال‌شدن credential و fallback می‌شود؛ خطای 4xx غیرقابل‌retry به کاندیدای بعدی می‌رود مگر `fallbackOn` combo آن را نپذیرد.
- رویداد usage با `inboundApi: "openai.embeddings"`، `outputTokens: 0` و `costUsd` محاسبه‌شده بر اساس قیمت ورودی مدل ثبت می‌شود.

## تست‌ها

- `packages/providers/src/native.test.ts` — قرارداد Cohere/Voyage/Jina و presetها.
- `apps/gateway/src/gateway.test.ts` — `/v1/embeddings` (چند متن + ابعاد + هدرها)، کدگذاری `base64`، `:embedContent` و `:batchEmbedContents` روی mock-provider.
- `apps/gateway/src/sdk.test.ts` — SDK رسمی `openai` با `embeddings.create`، هم با انتقال پیش‌فرض (base64) و هم با `encoding_format: "float"`.
- `apps/mock-provider` — مسیرهای `/v1/embeddings`، `:embedContent` و `:batchEmbedContents` برای تست‌های یکپارچه.

```bash
pnpm --filter @dirouter/providers test
pnpm --filter @dirouter/gateway test
```

</div>
