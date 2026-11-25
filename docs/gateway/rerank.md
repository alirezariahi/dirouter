# Rerank endpoint (card 30.2)

`POST /v1/rerank` and `POST /v2/rerank` rank documents by relevance to a query. They accept Cohere's and Jina's request formats, so Cohere's SDKs work by pointing their base URL at the gateway (`CohereClient` calls `/v1/rerank`, `CohereClientV2` calls `/v2/rerank`), and Jina-style clients call `/v1/rerank`. The same key, routing with fallback, rate limits, budgets, wallet and usage accounting apply as for embeddings.

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

## Request

| Field                | Value                                                                                                                       |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `model`              | A DiRouter model name, alias or combo with the **Rerank** capability (`capabilities.rerank`).                               |
| `query`              | The search query.                                                                                                           |
| `documents`          | Up to 1,000 strings, or objects with `text` (Jina, Cohere v1); with `rank_fields` (Cohere v1) the listed fields are ranked. |
| `top_n` / `top_k`    | How many results to return (best first); `top_k` is Voyage's name.                                                          |
| `return_documents`   | Return each document's text. Default: true on `/v1/rerank` (Cohere v1, Jina), false on `/v2/rerank` (Cohere v2).            |
| `max_tokens_per_doc` | Passed to Cohere.                                                                                                           |

## Response

One body serves every client: Cohere reads `id`, `results` and `meta`; Jina reads `model`, `results` and `usage`.

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

## Providers

| Provider type               | Upstream                 | Billed by                          |
| --------------------------- | ------------------------ | ---------------------------------- |
| `cohere`                    | `POST /v2/rerank`        | search units (`meta.billed_units`) |
| `voyage`                    | `POST /rerank` (`top_k`) | tokens (`usage.total_tokens`)      |
| `jina`, `openai-compatible` | `POST /rerank` (`top_n`) | tokens (`usage.total_tokens`)      |

`openai-compatible` covers self-hosted rerankers with the Jina/Cohere-shaped `/rerank` (vLLM, Infinity). Documents are sent as text; DiRouter adds them back to the results itself when `return_documents` asks for them.

## Price and limits

- Token-billed rerankers: the provider's tokens at the model's **input price** (`inputPerMTok`).
- Search-billed rerankers (Cohere): the provider's search units at the new **Rerank / search unit** price (`perSearchUsd`). A search unit is one query over up to 100 documents.
- Whatever the provider does not report is estimated (a quarter of the characters of the query, once per document, plus the documents; one search unit per 100 documents) and the usage event says so (`usageEstimated`).
- The input estimate counts against the key's tokens-per-minute limit and the request against its requests-per-minute limit before any provider is called; budgets and the wallet apply as for embeddings. The usage event has `inboundApi: "rerank"` and `media.searches`.
