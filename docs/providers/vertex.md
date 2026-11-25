# Google Vertex AI (card 11.3)

| Field              | Value                                                                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| type               | `vertex`                                                                                                                             |
| baseUrl            | `https://{location}-aiplatform.googleapis.com` (or a custom endpoint)                                                                |
| options.project    | **required**                                                                                                                         |
| options.location   | defaults to `us-central1`                                                                                                            |
| options.authMode   | `apiKey` sends `x-goog-api-key`; `serviceAccount` (or a service-account JSON secret) exchanges the key for a token; otherwise Bearer |
| options.tokenUrl   | token endpoint for the service-account flow; defaults to the key's `token_uri`, then `https://oauth2.googleapis.com/token`           |
| options.apiVersion | defaults to `v1beta1` (Vertex has `v1` and `v1beta1`; the Gemini API's `v1beta` does not exist here)                                 |
| chat               | `POST /v1beta1/projects/{project}/locations/{location}/publishers/google/models/{model}:generateContent`                             |
| stream             | the same path with `:streamGenerateContent?alt=sse`                                                                                  |
| embeddings         | the same path with `:predict`                                                                                                        |

## Authentication

- Default: `Authorization: Bearer <token>` — suitable for a service-account access token or `gcloud auth print-access-token`.
- `options.authMode: "apiKey"`: the `x-goog-api-key` header (for endpoints that accept API keys).
- **Service account (card 27.4):** paste the downloaded service-account JSON key as the credential secret. It is encrypted with `MASTER_KEY` like every other secret and decrypted only in gateway memory. The gateway signs an RS256 JWT (`iss` = `client_email`, `scope` = `https://www.googleapis.com/auth/cloud-platform`, `aud` = the token URL, one-hour lifetime), exchanges it with the JWT-bearer grant, caches the access token per credential and refreshes it before expiry (5 minutes before, or at half the lifetime for short tokens). Concurrent requests share one refresh. A JSON secret with `"type": "service_account"` is detected automatically; `options.authMode: "serviceAccount"` makes it explicit and rejects any other secret. `options.scope` overrides the scope.
- **Token failures:** if a refresh fails while the cached token is still valid, the old token keeps serving and the refresh is retried after 10 seconds. With no valid token the attempt fails with class `auth` and **only that credential** goes into cooldown (exponential backoff); the provider's circuit breaker is not touched, so other credentials of the same provider keep serving. The connection test (`Test connection`) reports the token endpoint's error.
- The token call goes through the same outbound proxy, timeouts and SSRF guard as the model call.
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

With a service account (the secret is the whole JSON key file):

```json
{
  "type": "vertex",
  "baseUrl": "https://europe-west4-aiplatform.googleapis.com",
  "options": {
    "project": "my-gcp-project",
    "location": "europe-west4",
    "authMode": "serviceAccount"
  },
  "credentials": [
    {
      "name": "sa",
      "secret": "{\"type\":\"service_account\",\"client_email\":\"…\",\"private_key\":\"…\"}"
    }
  ]
}
```

## Limits

- Without `options.project` every request fails with an explicit error.
- Model discovery uses `publishers/google/models`; models from other publishers are not listed.
- Embeddings do not use the Gemini `embedContent` / `batchEmbedContents` verbs: the request is `:predict` with `{"instances":[{"content":"…"}],"parameters":{"outputDimensionality":N}}`, and the response is read from `predictions[].embeddings.values` (usage is the sum of `statistics.token_count`).
- Embeddings batch size: 250 texts per request in `us-central1`, 5 in other locations, and 1 for `gemini-embedding-*` models. `options.maxEmbeddingBatch` overrides the limit.

Tests: `packages/providers/src/oauth.test.ts` (JWT, token request, cache and refresh), `apps/gateway/src/credential-tokens.test.ts` (through the gateway against the mock token endpoint), `packages/providers/src/bedrock.test.ts` (Vertex section) — regional URL, Bearer and API key, required project, and the `:predict` embeddings request/response.
