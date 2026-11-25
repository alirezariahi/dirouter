[English](translation.md) · [فارسی](translation.fa.md)

# OpenAI ⇄ Anthropic translation

> Code: `packages/translator` (card 4.4). Each input is first translated into the canonical model (`@dirouter/contracts`), and then into the destination API.

## Request

| canonical                      | OpenAI Chat                                                                           | Anthropic Messages                                                           | notes                                                                                              |
| ------------------------------ | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `system[]`                     | `system` and `developer` messages (joined with `\n\n`)                                | `system` (a string, or blocks when `cache_control` is present)               | the position of a system message in the middle of a conversation is not kept in Anthropic          |
| `user` message                 | `content` as a string or parts                                                        | `content` blocks                                                             | consecutive messages with the same role are merged for Anthropic                                   |
| image                          | `image_url` (URL or data URL)                                                         | `image` with a `source` of type `url` or `base64`                            | image `file` (Files API) cannot be transferred; documents and audio: [below](#documents-and-audio) |
| `tool_call`                    | `assistant.tool_calls[]` (argument as a JSON string)                                  | `tool_use` block (`input` object)                                            | invalid argument → `{}` and a drop is reported                                                     |
| `tool` / `tool_result` message | `tool` message with `tool_call_id` (text only)                                        | `tool_result` block at the start of a `user` message                         | the order of results is kept; images in tool results are removed for OpenAI                        |
| `reasoning`                    | `reasoning_effort` (input) / `reasoning_content` (response from compatible providers) | signed `thinking` block and `redacted_thinking`                              | thinking without a signature is not sent to Anthropic                                              |
| `tools[]`                      | `tools[].function`                                                                    | `tools[]` with `input_schema`                                                | Anthropic server tools go only to Anthropic                                                        |
| `toolChoice`                   | `auto` / `none` / `required` / `{function}`                                           | `auto` / `none` / `any` / `tool`                                             |                                                                                                    |
| `parallelToolCalls=false`      | `parallel_tool_calls: false`                                                          | `tool_choice.disable_parallel_tool_use`                                      |                                                                                                    |
| `maxOutputTokens`              | `max_completion_tokens` (OpenAI) or `max_tokens` (compatible)                         | `max_tokens` (required; default 4096 or the model cap)                       |                                                                                                    |
| `temperature`                  | 0 to 2                                                                                | 0 to 1                                                                       | above 1 for Anthropic is capped at 1                                                               |
| `topK`                         | —                                                                                     | `top_k`                                                                      |                                                                                                    |
| `stop[]`                       | `stop`                                                                                | `stop_sequences`                                                             |                                                                                                    |
| `seed`                         | `seed`                                                                                | —                                                                            |                                                                                                    |
| `responseFormat`               | `response_format`                                                                     | `output_config.format` or a forced tool                                      | see [Structured output](#structured-output)                                                        |
| `reasoning.budgetTokens`       | effort: <4k=low, <16k=medium, the rest=high                                           | `thinking.budget_tokens` (minimum 1024; `max_tokens` higher than the budget) | effort→budget: minimal 1024, low 2048, medium 8192, high 16384                                     |
| `user`                         | `user`                                                                                | `metadata.user_id`                                                           |                                                                                                    |
| `stream`                       | `stream` + always `stream_options.include_usage`                                      | `stream`                                                                     |                                                                                                    |
| `passthrough`                  | unknown input fields of OpenAI                                                        | unknown input fields of Anthropic                                            | sent only to a provider of the same family                                                         |

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

## Structured output

> Card 27.1. `response_format` (and an Anthropic client's `output_config.format`) works on every provider.

| Destination                               | `json_schema`                                                               | `json_object`                                                          |
| ----------------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| OpenAI and compatible                     | `response_format` unchanged                                                 | `response_format` unchanged                                            |
| Gemini and Vertex                         | `responseMimeType` + `responseJsonSchema`                                   | `responseMimeType: application/json`                                   |
| Anthropic, model with native support      | `output_config.format: {type: json_schema, schema}`                         | system instruction to answer with one JSON object (reported as a drop) |
| Anthropic, older model                    | forced tool `dirouter_structured_output` whose `input_schema` is the schema | the same tool with `{"type":"object"}`                                 |
| Bedrock (Converse), default               | forced tool `dirouter_structured_output` (`toolConfig.toolChoice.tool`)     | the same tool with `{"type":"object"}`                                 |
| Bedrock, model that rejects a forced tool | `additionalModelRequestFields.output_config.format`                         | system instruction                                                     |

- Native support is decided from the upstream model name: Claude Opus 4.1, 4.5, 4.8 and 5.x, Sonnet 5.x, Haiku 4.5 and 5.x, Fable and Mythos. On Bedrock the forced tool is the default and only the models that reject a forced `tool_choice` (Opus 5.5, Sonnet 5.5, Fable and Mythos 5.1 and later) use the native field. The provider option `structuredOutput` (`native` or `tool`) overrides the choice, for example for a model the list does not know yet.
- The fallback tool's call is turned back into text: the client receives the JSON in `message.content` (stream: content deltas) and `finish_reason: stop`, never a tool call. A call to any other tool keeps `finish_reason: tool_calls`.
- When the client sends its own tools as well, the fallback tool is added to them and `tool_choice` becomes `any` (or stays on the tool the client named). With extended thinking Anthropic rejects a forced tool, so the tool is requested in the system prompt with `tool_choice: auto`.
- An Anthropic client's `output_config.format` (or the older `output_format`) becomes the canonical `responseFormat`, so it also reaches OpenAI and Gemini; other `output_config` fields (`effort`) still pass through to Anthropic.
- The tool name `dirouter_structured_output` is reserved.

## Documents and audio

> Card 27.2. PDFs, other files and audio reach every provider that can read them; when the destination cannot, the client gets a 400 that names the part, never an answer with the file silently removed.

Canonical parts: `document` (source `base64`, `url`, `text` or `file`: a provider file id with its origin, plus `filename`, `title`, `context`, `citations`) and `audio` (source `base64` or `url`).

| Input                                                                            | canonical                                                                                 |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| OpenAI Chat `file` (`file_data` data URL or bare base64 + `filename`; `file_id`) | `document` (`base64`; `file` with origin `openai`)                                        |
| OpenAI Chat `input_audio` (`wav`, `mp3`)                                         | `audio` (`audio/wav`, `audio/mpeg`)                                                       |
| Responses `input_file` (`file_data`, `file_url`, `file_id`)                      | `document` (`base64`, `url`, `file`)                                                      |
| Anthropic `document` (`base64`, `url`, `text`, `content`, `file`)                | `document`; a `content` source keeps its text blocks                                      |
| Gemini `inlineData` / `fileData`                                                 | `image`, `document` (PDF, `text/*`, `application/*`) or `audio` (`audio/*`) by media type |

| canonical                          | OpenAI Chat                                 | Anthropic                                  | Gemini / Vertex | Bedrock (Converse)                                                         |
| ---------------------------------- | ------------------------------------------- | ------------------------------------------ | --------------- | -------------------------------------------------------------------------- |
| PDF, inline                        | `file.file_data` (data URL)                 | `document` `base64`                        | `inlineData`    | `document` `format: pdf`, `source.bytes`                                   |
| text document                      | text part                                   | `document` `text`                          | text part       | `document` `format: txt`                                                   |
| other files (docx, csv, …), inline | 400                                         | 400 (`text/*` is decoded to a text source) | `inlineData`    | `document` with its format (pdf, csv, doc, docx, xls, xlsx, html, txt, md) |
| document by URL                    | 400                                         | `document` `url`                           | `fileData`      | 400 (Converse reads S3 only)                                               |
| file id                            | only an OpenAI id                           | only an Anthropic id                       | 400             | 400                                                                        |
| audio, inline                      | `input_audio` (wav, mp3; other formats 400) | 400                                        | `inlineData`    | 400                                                                        |
| audio by URL                       | 400                                         | 400                                        | `fileData`      | 400                                                                        |

- Converse document names may only hold letters, digits, single spaces, hyphens, parentheses and brackets: the title or file name is cleaned and numbered (`report 1`).
- Routing: before the request is sent, the gateway keeps only the targets that can take the documents and audio it carries (`MEDIA_INPUT` per provider type in `packages/providers`, and the model capabilities `documents` and `audioInput`; `false` excludes the model, unset leaves it to the provider type). When none is left the answer is a 400 naming the model; a combo skips targets that cannot take the input. The `auto` aliases only pick models whose capability is `true`. The catalog marks the OpenAI, Anthropic and Gemini models.
- What a target cannot carry in detail (a URL for Bedrock, flac for OpenAI) is refused by the translator with `UnsupportedContentError` and answered with a 400 (`invalid_request`).
- Token estimates count about 250 tokens per KB of document and 2 per KB of audio.

## Prompt caching

> Card 27.3. A prompt-cache breakpoint (`cache_control`, with its `ttl`) is kept at every place Anthropic accepts one, and reaches Anthropic and Bedrock.

| Breakpoint on                                         | canonical           | Anthropic                    | Bedrock (Converse)                                                                                 |
| ----------------------------------------------------- | ------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------- |
| system block                                          | `system[].cache`    | `system[].cache_control`     | `{cachePoint}` after the block in `system`                                                         |
| tool definition                                       | `tools[].cache`     | `tools[].cache_control`      | `{cachePoint}` after the `toolSpec` in `toolConfig.tools`                                          |
| text, image, document                                 | `cache` on the part | `cache_control` on the block | `{cachePoint}` after the block                                                                     |
| `tool_use` / `tool_result` (and text inside a result) | `cache` on the part | `cache_control` on the block | `{cachePoint}` after `toolUse` / `toolResult`                                                      |
| top-level `cache_control` (automatic)                 | passthrough         | unchanged                    | `{cachePoint}` after the last block of the last message, unless one is there or 4 are already used |

- TTL: `cache_control.ttl` (`5m`, `1h`) becomes `cacheTtl` and goes back out as `cache_control.ttl` and as `cachePoint.ttl`. Without a TTL, the provider default (5 minutes) applies.
- OpenAI and Gemini cache prompts on their own; the markers are not sent to them.
- Usage: Converse `inputTokens`, like Anthropic's `input_tokens`, counts only uncached input, so canonical `inputTokens` = `inputTokens + cacheReadInputTokens + cacheWriteInputTokens`. An Anthropic client of a Bedrock model receives `cache_read_input_tokens` and `cache_creation_input_tokens`, in streams too.

### Automatic breakpoints

> Card 31.3. Clients that send no `cache_control` (every OpenAI-format client, most SDK code) get no prompt cache on Anthropic and Bedrock, which only cache what a breakpoint marks. Turn on `autoCache` in the request policy of a model or an alias and the gateway marks the stable prefix of such requests itself. Code: `packages/translator/src/auto-cache.ts`.

```json
PATCH /api/v1/orgs/{org}/models/{id}     { "requestPolicy": { "autoCache": true, "autoCacheTtl": "1h" } }
PATCH /api/v1/orgs/{org}/aliases/{id}    { "requestPolicy": { "autoCache": true } }
```

- Applies only to `anthropic` and `bedrock` providers; OpenAI and Gemini cache on their own and get nothing.
- Breakpoints, at most four: the last tool definition, the last system block, the last cacheable block of the last message, and the last block of the turn before the last answer (where the previous request ended), so the next turn reads everything the previous one wrote. Reasoning and audio blocks never carry one.
- A request that sets any breakpoint itself (on a block, inside a tool result, or Anthropic's top-level `cache_control`) is sent exactly as it came.
- An alias's policy is applied over its model's (`autoCacheTtl` too); `null` clears a policy. Unset TTL means the provider default (5 minutes).
- Savings: the Cost page shows the provider's prompt cache next to DiRouter's own cache: tokens read and written, what the reads saved against the normal input price, what the writes cost on top, and the net saving (`GET stats/cache` → `promptCache`).

Tests: `packages/translator/src/auto-cache.test.ts` (golden requests, and requests with their own markers left alone) and `apps/gateway/src/shaping.test.ts` (an OpenAI-format conversation to Claude reports `cached_tokens` greater than zero on its second turn, through a model policy and through an alias policy; the mock caches like Anthropic does).

## Repair of JSON answers and tool calls

> Card 31.1. Weaker models break JSON and agent clients replay histories providers reject; the gateway can repair both. Code: `packages/translator/src/repair.ts`, wiring in `apps/gateway/src/shaping.ts`.

Repair is off unless the key asks for it (`repair: ["json", "tools"]` on the key, the "Answer and history repair" boxes on the Keys page) or the request does with the header `x-dirouter-repair: json`, `tools`, `all` or `off` (the header wins over the key).

| Kind    | When                                                                                                                    | What                                                                                                                                                                                                                                                                                                                                                                             |
| ------- | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `json`  | a non-streamed answer to a request with `response_format` (`json_object` or `json_schema`) whose text is not valid JSON | Code fences and prose around the value are removed, trailing commas dropped, single quotes, bare keys, comments and Python literals (`True`, `None`) fixed, a missing comma inserted, and a truncated tail closed. The repair is only kept when the result parses; valid JSON is never touched. Streams are passed on as they come.                                              |
| `tools` | before routing, on the replayed history; and on every non-streamed answer                                               | A call repeated with the same id is kept once; every call gets its result in the tool turn right after it (a late result is moved there, a duplicate dropped, a missing one becomes an error result that says so); a result whose call is gone becomes user text; broken JSON in tool arguments is repaired. A trailing assistant turn that waits for its results is left alone. |

Each repair is logged (`repaired before passing on`, with the list) and counted in `dirouter_gateway_repairs_total{action}` (`json`, `tool_arguments`, `tool_duplicate_call`, `tool_duplicate_result`, `tool_orphan_result`, `tool_moved_result`, `tool_missing_result`).

Tests: `packages/translator/src/repair.test.ts` (a corpus of broken JSON, valid JSON left alone, and a golden broken history checked against Anthropic's and OpenAI's pairing rules) and `apps/gateway/src/shaping.test.ts` (through the gateway against the mock, which answers an unpaired history with the providers' own 400).

## Dropped fields

The translator reports each field that has no equivalent through `onDrop(field, reason)`, and the gateway logs it at debug level. The list: `n>1` and a `file` part with neither data nor id in OpenAI, image `file` in Anthropic, video and other unknown parts in Gemini and Responses, `top_k` to OpenAI, `seed` to Anthropic, `json_object` to a Claude model with native structured output (sent as an instruction), reasoning to OpenAI, thinking without a signature to Anthropic, images in tool results to OpenAI, and temperature above 1 to Anthropic.

## Tests

`pnpm --filter @dirouter/translator test` — more than 40 golden pairs in both directions, round-trip tests on real fixtures (`packages/contracts/src/__fixtures__`), and validation of the output against the destination schema. Coverage: `pnpm --filter @dirouter/translator coverage` (about 94% statements).

Stream (card 4.5): `packages/translator/src/stream.test.ts` includes 10,000 chunks without memory growth, multi-byte Persian text split across chunks, and a tool call in both directions. Closing the upstream after a client disconnect is tested in `apps/gateway/src/upstream.test.ts`: between the client's `abort` and the upstream socket closing, it takes less than 1 second. Implementation: the Fastify request's `AbortSignal` reaches `callUpstream`.

## Sprint 2 inbound APIs

- [Gemini API inbound](gemini-inbound.md) — `generateContent`, `streamGenerateContent`, `countTokens` and `x-goog-api-key` auth.
- [OpenAI Responses](responses.md) — `/v1/responses`, `previous_response_id` and streaming.
- [Embeddings](embeddings.md) — `/v1/embeddings` and `:embedContent` / `:batchEmbedContents`.
- [Native pass-through](passthrough.md) — `/passthrough/{provider}/*` for endpoints without a translation (card 30.7).
- [Web search and fetch](web-search.md) — `/v1/search`, `/v1/fetch`, online mode and `web_search` for non-Anthropic models (card 30.8).
