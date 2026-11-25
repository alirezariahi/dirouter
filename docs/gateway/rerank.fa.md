[English](rerank.md) · [فارسی](rerank.fa.md)

# endpoint رتبه‌بندی مجدد: Rerank (کارت ۳۰.۲)

`POST /v1/rerank` و `POST /v2/rerank` سندها را بر اساس ارتباط با یک پرسش رتبه‌بندی می‌کنند. قالب درخواست Cohere و Jina را می‌پذیرند، پس SDKهای Cohere با تنظیم base URL روی گیت‌وی کار می‌کنند (`CohereClient` مسیر `/v1/rerank` و `CohereClientV2` مسیر `/v2/rerank` را صدا می‌زند) و کلاینت‌های سبک Jina هم `/v1/rerank` را. همان کلید، مسیریابی با fallback، محدودیت نرخ، بودجه، کیف پول و حسابداری usage مثل embeddings اعمال می‌شود.

```ts
import { CohereClientV2 } from 'cohere-ai';

const cohere = new CohereClientV2({ token: DIROUTER_KEY, environment: 'https://api.example.com' });
const ranked = await cohere.rerank({
  model: 'rerank-v3.5',
  query: 'capital of Iran',
  documents: ['Paris is the capital of France', 'Tehran is the capital of Iran'],
  topN: 1,
});
```

## درخواست

| فیلد                 | مقدار                                                                                                               |
| -------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `model`              | نام مدل، alias یا combo در DiRouter با قابلیت **Rerank** (`capabilities.rerank`).                                   |
| `query`              | پرسش جستجو.                                                                                                         |
| `documents`          | تا ۱٬۰۰۰ رشته، یا شیء با `text` (Jina، Cohere v1)؛ با `rank_fields` (Cohere v1) فیلدهای نام‌برده رتبه‌بندی می‌شوند. |
| `top_n` / `top_k`    | چند نتیجه برگردد (بهترین اول)؛ `top_k` نام Voyage است.                                                              |
| `return_documents`   | متن هر سند هم برگردد. پیش‌فرض: روی `/v1/rerank` (Cohere v1، Jina) true و روی `/v2/rerank` (Cohere v2) false.        |
| `max_tokens_per_doc` | به Cohere فرستاده می‌شود.                                                                                           |

## پاسخ

یک بدنه برای همهٔ کلاینت‌ها: Cohere فیلدهای `id`، `results` و `meta` را می‌خواند و Jina فیلدهای `model`، `results` و `usage` را.

```json
{
  "id": "req_…",
  "model": "rerank-v3.5",
  "results": [
    { "index": 1, "relevance_score": 0.98, "document": { "text": "Tehran is the capital of Iran" } }
  ],
  "meta": { "api_version": { "version": "2" }, "billed_units": { "search_units": 1 } },
  "usage": { "total_tokens": 31, "prompt_tokens": 31 }
}
```

## Providerها

| نوع provider                | بالادست                  | مبنای صورت‌حساب                  |
| --------------------------- | ------------------------ | -------------------------------- |
| `cohere`                    | `POST /v2/rerank`        | واحد جستجو (`meta.billed_units`) |
| `voyage`                    | `POST /rerank` (`top_k`) | توکن (`usage.total_tokens`)      |
| `jina`، `openai-compatible` | `POST /rerank` (`top_n`) | توکن (`usage.total_tokens`)      |

`openai-compatible` برای rerankerهای خودمیزبان با `/rerank` به شکل Jina/Cohere است (vLLM، Infinity). سندها به‌صورت متن فرستاده می‌شوند؛ اگر `return_documents` خواسته شده باشد DiRouter خودش آن‌ها را به نتایج اضافه می‌کند.

## قیمت و محدودیت

- rerankerهای توکنی: توکن‌های provider با **قیمت ورودی** مدل (`inputPerMTok`).
- rerankerهای مبتنی بر جستجو (Cohere): واحدهای جستجوی provider با قیمت تازهٔ **rerank / واحد جستجو** (`perSearchUsd`). هر واحد جستجو یک پرسش روی حداکثر ۱۰۰ سند است.
- هر چه provider گزارش نکند تخمین زده می‌شود (یک‌چهارم کاراکترهای پرسش برای هر سند به‌علاوهٔ خود سندها؛ یک واحد جستجو برای هر ۱۰۰ سند) و رویداد usage این را نشان می‌دهد (`usageEstimated`).
- تخمین ورودی پیش از صدا زدن هر provider از سقف توکن در دقیقهٔ کلید و خود درخواست از سقف درخواست در دقیقه کم می‌شود؛ بودجه و کیف پول مثل embeddings اعمال می‌شوند. رویداد usage مقدار `inboundApi: "rerank"` و `media.searches` دارد.
