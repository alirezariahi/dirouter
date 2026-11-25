---
'@dirouter/contracts': minor
'@dirouter/routing': minor
'@dirouter/gateway': minor
'@dirouter/control-api': minor
'@dirouter/dashboard': minor
'@dirouter/db': minor
---

Requests can carry OpenRouter's `provider` object (`order`, `only`, `ignore`, `allow_fallbacks`,
`sort` by price, throughput or latency, `max_price`) and a `models` fallback array; neither is
sent upstream, and preferences that leave no provider fail with a clear 400
`no_provider_matches_preferences`. The gateway measures each model's live generation speed for
`sort: throughput`. Administrators set default preferences per organization, project or key under
`/routing-policies` and can lock them so a key's client cannot override them. The routing
simulator takes the same fields and shows their effect.
