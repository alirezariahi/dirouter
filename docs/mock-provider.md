[English](mock-provider.md) · [فارسی](mock-provider.fa.md)

# Mock Provider

Code: `apps/mock-provider` · Tests: `apps/mock-provider/src/*.test.ts` and the contract test in `packages/providers` · Card 9.1

A fake provider compatible with OpenAI, Azure OpenAI and Anthropic (stream and non-stream, tool call) for resilience testing without real cost.

- In dev it is always running: `http://mock.localhost` and from inside the network `http://mock-provider:8090`.
- In prod it runs only with the `mock` profile (`docker compose --profile mock`).

## Routes

| Route                                                                  | Description                                             |
| ---------------------------------------------------------------------- | ------------------------------------------------------- |
| `POST /v1/chat/completions`                                            | OpenAI and OpenAI-compatible                            |
| `POST /openai/deployments/{deployment}/chat/completions?api-version=…` | Azure OpenAI                                            |
| `POST /v1/messages`                                                    | Anthropic                                               |
| `GET /v1/models`                                                       | Model list                                              |
| `GET /__mock/stats`                                                    | Request count by key and status, and the last 20 bodies |
| `POST /__mock/reset`                                                   | Reset the statistics                                    |
| `PUT /__mock/config`                                                   | `{"directives":"…"}` global default scenario            |
| `GET /healthz`                                                         | Health                                                  |

## Scenario selection

Directives are separated by `,` or `;`. Sources in priority order:

1. Header `x-mock: <directives>`
2. API key in the form `mock:<directives>`, in `Authorization: Bearer` or `x-api-key`
3. Global default: env `MOCK_DEFAULT` or `PUT /__mock/config`

> The gateway does not forward client headers to upstream, so for testing through the gateway, put the scenario in the **credential key** (for example `mock:status=503`). The `x-mock` header is for testing mock directly.

| Directive                                 | Effect                                                                                               |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `status=<code>`                           | Always return that error status (400, 401, 429, 500, 503, 529 …) with each API's standard error body |
| `rate_limit`                              | 429                                                                                                  |
| `overloaded`                              | 529 (Anthropic overloaded)                                                                           |
| `auth`                                    | 401                                                                                                  |
| `context_length`                          | 400 with the message "maximum context length"                                                        |
| `retry_after=<s>`                         | `Retry-After` header                                                                                 |
| `error_rate=<0..1>`                       | Probability of a random 503                                                                          |
| `latency=<min>-<max>`                     | Random delay (milliseconds) before the response                                                      |
| `ttft=<ms>`                               | Delay before the header and the first chunk                                                          |
| `chunk_delay=<ms>`                        | Interval between stream chunks                                                                       |
| `chunks=<n>`                              | Number of text chunks (default 5)                                                                    |
| `drop_after=<n>` (or `stream_drop_after`) | Cut the connection in the middle of the stream after n chunks                                        |
| `tool[=name]`                             | Response with a tool call (default `get_weather`)                                                    |
| `text=<str>`                              | Response text                                                                                        |
| `no_usage`                                | No `usage` (for testing token estimation, card 6.2)                                                  |

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
