---
'@dirouter/contracts': minor
'@dirouter/db': minor
'@dirouter/gateway': minor
'@dirouter/control-api': minor
'@dirouter/worker': minor
'@dirouter/dashboard': minor
---

Tags and cost centers. A key can carry default `tags` and a `costCenter`; a request adds tags with
`x-dirouter-tags` (at most 10 in all) and names its cost center with `x-dirouter-cost-center`.
Both are stored on the request log, the ledger and the usage event, rolled up per tag and cost
center (at most 1000 values per organization and hour, the rest as `__other__`), and reported by
`stats/dimensions` and `byTag`/`byCostCenter` in `stats/analytics`, including one tag grouped by
model. The limits API takes `tag` and `cost_center` scopes, so a tag's budget stops exactly the
requests carrying it. Analytics switches between end users, tags and cost centers with a filter and
CSV export; the key form and the organization page edit tags, cost centers and their limits.
