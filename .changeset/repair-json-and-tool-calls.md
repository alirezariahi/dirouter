---
'@dirouter/translator': minor
'@dirouter/contracts': minor
'@dirouter/gateway': minor
'@dirouter/control-api': minor
'@dirouter/dashboard': minor
'@dirouter/db': minor
'@dirouter/mock-provider': minor
---

The gateway can repair what weaker models and agent clients break (card 31.1). With `json`, a non-streamed answer to a `response_format` request whose text is not valid JSON (code fences, prose, trailing commas, single quotes, bare keys, Python literals, a truncated tail) is repaired conservatively; valid JSON is never touched. With `tools`, the replayed history is fixed before it reaches the provider (a repeated call kept once, a missing result added as an error result, a late result moved next to its call, a result without its call turned into user text, broken arguments repaired), so it passes without a 400. A key enables it (`repair`, also on the Keys page) and the `x-dirouter-repair` header overrides it per request; every repair is counted in `dirouter_gateway_repairs_total`. The mock provider rejects unpaired tool histories like the real providers and takes any answer text with `text_b64`.
