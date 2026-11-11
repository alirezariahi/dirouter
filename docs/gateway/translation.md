[English](translation.md) · [فارسی](translation.fa.md)

# OpenAI ⇄ Anthropic translation

> Code: `packages/translator` (card 4.4). Each input is first translated into the canonical model (`@dirouter/contracts`), and then into the destination API.

## Request

| canonical                      | OpenAI Chat                                                                           | Anthropic Messages                                                           | notes                                                                                     |
| ------------------------------ | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `system[]`                     | `system` and `developer` messages (joined with `\n\n`)                                | `system` (a string, or blocks when `cache_control` is present)               | the position of a system message in the middle of a conversation is not kept in Anthropic |
| `user` message                 | `content` as a string or parts                                                        | `content` blocks                                                             | consecutive messages with the same role are merged for Anthropic                          |
| image                          | `image_url` (URL or data URL)                                                         | `image` with a `source` of type `url` or `base64`                            | `file` (Files API) cannot be transferred                                                  |
| `tool_call`                    | `assistant.tool_calls[]` (argument as a JSON string)                                  | `tool_use` block (`input` object)                                            | invalid argument → `{}` and a drop is reported                                            |
| `tool` / `tool_result` message | `tool` message with `tool_call_id` (text only)                                        | `tool_result` block at the start of a `user` message                         | the order of results is kept; images in tool results are removed for OpenAI               |
| `reasoning`                    | `reasoning_effort` (input) / `reasoning_content` (response from compatible providers) | signed `thinking` block and `redacted_thinking`                              | thinking without a signature is not sent to Anthropic                                     |
| `tools[]`                      | `tools[].function`                                                                    | `tools[]` with `input_schema`                                                | Anthropic server tools go only to Anthropic                                               |
| `toolChoice`                   | `auto` / `none` / `required` / `{function}`                                           | `auto` / `none` / `any` / `tool`                                             |                                                                                           |
| `parallelToolCalls=false`      | `parallel_tool_calls: false`                                                          | `tool_choice.disable_parallel_tool_use`                                      |                                                                                           |
| `maxOutputTokens`              | `max_completion_tokens` (OpenAI) or `max_tokens` (compatible)                         | `max_tokens` (required; default 4096 or the model cap)                       |                                                                                           |
| `temperature`                  | 0 to 2                                                                                | 0 to 1                                                                       | above 1 for Anthropic is capped at 1                                                      |
| `topK`                         | —                                                                                     | `top_k`                                                                      |                                                                                           |
| `stop[]`                       | `stop`                                                                                | `stop_sequences`                                                             |                                                                                           |
| `seed`                         | `seed`                                                                                | —                                                                            |                                                                                           |
| `responseFormat`               | `response_format`                                                                     | —                                                                            | Anthropic has no native JSON mode                                                         |
| `reasoning.budgetTokens`       | effort: <4k=low, <16k=medium, the rest=high                                           | `thinking.budget_tokens` (minimum 1024; `max_tokens` higher than the budget) | effort→budget: minimal 1024, low 2048, medium 8192, high 16384                            |
| `user`                         | `user`                                                                                | `metadata.user_id`                                                           |                                                                                           |
| `stream`                       | `stream` + always `stream_options.include_usage`                                      | `stream`                                                                     |                                                                                           |
| `passthrough`                  | unknown input fields of OpenAI                                                        | unknown input fields of Anthropic                                            | sent only to a provider of the same family                                                |

## Response

| canonical            | OpenAI                                      | Anthropic                                     |
| -------------------- | ------------------------------------------- | --------------------------------------------- |
| `finishReason: stop` | `stop`                                      | `end_turn` (`stop_sequence` also → stop)      |
| `length`             | `length`                                    | `max_tokens`, `model_context_window_exceeded` |
| `tool_calls`         | `tool_calls` (the old `function_call` too)  | `tool_use`                                    |
| `content_filter`     | `content_filter`                            | `refusal`                                     |
| `refusal`            | `message.refusal` and `finish_reason: stop` | `refusal`                                     |
| `other`              | `stop`                                      | `end_turn` (`pause_turn` → other)             |

### usage

- canonical: `inputTokens` is the total input; `cacheReadTokens` and `cacheWriteTokens` are subsets of it; `reasoningTokens` is a subset of `outputTokens`.
- OpenAI: `prompt_tokens` = total input; `cached_tokens` = cache read.
- Anthropic: `input_tokens` **does not include** cache tokens, so `inputTokens = input + cache_creation + cache_read`, and vice versa.
- If an OpenAI-compatible response has no `usage` at all, `CanonicalResponse.usage` stays empty (it is not set to zero), and the gateway estimates it with a tokenizer. Details are in [concepts/cost.md](../concepts/cost.md).

## Dropped fields

The translator reports each field that has no equivalent through `onDrop(field, reason)`, and the gateway logs it at debug level. The list: `n>1`, `input_audio` and `file` in OpenAI, `document` and image `file` in Anthropic, `top_k` to OpenAI, `seed` and `response_format` to Anthropic, reasoning to OpenAI, thinking without a signature to Anthropic, images in tool results to OpenAI, and temperature above 1 to Anthropic.

## Tests

`pnpm --filter @dirouter/translator test` — more than 40 golden pairs in both directions, round-trip tests on real fixtures (`packages/contracts/src/__fixtures__`), and validation of the output against the destination schema. Coverage: `pnpm --filter @dirouter/translator coverage` (about 94% statements).

Stream (card 4.5): `packages/translator/src/stream.test.ts` includes 10,000 chunks without memory growth, multi-byte Persian text split across chunks, and a tool call in both directions. Closing the upstream after a client disconnect is tested in `apps/gateway/src/upstream.test.ts`: between the client's `abort` and the upstream socket closing, it takes less than 1 second. Implementation: the Fastify request's `AbortSignal` reaches `callUpstream`.
