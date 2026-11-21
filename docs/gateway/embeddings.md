[English](embeddings.md) · [فارسی](embeddings.fa.md)

# Embeddings endpoint (card 11.4)

The gateway has two embedding inbound surfaces:

| Inbound                                          | Response                                   |
| ------------------------------------------------ | ------------------------------------------ |
| `POST /v1/embeddings` (OpenAI)                   | `{ object: "list", data: [...], usage }`   |
| `POST /v1beta/models/{model}:embedContent`       | `{ embedding: { values }, usageMetadata }` |
| `POST /v1beta/models/{model}:batchEmbedContents` | `{ embeddings: [{ values }] }`             |

Both share one pipeline: virtual-key auth, model resolution, routing with fallback, timeouts/retry, budgets, health and usage accounting.

## OpenAI

```bash
curl https://api.example.com/v1/embeddings \
  -H "authorization: Bearer $DIROUTER_KEY" \
  -H 'content-type: application/json' \
  -d '{ "model": "text-embedding-3-small", "input": ["hello", "world"], "dimensions": 512 }'
```

- `input`: a string or an array of strings (max 2,048).
- **Token-array input is not supported** and returns 422; send text and let the provider tokenize.
- `dimensions` is forwarded to providers that support it (`dimensions` for OpenAI/Jina, `output_dimension` for Voyage/Cohere, `outputDimensionality` for Gemini/Vertex).
- `encoding_format`: `float` (default) and `base64` are both supported. The official OpenAI SDKs request `base64` unless told otherwise and decode it themselves, so they work unchanged. Upstreams are always called with floats (not every provider supports base64); the gateway encodes the response as little-endian float32, the same format OpenAI uses.
- `x-dirouter-model` and `x-dirouter-provider` headers expose the chosen model and provider.
- `usage.prompt_tokens` comes from the provider; without provider usage the gateway estimates `ceil(length / 4)` and sets `usageEstimated` in the usage event.

## Gemini

```bash
curl https://api.example.com/v1beta/models/text-embedding-004:embedContent \
  -H "x-goog-api-key: $DIROUTER_KEY" \
  -H 'content-type: application/json' \
  -d '{ "content": { "parts": [{ "text": "hello" }] } }'
```

- Use `:batchEmbedContents` with `requests[]` for multiple texts.
- The model name is the DiRouter model slug; a `models/` prefix is accepted too.
- The Gemini `outputDimensionality` field is currently not read; use `dimensions` on `/v1/embeddings` or define the model with the desired output size.

## Adapters

| Provider type       | Upstream path                                                                           | Notes                                                                    |
| ------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `openai`            | `POST /embeddings`                                                                      | `encoding_format: "float"`                                               |
| `openai-compatible` | `POST /embeddings`                                                                      | with a preset (Mistral, Voyage, Jina, …)                                 |
| `azure-openai`      | deployment path + `api-version`                                                         | same as chat                                                             |
| `gemini`            | `:embedContent` / `:batchEmbedContents`                                                 | `x-goog-api-key`                                                         |
| `vertex`            | `projects/{project}/locations/{location}/publishers/google/models/{model}:embedContent` | `options.project` required; `options.location` defaults to `us-central1` |
| `cohere`            | `POST /v2/embed`                                                                        | `texts[]`, `input_type: search_document`, `embedding_types: ["float"]`   |
| `mistral`           | `POST /embeddings` (OpenAI-compatible)                                                  | `dimensions` is forwarded                                                |
| `voyage`            | `POST /embeddings`                                                                      | `input_type: document`, `output_dimension`                               |
| `jina`              | `POST /embeddings`                                                                      | `dimensions`                                                             |

Providers without an embedding adapter (for example Anthropic and Bedrock) return `does not support embeddings` and the fallback chain moves to the next candidate.

## Limits and fallback

- Virtual-key rate limits and budgets apply exactly as on chat.
- The model must be allowed in the snapshot; otherwise 403/404.
- An auth error disables the credential and triggers fallback; a non-retryable 4xx moves to the next candidate unless the combo's `fallbackOn` says otherwise.
- Usage events use `inboundApi: "openai.embeddings"`, `outputTokens: 0`, and `costUsd` computed from the model's input price.

## Tests

- `packages/providers/src/native.test.ts` — Cohere/Voyage/Jina contracts and presets.
- `apps/gateway/src/gateway.test.ts` — `/v1/embeddings` (batch + dimensions + headers), base64 encoding, `:embedContent` and `:batchEmbedContents` against the mock provider.
- `apps/mock-provider` — `/v1/embeddings`, `:embedContent` and `:batchEmbedContents` routes for integration tests.

```bash
pnpm --filter @dirouter/providers test
pnpm --filter @dirouter/gateway test
```

- `apps/gateway/src/sdk.test.ts` — the official `openai` SDK calling `embeddings.create` with its default (base64) transport and with `encoding_format: "float"`.
