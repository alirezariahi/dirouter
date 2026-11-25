---
'@dirouter/routing': minor
'@dirouter/contracts': minor
'@dirouter/gateway': minor
'@dirouter/control-api': minor
'@dirouter/dashboard': minor
'@dirouter/worker': minor
'@dirouter/db': minor
---

Conditional routing rules: an organization can route, reject or tag requests with conditions in a
safe CEL subset over headers, metadata, the key, team and project, the token estimate and the share
of a key, project or team budget already spent (`budget.team > 80` → a cheap model). Rules run in
priority order before automatic routing and candidate selection, may be limited to one team or
project, are validated when saved (`POST /orgs/:orgId/routing/rules/validate`), work in the routing
simulator, and record what they did in the usage event and the request log's new `policy` column;
`GET /orgs/:orgId/routing/rules/traffic` reports each rule's share of traffic. The dashboard gets a
Routing policies page.
