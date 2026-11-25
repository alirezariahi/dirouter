# Cohere (card 11.3)

| Field           | Value                             |
| --------------- | --------------------------------- |
| type            | `cohere`                          |
| default baseUrl | `https://api.cohere.com`          |
| chat            | `POST /v2/chat`                   |
| embeddings      | `POST /v2/embed`                  |
| model discovery | `GET /v1/models`                  |
| authentication  | `Authorization: Bearer <api key>` |

## Chat

- `messages[]` with `system`, `user`, `assistant` and `tool` roles; the canonical system prompt becomes one `system` message.
- `max_tokens`, `temperature`, `p` (top_p), `k` (top_k), `stop_sequences`, `stream`.
- Tools use `tools[].function`; `tool_choice` is `REQUIRED` or `NONE`.
- Streaming events `message-start`, `content-delta`, `tool-call-start`, `tool-call-delta` and `message-end` are decoded to canonical events. In the tool-call events `delta.message.tool_calls` is a single object (one event per call); a one-element array is accepted too.
- finishReason: `COMPLETE`/`STOP_SEQUENCE`→`stop`, `MAX_TOKENS`→`length`, `TOOL_CALL`→`tool_calls`, `ERROR`→`error`.
- usage comes from `usage.tokens.input_tokens` and `output_tokens`.

## Embeddings

- `texts[]`, `input_type: "search_document"`, `embedding_types: ["float"]`.
- `dimensions` maps to `output_dimension`.
- Response: `embeddings.float[][]`; usage comes from `meta.billed_units.input_tokens`.
- At most 96 texts per request (`maxEmbeddingBatch`); the adapter does not split a batch into several calls.

## Example configuration

```json
{
  "type": "cohere",
  "name": "Cohere",
  "baseUrl": "https://api.cohere.com",
  "credentials": [{ "name": "production", "secret": "co-..." }]
}
```

Chat models: `command-r-plus`, `command-r`, `command-a-03-2025`, and others.  
Embedding models: `embed-multilingual-v3.0`, `embed-english-v3.0`, `embed-v4.0`.

Contract tests: `packages/providers/src/native.test.ts` — v2 request building, tools, response/stream parsing and embeddings.
