[English](mock-provider.md) · [فارسی](mock-provider.fa.md)

# Mock Provider

Code: `apps/mock-provider` · Tests: `apps/mock-provider/src/*.test.ts` and the contract test in `packages/providers` · Card 9.1

A fake provider compatible with OpenAI, Azure OpenAI and Anthropic (stream and non-stream, tool call) for resilience testing without real cost.

- In dev it is always running: `http://mock.localhost` and from inside the network `http://mock-provider:8090`.
- In prod it runs only with the `mock` profile (`docker compose --profile mock`).

## Routes

| Route                                                                      | Description                                                                                                                 |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `POST /v1/chat/completions`                                                | OpenAI and OpenAI-compatible                                                                                                |
| `POST /openai/deployments/{deployment}/chat/completions?api-version=…`     | Azure OpenAI                                                                                                                |
| `POST /v1/messages`                                                        | Anthropic                                                                                                                   |
| `POST /model/{modelId}/converse` and `/converse-stream`                    | AWS Bedrock Converse (binary eventstream for the stream; the signature is not checked)                                      |
| `GET /v1/models`                                                           | Model list                                                                                                                  |
| `GET /__mock/stats`                                                        | Request count by key and status, and the last 20 bodies                                                                     |
| `POST /__mock/reset`                                                       | Reset the statistics                                                                                                        |
| `PUT /__mock/config`                                                       | `{"directives":"…"}` global default scenario                                                                                |
| `GET /healthz`                                                             | Health                                                                                                                      |
| `POST /oauth2/token`                                                       | Google JWT-bearer token endpoint (card 27.4)                                                                                |
| `POST /{tenant}/oauth2/v2.0/token`                                         | Entra ID v2 client-credentials token endpoint                                                                               |
| `POST /{v1,v1beta1}/projects/…/publishers/google/models/{m}:{verb}`        | Vertex AI (shares the Gemini handler)                                                                                       |
| `GET/PUT /__mock/oauth`                                                    | Issued tokens per identity; `{"ttlSeconds":n,"reset":true}`                                                                 |
| `GET /catalog/prices.json`                                                 | Fake model price list for the catalog sync (card 27.5); 404 until set                                                       |
| `PUT /__mock/catalog`                                                      | Body = the price list (LiteLLM or DiRouter format); `{}` clears it                                                          |
| `GET /v1/realtime?model=…` (WebSocket), `/openai/v1/realtime?model=…`      | Realtime API (card 30.5), GA event names or beta with `OpenAI-Beta: realtime=v1`                                            |
| `POST /v1/completions`, `/openai/deployments/{d}/completions`              | Legacy completions (card 30.4): instruct/davinci/babbage models only, 404 for chat models                                   |
| `POST /v1/images/edits`, `/v1/images/variations`, `/v1/audio/translations` | Image edits and variations (multipart, gpt-image tokens count 65 per uploaded image) and translation to English (card 30.4) |

### Realtime (card 30.5)

The WebSocket endpoint answers `session.update`, `input_audio_buffer.append/commit/clear`, `conversation.item.create/delete`, `response.create` and `response.cancel` like OpenAI, and rejects anything else with an `error` event. Usage is deterministic so billing can be checked: input text is one token per 4 characters of the conversation, committed audio is 10 tokens per second of PCM16 at 24 kHz (48,000 bytes), and a response produces the scenario `text` (one token per 4 characters) plus 2 audio tokens per delta when audio output is on. The handshake honours `status=` (refused with that HTTP status), and `chunks=`, `chunk_delay=`, `text=` and `no_usage` shape the response. `GET /__mock/stats` has a `realtime` section: sessions opened and open, the client event types received, the last upstream model, auth header and beta flag, and `cutMidResponse` (sessions whose socket closed while a response was still streaming).
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |

