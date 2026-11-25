# Caching and token savings

> Code: `apps/gateway/src/{cache,compress}.ts`, `apps/control-api/src/semantic-cache` (cards 13.1 to 13.3). Everything here is **off by default** and is switched on in the gateway settings (`PUT /orgs/:orgId/config/settings`, see [routing.md](routing.md#gateway-wide-settings)).

## 1. Exact cache (13.1)

A response is reused when the same project sends a byte-identical request for the same model.

```json
{
  "cache": {
    "exact": { "enabled": true, "ttlSeconds": 300, "maxOutputTokens": 4096, "maxTemperature": 0.2 }
  }
}
```

- **Key**: SHA-256 of organization, **project**, resolved model, system prompt, messages, tools, tool choice, response format, `max_tokens`, `temperature`, `top_p`, `top_k`, `stop`, `seed` and `user`. Headers are not part of the key.
- **Isolation**: the project id is part of the key, so two projects of one organization never read each other's responses, even for identical prompts.
- **Eligibility**: only requests with `temperature` at most `maxTemperature` (or unset) and `max_tokens` at most `maxOutputTokens`.
- **Storage**: an LRU in each replica (1000 entries) plus Valkey when available; a Valkey outage degrades to the local LRU.
- **Streaming**: `stream` is not part of the key. A hit for a streaming client is replayed as a real stream in the client's own format (OpenAI chunks, Anthropic events, Responses events or Gemini chunks), never as a JSON body. A stream that finished cleanly also populates the cache, so agent tools that always stream get hits. A stream whose text was rewritten by a guardrail is not cached.
- **Headers**: a hit carries `x-dirouter-cache: exact` (or `semantic`). A client can skip the cache for one request with `x-dirouter-cache: bypass` or `cache-control: no-cache`; such a request is not stored either.
- **Accounting**: a hit is logged with `cache_hit`, `cache_kind` and the tokens of the cached answer, at zero cost.

## 2. Semantic cache (13.2)

Reuses an answer when a new question means the same as an earlier one. Vectors live in Postgres (`pgvector`) behind control-api; the gateway asks with a short timeout and treats every error as a miss (fail-open).

```json
{
  "cache": {
    "semantic": {
      "enabled": false,
      "threshold": 0.95,
      "ttlSeconds": 3600,
      "timeoutMs": 150,
      "embeddingModel": "text-embedding-3-small",
      "projects": {
        "prj_support": { "enabled": true, "threshold": 0.92 },
        "prj_code": { "enabled": false }
      }
    }
  }
}
```

- **Requirements**: the database must run an image with the pgvector extension. The default `postgres:17-alpine` does not have it: build `deploy/docker/postgres.Dockerfile` and set `POSTGRES_IMAGE` (same base image, the existing data volume is reused). The cache table is created automatically once the extension is available. `SEMANTIC_CACHE_EMBEDDING_URL` must be set as well.
- **Per project**: `projects.<projectId>` overrides `enabled`, `threshold` and `embeddingModel` for one project; everything else comes from the global block. The example turns the cache on for one project only.
- **Embedding model**: control-api calls `SEMANTIC_CACHE_EMBEDDING_URL` (any OpenAI-compatible `/embeddings` endpoint, including DiRouter's own `/v1/embeddings`) with `SEMANTIC_CACHE_EMBEDDING_MODEL` or the override. The vector column has 1536 dimensions; a model with another size is rejected and the request is a miss.
- **Isolation**: entries are scoped to organization, project, requested model and embedding model. Vectors from two embedding models are never compared.
- **Safety limits**: only a single text-only user turn without tools and without a JSON response format is eligible. In a multi-turn or tool conversation the same last message ("yes", "continue") means something different each time, so those requests always go upstream.
- **Stats**: `GET /orgs/:orgId/stats/cache?from=&to=&projectId=` returns requests, hits and hit rate per kind, the tokens and provider cost the hits avoided (at the model's current price) and tokens removed by compression. The Cost page shows the same numbers.
- Management: `GET /orgs/:orgId/cache/semantic` (entry count), `DELETE` to purge the organization's entries.

## 3. Context compression (13.3)

Shrinks long agent conversations before routing. Applies only to messages older than the last `keepRecentMessages`.

```json
{
  "compression": {
    "enabled": true,
    "dedupe": true,
    "maxToolResultChars": 2000,
    "keepRecentMessages": 4,
    "dropOldReasoning": true
  }
}
```

| Step               | What happens                                                                                                             |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| Output cleanup     | terminal escape codes, trailing spaces, runs of blank lines and lines repeated more than 3 times are collapsed           |
| `git diff` cleanup | `index abc..def`, file-mode and similarity lines are removed; hunks are untouched                                        |
| Deduplication      | a tool result identical to an earlier one (200+ characters) is replaced by `[same output as the earlier tool call <id>]` |
| Head + tail        | a result longer than `maxToolResultChars` keeps the first 60% and last 40% of the budget, with the omitted length marked |
| Old reasoning      | reasoning blocks are dropped from old messages that have other content                                                   |

**Structure guarantee.** The compressor never removes a message and never removes, reorders or re-ids a `tool_call` or `tool_result`. Providers reject a conversation whose calls and results do not pair up, so after compression the tool-call structure is compared with the original and, on any difference, the original request is sent unchanged. Tool results with images and the most recent messages are never modified.

Saved characters are reported as `savedInputTokens` (characters / 4) in the usage event and `request_log.saved_input_tokens`.

**Evaluation set.** `apps/gateway/test-fixtures/compression/*.json` holds conversations in canonical form; `compress.test.ts` runs the compressor over each one, checks the guarantees above and prints the saving. The bundled `synthetic-claude-code.json` is hand-written in the shape Claude Code produces (84% saved with the settings in the test); it is not a captured session. Drop real, sanitized transcripts in that folder to evaluate on your own traffic.
