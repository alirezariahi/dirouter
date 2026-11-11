[English](anthropic.md) · [فارسی](anthropic.fa.md)

# Anthropic

- `type: anthropic`, `baseUrl: https://api.anthropic.com`
- Headers: `x-api-key`, `anthropic-version` (default `2023-06-01`, or `options.version`)
- `anthropic-beta`:
  - `options.betas`: fixed betas that are always sent
  - `options.allowedBetas`: betas that the Anthropic client (e.g. Claude Code) may send; `["*"]` means all. Betas are never passed through from the OpenAI client.
- Prompt caching (`cache_control`), signed thinking, and server tools pass through unchanged for the Anthropic client.
- usage: `cache_read_input_tokens` and `cache_creation_input_tokens` are recorded (total inputTokens = input + cache read + cache write).
- Errors: `overloaded_error` (529) and `api_error` (500) are retryable and trigger fallback.

## Claude Code through DiRouter (card 4.7)

- The client's `anthropic-version` and `anthropic-beta` headers are sent upstream, filtered by the allowed list (`allowedBetas`).
- `cache_control` and `thinking` are sent unchanged.
- usage includes cache read/write: `input_tokens` in Anthropic does not include the cache; it is summed in canonical.
- The `overloaded_error` (529) gets the class `overloaded`: retryable with fallback.

Check in compose (2026-11-07): Claude Code 2.1.285 was connected with `ANTHROPIC_BASE_URL=http://api.localhost` and alias `claude-sonnet-4-5` to a provider of type `anthropic` (mock-anthropic). The stream succeeded, and tool_use and tool_result went back and forth in both directions (details in [api/gateway.md](../api/gateway.md)).

⏳ Testing with real Anthropic requires an API key: create a provider of type `anthropic` with the real key and point the alias `claude-sonnet-4-5` to it.
