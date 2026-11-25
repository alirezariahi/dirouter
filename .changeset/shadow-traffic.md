---
'@dirouter/contracts': minor
'@dirouter/gateway': minor
'@dirouter/worker': minor
'@dirouter/control-api': minor
'@dirouter/dashboard': minor
'@dirouter/db': minor
---

Shadow traffic: `/orgs/:orgId/routing/shadows` mirrors a sample of an organization's requests to
one of its own models after the client has its answer, with its own timeout and no effect on the
client's response, latency, limits, budgets or wallet. The copy's cost is stored apart in
`shadow_requests` (never in the request log, the ledger or a wallet, and never charged to the
customer), each policy stops for the day at its own cost cap, and a report compares errors, latency
and cost of the shadow and the primary answers. The Routing policies page gets a Shadow traffic tab.
