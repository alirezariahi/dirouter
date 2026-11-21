[English](vertex.md) · [فارسی](vertex.fa.md)

# Google Vertex AI (card 11.3)

| Field              | Value                                                                                                    |
| ------------------ | -------------------------------------------------------------------------------------------------------- |
| type               | `vertex`                                                                                                 |
| baseUrl            | `https://{location}-aiplatform.googleapis.com` (or a custom endpoint)                                    |
| options.project    | **required**                                                                                             |
| options.location   | defaults to `us-central1`                                                                                |
| options.authMode   | `apiKey` sends `x-goog-api-key`; otherwise Bearer                                                        |
| options.apiVersion | defaults to `v1beta1` (Vertex has `v1` and `v1beta1`; the Gemini API's `v1beta` does not exist here)     |
| chat               | `POST /v1beta1/projects/{project}/locations/{location}/publishers/google/models/{model}:generateContent` |
| stream             | the same path with `:streamGenerateContent?alt=sse`                                                      |
| embeddings         | the same path with `:predict`                                                                            |

## Authentication

- Default: `Authorization: Bearer <token>` — suitable for a service-account access token or `gcloud auth print-access-token`.
- `options.authMode: "apiKey"`: the `x-goog-api-key` header (for endpoints that accept API keys).
- Extra credential headers (`credential.headers`) are applied on top; use them for custom service-account headers.

## Translation

Vertex shares the Gemini core (`VertexAdapter extends GeminiAdapter`), so requests, responses, streaming, tools and thought signatures translate exactly as documented in [gemini](gemini.md). The only differences are the project/location/publisher URL and the auth header. Put `upstreamModel` without a `models/` prefix; the gateway builds `publishers/google/models/...` itself.

## Example configuration

```json
{
  "type": "vertex",
  "name": "Vertex europe-west4",
  "baseUrl": "https://europe-west4-aiplatform.googleapis.com",
  "options": { "project": "my-gcp-project", "location": "europe-west4" },
  "credentials": [{ "name": "sa-token", "secret": "ya29..." }]
}
```

## Limits

- Without `options.project` every request fails with an explicit error.
- Model discovery uses `publishers/google/models`; models from other publishers are not listed.
- Embeddings do not use the Gemini `embedContent` / `batchEmbedContents` verbs: the request is `:predict` with `{"instances":[{"content":"…"}],"parameters":{"outputDimensionality":N}}`, and the response is read from `predictions[].embeddings.values` (usage is the sum of `statistics.token_count`).
- Embeddings batch size: 250 texts per request in `us-central1`, 5 in other locations, and 1 for `gemini-embedding-*` models. `options.maxEmbeddingBatch` overrides the limit.

Tests: `packages/providers/src/bedrock.test.ts` (Vertex section) — regional URL, Bearer and API key, required project, and the `:predict` embeddings request/response.
