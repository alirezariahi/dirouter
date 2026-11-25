# Native provider pass-through (card 30.7)

Some provider endpoints have no DiRouter translation yet: batches, files, legacy text completions,
a provider's own extensions. Pass-through forwards such a request to the provider unchanged, behind
the same virtual key, limits, budgets and request log as translated traffic.

```text
{METHOD} /passthrough/{provider-slug}/{path relative to the provider's base URL}
```

```bash
# OpenAI provider with base URL https://api.openai.com/v1 → POST https://api.openai.com/v1/completions
curl https://api.example.com/passthrough/openai/completions \
  -H "authorization: Bearer $DIROUTER_KEY" \
  -H 'content-type: application/json' \
  -d '{ "model": "gpt-3.5-turbo-instruct", "prompt": "Say hello" }'
```

## Turning it on

Pass-through is **off by default** and needs two separate switches:

1. **The provider's path allow-list**: `options.passthroughPaths` on the provider (Providers page →
   Edit → _Pass-through allowed paths_, one per line). Each entry is `[METHOD ]/path`, relative to
   the base URL; a trailing `*` matches anything after it. Without a method, every method
   (`GET`, `POST`, `PUT`, `PATCH`, `DELETE`) is allowed. An empty list allows nothing.

   ```json
   { "passthroughPaths": ["POST /completions", "POST /batches", "/batches/*", "/files*"] }
   ```

2. **The key's grant**: `passthroughProviders` on the virtual key (Keys page → _Pass-through
   providers_): provider slugs, or `*` for every provider of the organization. Empty means the key
   cannot use pass-through. Only owners and admins can grant it, because it reaches the provider's
   raw API with the organization's credentials.

| Check                                       | Answer                    |
| ------------------------------------------- | ------------------------- |
| missing or invalid key                      | 401                       |
| key without a grant for this provider       | 403                       |
| provider not in the key's organization      | 404                       |
| path or method not in the allow-list        | 403                       |
| path with `..`, `//`, `%2f`, `%2e` or `\`   | 400                       |
| Bedrock or plugin provider (no auth to add) | 400                       |
| prepaid (wallet) key                        | 403 (cost not reservable) |

## What still applies

- **Authentication** of the virtual key (expiry, IP allow-list).
- **Rate limits** (RPM, and TPM on a rough estimate of the body size), **budgets** of the key,
  project and team, and the key's **concurrency cap**.
- **Guardrails**: request policies run over every string value of a JSON body (except `model`);
  a blocking policy answers 400 before the provider is called, a redacting one rewrites the body.
  Response policies run over a JSON answer the same way. Streams and binary answers flow through
  unchanged, and policies that need a model call (moderation, injection classifier) are not
  evaluated on pass-through.
- **Usage**: every request writes a usage event with inbound API `passthrough`. When the answer
  carries usage (OpenAI `usage`, Anthropic `usage`, Gemini `usageMetadata`, also inside an SSE
  stream) and names a model that is configured on that provider, the request is priced with that
  model's price; otherwise the cost is 0. The requested model in the log is the body's `model`, or
  `{provider}{path}` when there is none.

## Credentials and headers

- The credential is a weighted pick among the provider's enabled credentials that health has not
  taken out of rotation; its authentication is added exactly as for normal traffic (Bearer,
  `x-api-key` with `anthropic-version`, `x-goog-api-key`, Azure `api-key` or Entra token, Vertex
  service-account token), plus the credential's extra headers. Outbound proxy and timeouts are
  the provider's.
- **The client's DiRouter key never reaches the provider.** Only these client headers are
  forwarded: `content-type`, `accept`, `anthropic-version`, `anthropic-beta`, `openai-beta`,
  `idempotency-key`. A `key` query parameter is removed.
- Back to the client go `content-type`, `content-disposition`, `cache-control`, `retry-after` and
  the provider's rate-limit headers; never `set-cookie`. `x-dirouter-provider` names the provider.
- There is no retry and no fallback: pass-through requests (file uploads, batch creation) are not
  safe to repeat.

The request body is kept as raw bytes (any content type, up to 20 MB), so multipart uploads and
binary bodies reach the provider unchanged.
