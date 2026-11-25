# Playground

Code: `apps/dashboard/src/pages/playground.tsx` (stream helpers in `src/lib/playground-stream.ts`,
messages in `src/i18n/playground-stream.ts`) · cards 16.5 and 25.6 · route `/playground`.

One prompt runs on up to four models side by side. Every column is **streamed** live and shows:

- the text as it arrives, reasoning when the model sends it, and the **tool calls** (name and
  arguments, assembled from the streamed deltas);
- **TTFT** (time to the first content, reasoning or tool-call delta), latency, input/output
  tokens, estimated cost, HTTP status and finish reason;
- the gateway's **`x-dirouter-*` headers** (model, provider, attempts, cache, …) and `x-request-id`.

The request carries what a real client sends: system prompt, an attached **image** (PNG, JPEG,
WebP or GIF, downsized to 1024 px in the browser), **tool definitions** as OpenAI `tools` JSON with
`tool_choice`, `max_tokens`, `temperature`, `top_p`, `reasoning_effort` and `response_format`
(`text`, `json_object`, or `json_schema` with a schema). **Stop** cancels every stream, and the
gateway request with it.

Calls are billed to a virtual key the user created (the key is checked, never stored).

## API

`POST /orgs/:orgId/playground/stream` (permission `models:read`) runs one model and answers
`text/event-stream`. The dashboard opens one stream per column.

| Body field                         | Gateway request field                                    |
| ---------------------------------- | -------------------------------------------------------- |
| `apiKey`                           | `Authorization: Bearer …` (must be the caller's own key) |
| `model`, `prompt`, `system`        | `model`, `messages`                                      |
| `image`                            | `image_url` part of the user message (base64 data URL)   |
| `tools`, `toolChoice`              | `tools`, `tool_choice`                                   |
| `maxTokens`, `temperature`, `topP` | `max_tokens`, `temperature`, `top_p`                     |
| `reasoningEffort`                  | `reasoning_effort` (`minimal`, `low`, `medium`, `high`)  |
| `responseFormat`                   | `response_format`                                        |

| Event   | Data                                                                                          |
| ------- | --------------------------------------------------------------------------------------------- |
| `meta`  | `status` and `headers` (the gateway's `x-dirouter-*` and `x-request-id`)                      |
| `ttft`  | `ms` when the first content, reasoning or tool-call delta arrives                             |
| `chunk` | one OpenAI `chat.completion.chunk`, unchanged                                                 |
| `error` | `status`, `code`, `message` (a gateway refusal such as `budget_exceeded`, or a broken stream) |
| `end`   | `latencyMs`, `ttftMs`, `inputTokens`, `outputTokens`, `estimatedCostUsd`                      |

A refused key is an ordinary JSON error before anything is streamed. The control-api body limit is
1 MB, so an image data URL may be at most 900,000 characters. `POST playground/compare` (card 16.5)
still answers all models at once without streaming.

## Tests

- `apps/dashboard/src/pages/playground.test.tsx`: four models streamed with TTFT and headers per
  column, a tool call, an image with every parameter, local validation and a gateway refusal.
- `apps/control-api/src/playground/playground-stream.unit.test.ts`: the gateway request, validation
  and the event stream.
- `apps/control-api/src/playground/playground.integration.test.ts`: over HTTP against
  mock-provider: streamed text, parameters, a tool call, an image, and a refused key.
- `scripts/e2e/sprint-4.mjs` scenario `25.6` through the real gateway.
