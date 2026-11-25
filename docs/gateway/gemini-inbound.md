# Gemini API inbound (card 11.1)

Gemini clients — including **Gemini CLI** and the Google Gen AI SDKs — can point at DiRouter without code changes. The gateway accepts Google's routes, translates the request to canonical, and runs it through the normal routing, retry, fallback, budget and usage pipeline.

## Routes

| Method | Path                                           | Notes                                    |
| ------ | ---------------------------------------------- | ---------------------------------------- |
| POST   | `/v1beta/models/{model}:generateContent`       | full JSON response                       |
| POST   | `/v1beta/models/{model}:streamGenerateContent` | SSE; `?alt=sse` is accepted too          |
| POST   | `/v1beta/models/{model}:embedContent`          | embeddings (card 11.4)                   |
| POST   | `/v1beta/models/{model}:batchEmbedContents`    | batch embeddings (card 11.4)             |
| POST   | `/v1beta/models/{model}:countTokens`           | local token estimate, no upstream call   |
| GET    | `/v1beta/models`                               | models the virtual key is allowed to use |

The model in the path is the **DiRouter model slug** (the one configured in the panel). A `models/` prefix is accepted as well: `/v1beta/models/models/gemini-2.5-flash:generateContent` equals `/v1beta/models/gemini-2.5-flash:generateContent`.

## Authentication

Any of:

- `x-goog-api-key: dr-...`
- `authorization: Bearer dr-...`
- `?key=dr-...` (for clients that put the key in the URL)

The key is a gateway virtual key, so model allowlists, rate limits, IP allowlists and budgets all apply.

## Gemini CLI

```bash
export GOOGLE_GEMINI_BASE_URL="https://api.example.com"
export GEMINI_API_KEY="dr-..."
gemini
```

If your CLI version does not read `GOOGLE_GEMINI_BASE_URL`, use its documented base-URL setting and set `GOOGLE_API_KEY`/`GEMINI_API_KEY` to the DiRouter key. The resulting requests must target `/v1beta/models/...`.

Direct request:

```bash
curl https://api.example.com/v1beta/models/gemini-2.5-flash:generateContent \
  -H "x-goog-api-key: $DIROUTER_KEY" \
  -H 'content-type: application/json' \
  -d '{
    "systemInstruction": { "parts": [{ "text": "Be brief" }] },
    "contents": [{ "role": "user", "parts": [{ "text": "Hello" }] }],
    "generationConfig": { "maxOutputTokens": 256, "temperature": 0.2 }
  }'
```

## Request translation (Gemini → canonical)

| Gemini                                                                 | canonical                                                         |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `systemInstruction.parts[].text`                                       | `system[]`                                                        |
| `contents[].role = user / model`                                       | `user` / `assistant`                                              |
| `parts[].text`                                                         | `text`; with `thought: true` → `reasoning`                        |
| `inlineData` / `fileData`                                              | base64 / URL image                                                |
| `functionCall`                                                         | `tool_call` (JSON-string arguments; `thoughtSignature` in the id) |
| `functionResponse`                                                     | `tool_result` (id from the previous same-name call)               |
| `tools[].functionDeclarations[]`                                       | `tools[]`                                                         |
| `toolConfig.functionCallingConfig.mode`                                | `AUTO`→`auto`, `ANY`→`required`, `NONE`→`none`                    |
| `generationConfig.maxOutputTokens/temperature/topP/topK/stopSequences` | the matching canonical fields                                     |
| `generationConfig.thinkingConfig.thinkingBudget`                       | `reasoning.budgetTokens`                                          |
| `generationConfig.responseMimeType=application/json`                   | `json_object`, or `json_schema` with `responseSchema`             |
| `stream` (from the URL action)                                         | `stream`                                                          |

Parts without an equivalent are reported through `onDrop` and logged at debug level.

## Response

- The JSON response has Google's `GenerateContentResponse` shape: `candidates[].content.parts[]`, `finishReason`, `usageMetadata`, `modelVersion` and `responseId`.
- Reasoning text comes back with `thought: true`.
- `functionCall` carries object `args` and the original `thoughtSignature` when present.
- finishReason mapping is documented in [gemini](../providers/gemini.md).

### Streaming

Each canonical event becomes one `GenerateContentResponse` data line:

1. an initial chunk with `content.role = model` and empty parts,
2. one chunk per text delta,
3. reasoning with `thought: true`,
4. `tool_call_start` as `functionCall` with `args: {}` (Google streams function calls as one complete block, so clients should use the full response),
5. a final chunk with `finishReason` and `usageMetadata`.

An upstream error inside the stream is sent as `{"error":{"code":500,...}}`.

## Tests

- `packages/translator/src/gemini-inbound.test.ts` — golden tests for text, system, config, JSON schema, tools, tool call/response, images, reasoning and streaming.
- `apps/gateway/src/gateway.test.ts` — `x-goog-api-key` and `?key=`, `:generateContent` with a model slug, Gemini response shape.
- `apps/gateway/src/gemini.test.ts` — round trips with the official OpenAI/Anthropic SDKs against a Gemini-type provider.

```bash
pnpm --filter @dirouter/translator test
pnpm --filter @dirouter/gateway test
```
