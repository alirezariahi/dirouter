---
'@dirouter/contracts': minor
'@dirouter/db': minor
'@dirouter/gateway': minor
'@dirouter/control-api': minor
'@dirouter/worker': minor
'@dirouter/dashboard': minor
---

Limits and budgets for the whole organization, for all keys of one member, and for one model or
provider, next to keys, teams and projects; budgets can also be weekly (from Monday 00:00 UTC) or
yearly. `PUT /orgs/:org/limits/:scope/:scopeId` takes `organization`, `user`, `model` and
`provider`, refuses ids outside the organization, and `GET limits/usage` reports spend per day,
week, month and year. An exhausted organization or member budget stops the covered keys with
`429 budget_exceeded`; an exhausted model or provider budget takes that target out of the route so a
combo falls back, and only a route with nothing left is refused. Every budget of a request is still
read in one pipelined round trip and every rate limit applied by one Lua script, with the
organization in every shared counter name. The ledger records the model and provider of each request
so the worker can reconcile the new budgets. The organization page edits all of these scopes and the
key form offers weekly and yearly budgets.
