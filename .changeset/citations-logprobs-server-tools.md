---
'@dirouter/translator': minor
'@dirouter/providers': minor
'@dirouter/contracts': minor
'@dirouter/gateway': minor
'@dirouter/mock-provider': minor
---

Citations, log probabilities and server-side tools survive translation (card 31.7). Web sources cited by Anthropic (`citations`, also streamed as `citations_delta`), OpenAI search models (`annotations`) and Gemini (`groundingMetadata`, byte offsets) reach every client format with correct offsets, and Anthropic document citations reach Anthropic clients. Token log probabilities are requested from and returned by OpenAI and Gemini in every client format (Anthropic and Bedrock have none: dropped or refused by `drop_params`). Web search, code execution and URL fetching map between Anthropic, OpenAI, Responses and Gemini; a server tool the destination cannot run is refused with a clear 400 instead of being dropped. The mock provider cites a source with the `citations` directive.
