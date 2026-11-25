# OpenAI Responses API (card 11.2)

The gateway accepts `POST /v1/responses`, translates the request to canonical, and returns the Responses API shape. Providers do not need to support Responses: the path reuses the existing Chat Completions / Messages / Gemini adapters.

## Request

```bash
curl https://api.example.com/v1/responses \
  -H "authorization: Bearer $DIROUTER_KEY" \
  -H 'content-type: application/json' \
  -d '{
    "model": "gpt-4.1",
    "instructions": "Be brief",
    "input": "Hello",
    "max_output_tokens": 256,
    "stream": false
  }'
```

Supported fields:

| Responses                                          | canonical                                                  |
| -------------------------------------------------- | ---------------------------------------------------------- |
| `input` string                                     | one `user` message                                         |
| `input[]` of type `message`                        | message with `role` (default `user`)                       |
| `input_text` / `input_image`                       | text / URL image                                           |
| `function_call`                                    | `tool_call` (id from `call_id`, `id` or the function name) |
| `function_call_output`                             | `tool_result`                                              |
| `reasoning` + `summary[]`                          | `reasoning`                                                |
| `instructions` and `developer` messages            | `system[]`                                                 |
| `tools[]` (type `function`)                        | `tools[]`                                                  |
| `tool_choice` (string or a named function)         | `toolChoice`                                               |
| `parallel_tool_calls`                              | `parallelToolCalls`                                        |
| `text.format` (`text`/`json_object`/`json_schema`) | `responseFormat`                                           |
| `max_output_tokens`, `temperature`, `top_p`        | the same fields                                            |
| `reasoning.effort`                                 | `reasoning.effort`                                         |
| `metadata`, `user`                                 | the same fields                                            |
| `stream`                                           | `stream`                                                   |

Parts without an equivalent (for example `input_file`) are reported through `onDrop` and removed, never guessed.

## Response

```json
{
  "id": "resp_cmpl_...",
  "object": "response",
  "created_at": 1760000000,
  "status": "completed",
  "model": "gpt-4.1",
  "output": [
    {
      "type": "message",
      "id": "msg_cmpl_...",
      "status": "completed",
      "role": "assistant",
      "content": [{ "type": "output_text", "text": "...", "annotations": [] }]
    }
  ],
  "output_text": "...",
  "usage": {
    "input_tokens": 12,
    "output_tokens": 5,
    "total_tokens": 17,
    "input_tokens_details": { "cached_tokens": 0 },
    "output_tokens_details": { "reasoning_tokens": 0 }
  },
  "error": null,
  "incomplete_details": null
}
```

- Text, reasoning and `function_call` items all appear in `output[]`.
- `status` is `completed`, `incomplete` (for `length`/`content_filter`/`refusal`) or `failed`.
- `usage` is present only when the provider reports it; otherwise the gateway estimates it for accounting.

## Streaming

SSE uses the standard Responses events:

```
event: response.created
event: response.output_text.delta
event: response.reasoning_summary_text.delta
event: response.output_item.added
event: response.function_call_arguments.delta
event: response.completed
```

- `response.completed` contains the full output (reasoning, message and function calls) plus usage.
- An upstream error becomes `response.failed` with `error.code` and `error.message`.
- With the exact cache enabled, a previously stored identical request is replayed as an SSE stream from the cache.

## Continuing a conversation with `previous_response_id`

When `stateRedis` (Valkey) is available, after every successful response the gateway stores the canonical messages plus the assistant reply under `resp:<response_id>` with a seven-day TTL.

- Send `previous_response_id` in the next request; the history is prepended to the new messages.
- An unknown or expired id returns 400 with `param: "previous_response_id"`.
- Without Valkey the field is ignored and only the current request's messages are used.

## Coding tools: `apply_patch` with any model

> Card 31.2. Codex edits files with `apply_patch`, a `custom` tool whose input is free-form text (a V4A patch described by a Lark grammar); OpenAI also offers a built-in `apply_patch` tool whose calls carry one file operation. Only OpenAI's models know them, so the gateway carries both as ordinary function tools and turns the calls back into what the client expects. Code: `packages/translator/src/coding-tools.ts`. Nothing has to be switched on: every Responses client that sends these tools gets it, including the Codex profile from the agent profiles page.

| Client sends                                                        | The model sees                                                                                                                          | The client gets back                                                                                                                                                                                     |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `{type: "custom", name, description, format: {type: "grammar", …}}` | function `name` taking `{input: string}`, the grammar in its description                                                                | `custom_tool_call` `{id: "ctc_…", call_id, name, input, status}`; streamed as `response.output_item.added`, `response.custom_tool_call_input.delta` / `.done` (whole input), `response.output_item.done` |
| `{type: "apply_patch"}`                                             | function `apply_patch` taking `{type, path, diff}` (`create_file`, `update_file`, `delete_file`), with the V4A rules in its description | `apply_patch_call` `{id: "apc_…", call_id, status, operation: {type, path, diff?}}`; streamed as one `output_item.added` / `.done` pair once the operation is complete                                   |
| replayed `custom_tool_call` / `apply_patch_call`                    | the assistant's tool call                                                                                                               |                                                                                                                                                                                                          |
| `custom_tool_call_output` / `apply_patch_call_output`               | the tool result (`status: "failed"` makes it an error result)                                                                           |                                                                                                                                                                                                          |

`tool_choice` `{type: "custom", name}` and `{type: "apply_patch"}` force the tool. Tests: `packages/translator/src/coding-tools.test.ts` (golden requests to Claude and Gemini, answers, replayed turns, stream events) and `apps/gateway/src/shaping.test.ts` (a Codex request through the gateway to a Claude and a Gemini model: the returned patch is applied to a file, and the next turn's replayed call and output reach the provider as a paired history). A run of the Codex CLI itself against a real Claude or Gemini provider needs those providers' keys and was not part of the automated tests.

## Compatibility

- Most SDKs and tools calling `openai.responses.create(...)` work unchanged; point `baseURL` at DiRouter.
- Tools that still use Chat Completions keep using `/v1/chat/completions`; Responses is an additional inbound API.
- Model allowlists, rate limits and virtual-key budgets apply exactly as on other routes.

## Tests

- `packages/translator/src/responses.test.ts` — input (text, messages, images, tool replay, reasoning), output and the full stream event sequence.
- `apps/gateway/src/gateway.test.ts` — real `/v1/responses` against the mock provider, including a valid and a missing/expired `previous_response_id`.

```bash
pnpm --filter @dirouter/translator test
pnpm --filter @dirouter/gateway test
```
