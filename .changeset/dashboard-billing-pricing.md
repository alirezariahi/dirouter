---
'@dirouter/dashboard': minor
'@dirouter/control-api': minor
---

Dashboard billing, part two: set each platform model's sale multiplier, fixed price and cache
share and publish it in the marketplace (a saved price applies to the next request), manage
customer groups and assign customers to them, define and hide plans and see every subscription,
list invoices by month with PDF download, ledger verification and the monthly run, and read the
profit report for a range, a customer and a model with a CSV export whose figures are the
endpoint's own. The API gains `GET billing/subscriptions`, optional `organizationId` and `model`
filters on `GET billing/reports/profit` (with a `filters` echo; ledger figures stay platform-wide),
and `customerGroupId` in `GET billing/wallets`.
