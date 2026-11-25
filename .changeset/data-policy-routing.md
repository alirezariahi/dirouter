---
'@dirouter/contracts': minor
'@dirouter/routing': minor
'@dirouter/gateway': minor
'@dirouter/control-api': minor
'@dirouter/dashboard': minor
'@dirouter/db': minor
'@dirouter/worker': minor
---

Routing by data policy and region: providers carry a `dataPolicy` (region, country, zero data
retention, training use), and routing policies of the organization, project or key can require
ZDR, no training, or allowed regions and countries. The scopes and the request's own
`provider.zdr`, `data_collection`, `regions` and `countries` combine to the strictest policy, so a
client can tighten it but never weaken it. Non-compliant providers are removed before fallback and
hedging, for chat and every metered call; when none is left the request fails with 400
`no_provider_matches_data_policy`. The simulator shows the effective policy, and each request log
entry keeps the routing decision (`route_decision`), shown in the log details.
