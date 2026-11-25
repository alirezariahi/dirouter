---
'@dirouter/contracts': minor
'@dirouter/db': minor
'@dirouter/routing': minor
'@dirouter/gateway': minor
'@dirouter/control-api': minor
'@dirouter/worker': minor
'@dirouter/dashboard': minor
---

Budgets of upstream providers and credentials, quota windows, and fill-first and reset-aware
credential order. `PUT /orgs/{org}/providers/{id}/spend` sets a provider's daily, weekly, monthly or
yearly budgets and its `credentialStrategy`; `.../credentials/{credentialId}/spend` sets a
credential's budgets and its quota windows (requests, tokens or dollars per N hours from the first
request, for coding plans used with an API key). A used-up budget or window takes its candidates
out of the route, so traffic moves to the next credential without an error. The ledger keeps the
serving credential and the worker reconciles both scopes. The Health page counts down to the reset
of each quota window; the Providers page edits all of it. Consumer OAuth subscriptions are not
supported.
