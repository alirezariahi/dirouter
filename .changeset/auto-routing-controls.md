---
'@dirouter/routing': minor
'@dirouter/contracts': minor
'@dirouter/gateway': minor
'@dirouter/control-api': minor
'@dirouter/dashboard': minor
'@dirouter/db': minor
---

Controls of automatic routing: `/orgs/:orgId/routing/auto` sets a cost tier (low, medium, high by
blended price per million tokens), allowed and denied models with `*` patterns and the reasoning
effort for an organization, and `/routing/auto/keys/:keyId` for a key; an administrator's lock lets
keys only narrow the organization's policy. The gateway holds both the names `auto*` chooses between
and the resolved candidates to the policy, so with the low tier no request reaches an expensive model
and a model outside the allowed set is never selected; `auto` picks a reasoning effort and records the
tier, the effort and the reasons with the request. The Routing policies page gets an Auto controls tab.
