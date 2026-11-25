---
'@dirouter/contracts': minor
'@dirouter/db': minor
'@dirouter/gateway': minor
'@dirouter/control-api': minor
'@dirouter/dashboard': minor
'@dirouter/mock-provider': minor
'@dirouter/routing': patch
---

Native provider pass-through: `/passthrough/{provider}/*` forwards endpoints DiRouter does not translate (batches, files, legacy completions) to the provider unchanged, behind the virtual key, rate limits, budgets, the concurrency cap and request guardrails. The credential's own authentication is injected and the client's DiRouter key never reaches the provider. Each request is logged with inbound API `passthrough` and priced when the answer reports usage for a configured model. Off by default: a provider needs a path allow-list (`options.passthroughPaths`) and a key needs a separate grant (`passthroughProviders`, owners and admins only) (card 30.7).
