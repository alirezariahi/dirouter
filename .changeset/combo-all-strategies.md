---
'@dirouter/dashboard': minor
'@dirouter/gateway': minor
---

The combo editor offers all seven routing strategies the gateway implements (priority, weighted,
round-robin, latency, cost, least-used and headroom), each with a short explanation, and shows
strategy-specific fields only when they apply. A saved combo can be simulated in the gateway from
the editor, and the routing simulator shows the strategy and, per candidate, the live signal it
sorted on (latency, estimated cost, recent requests or remaining context).
