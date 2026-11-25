---
'@dirouter/contracts': minor
'@dirouter/routing': minor
'@dirouter/gateway': minor
'@dirouter/translator': minor
'@dirouter/model-catalog': minor
'@dirouter/control-api': minor
'@dirouter/dashboard': minor
'@dirouter/db': minor
'@dirouter/worker': minor
'@dirouter/mock-provider': minor
---

Model suffixes as on OpenRouter: `:nitro` (fastest first), `:floor` (cheapest first), `:free`
(free targets only), `:thinking` and `:minimal`/`:low`/`:medium`/`:high` (reasoning effort), and
`:online`, which calls a web search extension point and fails with a clear 400
`web_search_unavailable` until web search (card 30.8) is plugged in. `service_tier` (flex,
priority) reaches OpenAI-style providers and is priced from the model's new tier prices, which
the catalog provides for OpenAI models and catalog sync reads from LiteLLM; the tier is kept with
the usage event, the ledger cost and the request log. The simulator shows suffixes and their
effect.
