[English](bedrock.md) · [فارسی](bedrock.fa.md)

# AWS Bedrock (card 11.3)

| Field             | Value                                                                                                                                       |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| type              | `bedrock`                                                                                                                                   |
| baseUrl           | required; for example `https://bedrock-runtime.us-east-1.amazonaws.com`                                                                     |
| options.region    | SigV4 region (default `us-east-1`)                                                                                                          |
| credential secret | `accessKeyId:secretAccessKey`, `accessKeyId:secretAccessKey:sessionToken`, or JSON `{"accessKeyId":…,"secretAccessKey":…,"sessionToken":…}` |
| chat              | `POST /model/{modelId}/converse`                                                                                                            |
| stream            | `POST /model/{modelId}/converse-stream`                                                                                                     |
| embeddings        | not supported                                                                                                                               |

## Signing (SigV4)

- Requests are signed with `node:crypto`, without the AWS SDK: `x-amz-date`, `x-amz-content-sha256`, `x-amz-security-token` (when present) and `authorization`.
- `host`, `content-type`, `x-amz-security-token` and credential headers are part of the signed headers.
- The canonical URI is the request path with every segment URI-encoded once more (the SigV4 rule for every service except S3): a model id is sent as `…-v2%3A0` and signed as `…-v2%253A0`. Model ARNs (`:` and `/`) work the same way.
- Temporary credentials: put the session token in the credential secret (third `:` segment or the JSON `sessionToken` field). `options.sessionToken` is a provider-wide fallback used only when the secret has no token. The `AWS_SESSION_TOKEN` environment variable is not read, because a process-wide token cannot match per-credential key pairs.
- The region is read from `options.region`; when empty, `AWS_REGION`, and finally `us-east-1`.

## Chat translation

- The **Converse API** is used, not InvokeModel, so one adapter covers every Bedrock model.
- `system[]` → `system[]`, messages → `messages[]`, text/image → `content[]` (`text` / `image`).
- `tool_call` → `toolUse` and `tool_result` → `toolResult`; `toolChoice` maps to `toolChoice`.
- Converse requires alternating roles, so consecutive turns of the same role are merged: several `tool` messages become one `user` message with one `toolResult` block each.
- `maxOutputTokens` → `inferenceConfig.maxTokens`; `temperature`, `topP` and `stop` are mapped too.
- `response_format` (card 27.1): a forced `dirouter_structured_output` tool (`toolConfig.toolChoice.tool`) by default, turned back into JSON text in the response and the stream; models that reject a forced tool (Claude Opus 5.5, Sonnet 5.5, Fable and Mythos 5.1+) get `additionalModelRequestFields.output_config.format`. `options.structuredOutput` (`native` or `tool`) overrides the choice.
- Response: `output.message.content[]`, `stopReason` (`end_turn`/`tool_use`/`max_tokens`/…) and `usage`.
- Stream: the binary `vnd.amazon.eventstream` format is parsed (not SSE). Each frame is length-prefixed and protected by two CRC-32 checksums (prelude and message), which are verified. The event name comes from the `:event-type` header (`messageStart`, `contentBlockStart`, `contentBlockDelta`, `contentBlockStop`, `messageStop`, `metadata`) and the payload is the bare event body.
- The upstream `contentBlockIndex` is kept as the canonical block index, so text, reasoning and tool blocks never share an index.
- In-stream exceptions (`:message-type: exception`) become a canonical `error` event whose `code` is the error class: `throttlingException` → `rate_limit`, `serviceUnavailableException` → `overloaded`, `modelStreamErrorException` / `internalServerException` → `server`, `validationException` → `bad_request`, `modelTimeoutException` → `timeout`. A corrupt or truncated frame is reported as `server`.

## Example configuration

```json
{
  "type": "bedrock",
  "name": "Bedrock us-east-1",
  "baseUrl": "https://bedrock-runtime.us-east-1.amazonaws.com",
  "options": { "region": "us-east-1" },
  "credentials": [{ "name": "prod", "secret": "AKIA...:secret..." }]
}
```

Models are defined with the full Bedrock identifier, for example `anthropic.claude-3-5-sonnet-20241022-v2:0` or `meta.llama3-70b-instruct-v1:0`.

## Limitations

- Native Bedrock embeddings and list-models are not implemented in this version.
- Images inside a tool_result are not supported and are dropped with a drop report.
- Documents (card 27.2) travel inline as `document` blocks (pdf, csv, doc, docx, xls, xlsx, html, txt, md); a document by URL or a provider file id, and any audio input, are refused with a 400.
- For temporary IAM roles, put the session token in the secret (see Signing); the gateway does not refresh it.

Tests: `packages/providers/src/bedrock.test.ts` for signing and the event stream, and `native.test.ts` for adapter registration.
