---
'@dirouter/routing': minor
'@dirouter/contracts': minor
'@dirouter/gateway': minor
'@dirouter/control-api': minor
'@dirouter/dashboard': minor
'@dirouter/db': minor
---

Canary and percentage traffic splits: `/orgs/:orgId/routing/splits` sends a share of the requests
for a name to a canary target, sticky per key, per session or per request. Every change is a new
version; rollback to stable or to any earlier version is instant. The gateway rolls a canary back
by itself when its error rate crosses a threshold, shares that with the other replicas through
Valkey, and control-api records it as a new version. A report compares latency, errors and cost of
the two branches, and the Routing policies page manages it all.
