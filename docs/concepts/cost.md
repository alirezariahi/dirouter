[English](cost.md) · [فارسی](cost.fa.md)

# Cost calculation and token estimation

Code: `packages/model-catalog/src/cost.ts`, `tokens.ts` and `packages/shared/src/money.ts` · card 6.2

## Money without floats

- All dollar amounts are strings with at most 8 decimal digits (`UsdAmount`, matching `Decimal(18,8)` in Postgres).
- Calculation is done with BigInt: 1 dollar = 10^8 units. `parseUsd`, `formatUsd` and `sumUsd` are in `@dirouter/shared`.
- `costForTokens(tokens, pricePerMTok)` = `tokens × price / 1,000,000`, rounded half-up at the eighth decimal digit.
- Test "one million small requests": the sum is exactly the product, and no floating-point error accumulates.

## Formula

Canonical usage (`inputTokens` counts all input including cache; `reasoningTokens` is a subset of `outputTokens`):

| part           | tokens                                 | price                                |
| -------------- | -------------------------------------- | ------------------------------------ |
| regular input  | `inputTokens − cacheRead − cacheWrite` | `inputPerMTok`                       |
| cache read     | `cacheReadTokens`                      | `cacheReadPerMTok`, otherwise input  |
| cache write    | `cacheWriteTokens`                     | `cacheWritePerMTok`, otherwise input |
| regular output | `outputTokens − reasoningTokens`       | `outputPerMTok`                      |
| reasoning      | `reasoningTokens`                      | `reasoningPerMTok`, otherwise output |

`computeCost` returns the per-part breakdown and `computeCostUsd` returns the total, both as strings. The cost of a failed request is zero.

Prices come from each model's `ModelPricing` in the snapshot. Defaults are in `packages/model-catalog/src/catalog.json`. ⚠️ Catalog prices have not yet been checked against each provider's official pricing page (card 3.8).

## Estimation when the provider does not return usage

Some OpenAI-compatible providers send no `usage` in the response or the stream. In this case:

1. The translator leaves the response `usage` empty (`CanonicalResponse.usage` is optional). Setting it to zero is deliberately avoided, so it cannot be confused with "really zero".
2. The gateway estimates usage with a tokenizer (`js-tiktoken`, `o200k_base`):
   - **Input**: `estimateRequestTokens` includes the system prompt, messages (with 4 tokens of overhead per message), images (85 tokens) and tool definitions.
   - **Output**: in non-stream, from the response content (`estimateOutputTokens`); in stream, from the accumulated text of `text_delta`, `reasoning_delta`, the tool name and `arguments`.
3. The same number is returned to the client: in the response's `usage`, and in the stream before `[DONE]` or `message_delta`. So the bill and the client's response are the same.
4. The usage event gets `usageEstimated: true` so it can be distinguished in reports.

For non-OpenAI models, o200k is approximate. The context-window filter in the router uses `roughTokens` (no tokenizer, about 4 Latin characters or about 2 non-Latin characters per token), because it is on the hot path.

## Check in compose (2026-11-07)

| dev model      | mode               | input | output | cost       | estimated |
| -------------- | ------------------ | ----- | ------ | ---------- | --------- |
| `mock/nousage` | json               | 12    | 8      | 0.00000280 | true      |
| `mock/nousage` | stream             | 12    | 8      | 0.00000280 | true      |
| `mock/small`   | json               | 8     | 10     | 0.00000280 | false     |
| `mock/tool`    | anthropic → openai | 10    | 12     | 0.00000340 | false     |

Dev model prices: input 0.10 and output 0.20 dollars per million tokens. For example, 10×0.10 + 12×0.20 = 3.4 dollars per million, i.e. 0.0000034 ✓.
