[English](gateway.md) · [فارسی](gateway.fa.md)

# Gateway API

Base: `https://api.<DOMAIN>` (in dev: `http://api.localhost`) · card 4.9

Authentication with a virtual key, using one of these two methods:

- `Authorization: Bearer dr-…` (OpenAI style)
- `x-api-key: dr-…` (Anthropic style)

| endpoint                                              | Compatible with                                                                     |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `POST /v1/chat/completions` (and `/chat/completions`) | OpenAI Chat Completions, stream and non-stream                                      |
| `POST /v1/messages`                                   | Anthropic Messages, stream and non-stream                                           |
| `POST /v1/messages/count_tokens`                      | Anthropic count_tokens; local estimate with the tokenizer, without calling upstream |
| `GET /v1/models`                                      | models, aliases and combos allowed for the key                                      |

In `model` you can pass the model slug, an alias or a combo. Any client can connect to any upstream: an OpenAI client can go to Claude and vice versa ([translation.md](../gateway/translation.md)).

Response headers:

- `x-request-id`
- `x-dirouter-provider`
- `x-dirouter-model`
- `x-dirouter-attempts`
- `x-dirouter-instance`

Errors are returned in the format of the API that was called.

## Examples

```bash
curl https://api.example.com/v1/chat/completions \
  -H "Authorization: Bearer $DIROUTER_KEY" -H 'content-type: application/json' \
  -d '{"model":"gpt-4.1","messages":[{"role":"user","content":"Hello"}]}'

curl -N https://api.example.com/v1/chat/completions \
  -H "Authorization: Bearer $DIROUTER_KEY" -H 'content-type: application/json' \
  -d '{"model":"gpt-4.1","stream":true,"stream_options":{"include_usage":true},"messages":[{"role":"user","content":"Hello"}]}'

curl https://api.example.com/v1/messages \
  -H "x-api-key: $DIROUTER_KEY" -H 'anthropic-version: 2023-06-01' -H 'content-type: application/json' \
  -d '{"model":"claude-sonnet-4-5","max_tokens":256,"messages":[{"role":"user","content":"Hello"}]}'

curl https://api.example.com/v1/messages/count_tokens \
  -H "x-api-key: $DIROUTER_KEY" -H 'anthropic-version: 2023-06-01' -H 'content-type: application/json' \
  -d '{"model":"claude-sonnet-4-5","messages":[{"role":"user","content":"Hello"}]}'

curl https://api.example.com/v1/models -H "Authorization: Bearer $DIROUTER_KEY"
```

## Official SDKs (no code change)

```ts
import OpenAI from 'openai';
const openai = new OpenAI({
  apiKey: process.env.DIROUTER_KEY,
  baseURL: 'https://api.example.com/v1',
});

import Anthropic from '@anthropic-ai/sdk';
const anthropic = new Anthropic({
  apiKey: process.env.DIROUTER_KEY,
  baseURL: 'https://api.example.com',
});
```

`apps/gateway/src/sdk.test.ts` tests both SDKs in these modes:

- non-stream and stream, to upstream OpenAI and Anthropic
- usage in stream
- tool call and tool_result round trip
- `models.list` and `countTokens`
- `AuthenticationError` error

## Claude Code

```bash
export ANTHROPIC_BASE_URL=https://api.example.com
export ANTHROPIC_API_KEY=$DIROUTER_KEY
claude
```

Claude Code only accepts real Claude model names, such as `claude-sonnet-4-5`. In DiRouter, create an alias or combo for these names so they can go to any model you want. The target model must have a sufficient context window: the system prompt and Claude Code tools together with `max_tokens` amount to tens of thousands of tokens, and the router removes smaller models.

Check in compose (2026-11-07, Claude Code 2.1.285, dev aliases mapped to mock):

| mode                                                                | result                                                                                                                                                                                         |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `claude -p "say hi"` (stream)                                       | `success`; response from mock-anthropic                                                                                                                                                        |
| `claude -p "…"` with alias `claude-haiku-4-5` (mock with tool call) | Claude Code received the `tool_use` response, sent `tool_result` and kept looping until `--max-turns`. Ending with `error_max_turns` is expected, because the mock always returns a tool call. |
