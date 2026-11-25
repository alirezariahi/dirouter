---
'@dirouter/contracts': minor
'@dirouter/routing': minor
'@dirouter/gateway': minor
'@dirouter/control-api': minor
'@dirouter/dashboard': minor
---

Routing explanation: keys whose routing policy has `explain: true` can send
`x-dirouter-explain: 1` and get the routing decision back in the `x-dirouter-routing` header
(candidates in attempt order with estimated cost, removed targets and reasons, matched rule,
preferences, data policy, suffixes and the upstream attempts; streams too). It is built by the
same function as the simulator's new `explanation` field, so both agree; without the permission
nothing internal is returned. The same decision is stored with every request log entry and shown
in the log details.