| `POST /v1/completions`                                                                   | Legacy OpenAI text completions with usage; untranslated, for pass-through (card 30.7)                                                                     |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /web/searxng/search`, `GET /web/brave/res/v1/web/search`, `POST /web/tavily/search` | Fake web search backends (card 30.8); `PUT /__mock/web` `{"fail":["searxng"]}` makes them fail                                                            |
| `GET /web/page/{n}`, `/web/redirect?to=`, `/web/big`, `/web/binary`, `/web/slow`         | Pages for web fetch tests: HTML, a redirect, 3 MiB, a binary body, a 5 s delay                                                                            |
| `GET /v1/credits`, `/user/balance`, `/v1/users/me/balance`, `/v1/user/info`              | Fake account balances of OpenRouter, DeepSeek, Moonshot and SiliconFlow (card 32.9); `PUT /__mock/balance` `{"amount":0.5}` sets the value (default 42.5) |

## Scenario selection

Directives are separated by `,` or `;`. Sources in priority order:

1. Header `x-mock: <directives>`
2. API key in the form `mock:<directives>`, in `Authorization: Bearer` or `x-api-key`
3. Global default: env `MOCK_DEFAULT` or `PUT /__mock/config`

> The gateway does not forward client headers to upstream, so for testing through the gateway, put the scenario in the **credential key** (for example `mock:status=503`). The `x-mock` header is for testing mock directly.

| Directive                                 | Effect                                                                                                         |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `status=<code>`                           | Always return that error status (400, 401, 429, 500, 503, 529 …) with each API's standard error body           |
| `rate_limit`                              | 429                                                                                                            |
| `overloaded`                              | 529 (Anthropic overloaded)                                                                                     |
| `auth`                                    | 401                                                                                                            |
| `context_length`                          | 400 with the message "maximum context length"                                                                  |
| `retry_after=<s>`                         | `Retry-After` header                                                                                           |
| `error_rate=<0..1>`                       | Probability of a random 503                                                                                    |
| `latency=<min>-<max>`                     | Random delay (milliseconds) before the response                                                                |
| `ttft=<ms>`                               | Delay before the header and the first chunk                                                                    |
| `chunk_delay=<ms>`                        | Interval between stream chunks                                                                                 |
| `chunks=<n>`                              | Number of text chunks (default 5)                                                                              |
| `drop_after=<n>` (or `stream_drop_after`) | Cut the connection in the middle of the stream after n chunks                                                  |
| `tool[=name]`                             | Response with a tool call (default `get_weather`)                                                              |
| `text=<str>`                              | Response text                                                                                                  |
| `tool_input_b64=<base64url>`              | Input of the `tool` call as base64url JSON (default `{"city":"Tehran"}`), e.g. an apply_patch call (card 31.2) |
| `text_b64=<base64url>`                    | Response text of any content (commas included), unpadded base64url; e.g. broken JSON for card 31.1             |
| `no_usage`                                | No `usage` (for testing token estimation, card 6.2)                                                            |

Structured output (card 27.1): when an Anthropic request carries `output_config.format` (or a Bedrock request `additionalModelRequestFields.output_config.format`), the answer text is JSON built from the schema; when it carries the gateway's `dirouter_structured_output` tool, the answer is a call to that tool with input built from the schema. Strings become `"mock"`, numbers `1` (or `minimum`), booleans `true`, arrays get `minItems` items.

Tool-call pairing (card 31.1): like the real providers, `/v1/messages` answers 400 to a `tool_use` without a `tool_result` in the next message, a `tool_result` without a `tool_use` in the previous one, or a repeated `tool_use` id; `/v1/chat/completions` answers 400 to an assistant `tool_calls` message not followed by a tool message per call, or a stray tool message. The messages use the providers' wording.

Prompt caching on the Anthropic route (card 31.3), with Anthropic's rules: a block with `cache_control` (or the last block, for a top-level `cache_control`) is a breakpoint; a request reads the longest prefix an earlier one wrote (`cache_read_input_tokens`) and writes the rest up to its last breakpoint (`cache_creation_input_tokens`). No breakpoint, no caching.

Prompt caching on the Bedrock route (card 27.3): the prompt up to the last `cachePoint` is the cached prefix; the first request with a prefix reports `cacheWriteInputTokens`, later ones `cacheReadInputTokens`. `POST /__mock/reset` empties the cache.

Examples:

```bash
curl -s http://mock.localhost/v1/chat/completions -H 'x-mock: rate_limit,retry_after=2' \
  -H 'content-type: application/json' -d '{"model":"m","messages":[{"role":"user","content":"hi"}]}'
curl -sN http://mock.localhost/v1/chat/completions -H 'x-mock: chunks=20,chunk_delay=200,drop_after=5' \
  -H 'content-type: application/json' -d '{"model":"m","stream":true,"messages":[{"role":"user","content":"hi"}]}'
```

## Dev providers in the snapshot

`make dev-snapshot` creates these providers on mock:

| Model          | Scenario                     | Purpose                                      |
| -------------- | ---------------------------- | -------------------------------------------- |
| `mock/small`   | healthy                      | default                                      |
| `mock/down`    | `status=503`                 | fallback (combo `dev` / alias `gpt-4.1`)     |
| `mock/bad`     | `status=400`                 | combo `dev-bad`: must NOT fall back          |
| `mock/429`     | `rate_limit`                 | combo `dev-429`: falls back to `mock/claude` |
| `mock/tool`    | `tool`                       | tool call                                    |
| `mock/nousage` | `no_usage`                   | token estimation                             |
| `mock/claude`  | healthy, type `anthropic`    | OpenAI to Anthropic translation              |
| `mock/azure`   | healthy, type `azure-openai` | deployment path in Azure                     |
| `mock/long`    | 600 chunks, 1 second apart   | ten-minute stream through Traefik            |

## OAuth token endpoints (card 27.4)

`POST /oauth2/token` accepts Google's JWT-bearer grant: the assertion must be an RS256 JWT with `iss`, `scope`, `aud` (ending in `/oauth2/token`), `iat` and `exp` (at most one hour later); the signature is not verified. `POST /{tenant}/oauth2/v2.0/token` accepts Entra ID's client-credentials grant (`scope` must end in `/.default`). An identity (`iss` or `client_id`) containing `fail` gets `401 invalid_client`, so one credential can fail while another works. Issued tokens start with `mock-oauth-`; any request that presents such a token after it expired, or one the mock never issued, gets `401`, which shows whether the gateway refreshes in time. `PUT /__mock/oauth {"ttlSeconds":4}` shortens the lifetime of new tokens; `GET /__mock/oauth` returns `byIdentity` counts and `refused`.
