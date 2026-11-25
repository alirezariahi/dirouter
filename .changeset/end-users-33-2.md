---
'@dirouter/contracts': minor
'@dirouter/db': minor
'@dirouter/gateway': minor
'@dirouter/control-api': minor
'@dirouter/worker': minor
'@dirouter/dashboard': minor
---

End users: the users of a product built on DiRouter, named by the `x-dirouter-end-user` header or
the request's `user` field. The limits API takes `end_user` scopes: `*` sets the rate limit and
budgets every end user gets on counters of its own, an end user's id sets its own. An end user with
a used-up budget gets `429 budget_exceeded` while everyone else keeps working, and a blocked end
user gets the new `403 end_user_blocked`. `GET/PUT /orgs/:org/end-users` lists end users with this
month's usage, shows one with its last 30 days and blocks or unblocks it; `GET stats/dimensions`
and the `byEndUser` part of `stats/analytics` report usage per end user from new dimension
rollups that keep at most 1000 values per organization and hour. The worker records end users on
first sight and keeps the end user on the ledger for reconcile. The dashboard has an End users page
and shows usage by end user on Analytics, with CSV export.
